import type { AgentActivityEntry, JsonValue } from '../types/index.js';

type Counts = { added: number; deleted: number; files: number };
type Evidence = { counts?: Counts; reason?: string };
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
function object(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value) as JsonValue);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}
function physicalLines(text: string): number {
  return text === ''
    ? 0
    : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}
/** 每个操作共用一百万个 LCS 单元预算；相同首尾先线性裁剪。 */
function changedLines(
  lines: string[],
  budget: { remaining: number },
): Evidence {
  const before = lines
    .filter((line) => line[0] !== '+')
    .map((line) => line.slice(1));
  const after = lines
    .filter((line) => line[0] !== '-')
    .map((line) => line.slice(1));
  let start = 0;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    start < beforeEnd &&
    start < afterEnd &&
    before[start] === after[start]
  )
    start++;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }
  const beforeLength = beforeEnd - start;
  const afterLength = afterEnd - start;
  const cells = beforeLength * afterLength;
  if (cells > budget.remaining) return { reason: 'diff_budget_exceeded' };
  budget.remaining -= cells;
  let common = 0;
  if (cells > 0) {
    // 将行内容映射为整数，避免在二次循环中反复比较长字符串。
    const lineIds = new Map<string, number>();
    const idFor = (line: string): number => {
      let id = lineIds.get(line);
      if (id === undefined) {
        id = lineIds.size;
        lineIds.set(line, id);
      }
      return id;
    };
    const beforeIds = before.slice(start, beforeEnd).map(idFor);
    const afterIds = after.slice(start, afterEnd).map(idFor);
    const row = new Uint32Array(afterLength + 1);
    for (const beforeId of beforeIds) {
      let diagonal = 0;
      for (let column = 1; column <= afterLength; column++) {
        const previous = row[column];
        row[column] =
          beforeId === afterIds[column - 1]
            ? diagonal + 1
            : Math.max(row[column], row[column - 1]);
        diagonal = previous;
      }
    }
    common = row[afterLength];
  }
  const added = afterLength - common;
  const deleted = beforeLength - common;
  return { counts: { added, deleted, files: added + deleted > 0 ? 1 : 0 } };
}
function patchCounts(text: string): Evidence {
  if (Buffer.byteLength(text) > MAX_PATCH_BYTES)
    return { reason: 'evidence_too_large' };
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const invalid = { reason: 'invalid_patch' };
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch')
    return invalid;
  const counts: Counts = { added: 0, deleted: 0, files: 0 };
  const budget = { remaining: 1_000_000 };
  const paths = new Set<string>();
  let index = 0;
  while (index < lines.length) {
    const header = lines[index++].match(
      /^\*\*\* (Add|Update|Delete) File: (.+)$/,
    );
    if (!header || paths.has(header[2])) return invalid;
    paths.add(header[2]);
    if (header[1] === 'Delete') return { reason: 'missing_original_content' };
    const body: string[] = [];
    while (
      index < lines.length &&
      !/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[index])
    )
      body.push(lines[index++]);
    // Add File 同样允许覆盖已有文件；成功输出无法证明历史文件不存在。
    if (header[1] === 'Add') return { reason: 'missing_original_content' };
    // Move to 可能覆盖目标文件，缺少目标原文时无法完整计量。
    if (body[0]?.startsWith('*** Move to: '))
      return { reason: 'missing_original_content' };
    let hunk: string[] = [];
    let hasHunk = false;
    let changed = false;
    const finishHunk = (): Evidence => {
      const evidence = changedLines(hunk, budget);
      if (!evidence.counts) return evidence;
      const delta = evidence.counts;
      counts.added += delta.added;
      counts.deleted += delta.deleted;
      changed ||= delta.files > 0;
      hunk = [];
      return evidence;
    };
    for (const line of body) {
      if (line === '@@' || line.startsWith('@@ ')) {
        const evidence = finishHunk();
        if (!evidence.counts) return evidence;
        hasHunk = true;
      } else if (line === '*** End of File' && hasHunk) continue;
      else if (hasHunk && /^[ +\-]/.test(line)) hunk.push(line);
      else return invalid;
    }
    if (!hasHunk) return invalid;
    const evidence = finishHunk();
    if (!evidence.counts) return evidence;
    if (changed) counts.files++;
  }
  return paths.size ? { counts } : invalid;
}
function callEvidence(args: JsonValue | undefined): Evidence {
  if (typeof args === 'string' && Buffer.byteLength(args) > MAX_PATCH_BYTES)
    return { reason: 'evidence_too_large' };
  const value = object(args);
  const patch = value?.command ?? value?.patch ?? value?.input ?? args;
  return typeof patch === 'string'
    ? patchCounts(patch)
    : { reason: 'missing_patch' };
}
function nativeEvidence(
  result: Record<string, JsonValue> | undefined,
): Evidence {
  if (result?.type === 'create' && typeof result.content === 'string') {
    if (Buffer.byteLength(result.content) > MAX_PATCH_BYTES)
      return { reason: 'evidence_too_large' };
    return {
      counts: { added: physicalLines(result.content), deleted: 0, files: 1 },
    };
  }
  if (!Array.isArray(result?.structuredPatch))
    return { reason: 'missing_original_content' };
  const counts = { added: 0, deleted: 0, files: 0 };
  const budget = { remaining: 1_000_000 };
  let evidenceBytes = 0;
  for (const hunk of result.structuredPatch) {
    const lines = object(hunk)?.lines;
    if (
      !Array.isArray(lines) ||
      lines.some((line) => typeof line !== 'string' || !/^[ +\-\\]/.test(line))
    )
      return { reason: 'invalid_patch' };
    for (const line of lines as string[])
      evidenceBytes += Buffer.byteLength(line);
    if (evidenceBytes > MAX_PATCH_BYTES)
      return { reason: 'evidence_too_large' };
    const evidence = changedLines(
      (lines as string[]).filter((line) => !line.startsWith('\\')),
      budget,
    );
    if (!evidence.counts) return evidence;
    const delta = evidence.counts;
    counts.added += delta.added;
    counts.deleted += delta.deleted;
    counts.files = Math.max(counts.files, delta.files);
  }
  return { counts };
}

/** 只缓存有界数字证据，结果重放可复用调用；不保留源码或读取工作区文件。 */
export class CodeChangeProcessor {
  private readonly calls = new Map<
    string,
    { name: string; evidence: Evidence }
  >();
  constructor(private readonly maxPendingCalls = 4096) {}

  enrich(entries: AgentActivityEntry[]): void {
    for (const entry of entries) {
      const event = entry['event.name'].replace(/^gen_ai\./, '');
      const id = entry['gen_ai.tool.call.id'];
      const identity = [
        entry['gen_ai.agent.type'],
        entry['gen_ai.session.id'],
        id,
      ];
      const key =
        id &&
        identity.every(
          (value) =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 2048,
        )
          ? JSON.stringify(identity)
          : undefined;
      if (event === 'tool.call') {
        const name = this.toolName(entry['gen_ai.tool.name']);
        if (key && name.length <= 256) {
          this.calls.delete(key);
          this.calls.set(key, {
            name,
            evidence:
              name === 'apply_patch'
                ? callEvidence(entry['gen_ai.tool.call.arguments'])
                : { reason: 'unsupported_tool' },
          });
          while (this.calls.size > Math.max(0, this.maxPendingCalls))
            this.calls.delete(this.calls.keys().next().value!);
        }
        continue;
      }
      if (event !== 'tool.result') continue;
      const call = key ? this.calls.get(key) : undefined;
      const name = this.toolName(entry['gen_ai.tool.name'] ?? call?.name);
      const payload = entry['gen_ai.tool.call.result'];
      const result = object(payload);
      const text =
        typeof result?.output === 'string'
          ? result.output
          : typeof payload === 'string'
            ? payload
            : '';
      delete entry['gen_ai.code.lines_added'];
      delete entry['gen_ai.code.lines_deleted'];
      delete entry['gen_ai.code.files_changed'];
      delete entry['gen_ai.code.change_reason'];
      if (
        /^(read|read_file|readfile|glob|grep|search|list_directory|ls|web_search|tool_search)$/.test(
          name,
        )
      ) {
        this.status(entry, 'not_applicable');
        continue;
      }
      const exitCode = result?.exit_code ?? object(result?.metadata)?.exit_code;
      const failed =
        /^(failure|failed|error|cancelled|canceled)$/.test(
          entry['tool.result.status'] ?? '',
        ) ||
        !!entry['error.type'] ||
        result?.is_error === true ||
        result?.success === false ||
        (typeof exitCode === 'number' && exitCode !== 0) ||
        (name === 'apply_patch' &&
          /(?:^|\n)(?:Error:|apply_patch verification failed|Failed to)/i.test(
            text,
          ));
      if (failed) {
        this.status(entry, 'failed', 'tool_failed');
        continue;
      }
      let evidence: Evidence = {
        reason: call ? 'unsupported_tool' : 'missing_call',
      };
      if (name === 'apply_patch') {
        evidence = /^Success\. Updated the following files:\r?\n/m.test(text)
          ? (call?.evidence ?? { reason: 'missing_call' })
          : { reason: 'missing_success_evidence' };
      } else if (
        name === 'edit' ||
        name === 'write' ||
        (typeof result?.filePath === 'string' &&
          result?.structuredPatch !== undefined)
      ) {
        const success =
          entry['tool.result.status'] === 'success' || result?.success === true;
        evidence = success
          ? nativeEvidence(result)
          : { reason: 'missing_success_evidence' };
      }
      if (evidence.counts) {
        this.status(entry, 'measured');
        entry['gen_ai.code.lines_added'] = evidence.counts.added;
        entry['gen_ai.code.lines_deleted'] = evidence.counts.deleted;
        entry['gen_ai.code.files_changed'] = evidence.counts.files;
      } else this.status(entry, 'unmeasured', evidence.reason);
    }
  }
  private toolName(name: string | undefined): string {
    return (name ?? '').split('.').pop()!.toLowerCase();
  }
  private status(
    entry: AgentActivityEntry,
    status: string,
    reason?: string,
  ): void {
    entry['gen_ai.code.change_status'] = status;
    if (reason) entry['gen_ai.code.change_reason'] = reason;
  }
}
