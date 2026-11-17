import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile, writeJsonFile, ensureDir } from '../utils/fs-utils.js';
import { LOCAL_LOG_EMERGENCY_FILE_BYTES } from '../utils/segmented-jsonl-writer.js';
import { scanJsonlTail } from './jsonl-tail-reader.js';

export interface CodeChangeSummaryEntry {
  agentType: string;
  addedLines: number;
  deletedLines: number;
  filesChanged: number;
  measuredOperations: number;
  unmeasuredOperations: number;
  failedOperations: number;
}

export interface CodeChangeHistory {
  startDate: string;
  endDate: string;
  days: Array<{ day: string; codeChanges: CodeChangeSummaryEntry[] }>;
}

type CodeChangeQuery = ((start: string) => CodeChangeSummaryEntry[]) & { history: CodeChangeHistory };

interface Observation {
  day: string;
  agentType: string;
  status: 'measured' | 'unmeasured' | 'failed';
  added: number;
  deleted: number;
  files: number;
}

interface FileCursor { day: string; offset: number; size: number; anchor: string }
interface CodeState {
  version: 1;
  files: Record<string, FileCursor>;
  observations: Record<string, Observation>;
}

/** 游标与已观察结果在同一个原子文件提交，重放和缓存升级都保持幂等。 */
export async function refreshCodeChanges(
  cachePath: string, files: string[], today: string,
): Promise<CodeChangeQuery> {
  const loaded = await readJsonFile<CodeState>(cachePath);
  const state: CodeState = loaded?.version === 1 && loaded.files && loaded.observations
    ? loaded : { version: 1, files: {}, observations: {} };
  const cutoffDate = new Date(today + 'T00:00:00');
  cutoffDate.setDate(cutoffDate.getDate() - 200);
  const cutoff = [cutoffDate.getFullYear(), String(cutoffDate.getMonth() + 1).padStart(2, '0'), String(cutoffDate.getDate()).padStart(2, '0')].join('-');
  // 首次回填时先处理早期文件，使跨日副本归属首次观察到的日期。
  const datedFiles = files.map(file => ({ file, day: /-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)?.[1] }))
    .filter((item): item is { file: string; day: string } => !!item.day && item.day >= cutoff && item.day <= today)
    .sort((a, b) => a.day.localeCompare(b.day) || a.file.localeCompare(b.file));
  for (const { file, day } of datedFiles) {
    let stat;
    try { stat = await fs.stat(file); } catch { continue; }
    if (stat.size > LOCAL_LOG_EMERGENCY_FILE_BYTES) continue;
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const previous = state.files[identity];
    let start = previous && previous.size <= stat.size ? previous.offset : 0;
    if (start && await readAnchor(file, start) !== previous.anchor) start = 0;
    const result = await scanJsonlTail(file, start, stat.size, {
      expectedFileIdentity: stat,
      onRecord: record => {
        const observation = parseObservation(record, day);
        if (!observation) return;
        const sessionId = record['gen_ai.session.id'];
        const callId = sessionId ? record['gen_ai.tool.call.id'] ?? record['tool.call.id'] : undefined;
        const eventId = record['event.id'];
        if (!callId && !eventId) return;
        const key = createHash('sha256').update(JSON.stringify([
          observation.agentType, sessionId ?? '', callId ? 'call' : 'event', callId || eventId,
        ])).digest('hex');
        const previous = state.observations[key];
        if (!previous || (previous.status === 'unmeasured' && observation.status === 'measured')
          || (previous.status !== 'failed' && observation.status === 'failed')) {
          state.observations[key] = { ...observation, day: previous?.day ?? day };
        }
      },
    });
    state.files[identity] = { day, offset: result.nextOffset, size: stat.size, anchor: await readAnchor(file, result.nextOffset) };
  }
  for (const [key, value] of Object.entries(state.observations)) {
    if (value.day < cutoff) delete state.observations[key];
  }
  for (const [key, value] of Object.entries(state.files)) {
    if (value.day < cutoff) delete state.files[key];
  }
  await ensureDir(path.dirname(cachePath));
  await writeJsonFile(cachePath, state);
  const byDay = new Map<string, Map<string, CodeChangeSummaryEntry>>();
  for (const observation of Object.values(state.observations)) {
    if (observation.day < cutoff || observation.day > today) continue;
    const agents = byDay.get(observation.day) ?? new Map<string, CodeChangeSummaryEntry>();
    byDay.set(observation.day, agents);
    const entry = agents.get(observation.agentType) ?? {
      agentType: observation.agentType, addedLines: 0, deletedLines: 0, filesChanged: 0,
      measuredOperations: 0, unmeasuredOperations: 0, failedOperations: 0,
    };
    entry.addedLines += observation.added;
    entry.deletedLines += observation.deleted;
    entry.filesChanged += observation.files;
    if (observation.status === 'measured') entry.measuredOperations++;
    if (observation.status === 'unmeasured') entry.unmeasuredOperations++;
    if (observation.status === 'failed') entry.failedOperations++;
    agents.set(entry.agentType, entry);
  }
  // 只发布按日数字汇总，不向看板暴露缓存中的调用身份或原始事件。
  const history: CodeChangeHistory = {
    startDate: cutoff, endDate: today,
    days: Array.from(byDay, ([day, agents]) => ({ day,
      codeChanges: Array.from(agents.values()).sort((a, b) => a.agentType.localeCompare(b.agentType)),
    })).sort((a, b) => a.day.localeCompare(b.day)),
  };
  return Object.assign((start: string) => {
    const agents = new Map<string, CodeChangeSummaryEntry>();
    for (const day of history.days) {
      if (day.day < start) continue;
      for (const entry of day.codeChanges) {
        const total = agents.get(entry.agentType);
        if (!total) agents.set(entry.agentType, { ...entry });
        else {
          total.addedLines += entry.addedLines;
          total.deletedLines += entry.deletedLines;
          total.filesChanged += entry.filesChanged;
          total.measuredOperations += entry.measuredOperations;
          total.unmeasuredOperations += entry.unmeasuredOperations;
          total.failedOperations += entry.failedOperations;
        }
      }
    }
    return Array.from(agents.values()).sort((a, b) => a.agentType.localeCompare(b.agentType));
  }, { history });
}

async function readAnchor(file: string, offset: number): Promise<string> {
  if (!offset) return '';
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(64, offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - buffer.length);
    return buffer.subarray(0, bytesRead).toString('base64');
  } finally { await handle.close(); }
}

function parseObservation(record: Record<string, unknown>, day: string): Observation | null {
  if (record['event.name'] !== 'tool.result' && record['event.name'] !== 'gen_ai.tool.result') return null;
  let status = record['gen_ai.code.change_status'];
  if (status === 'not_applicable') return null;
  if (status === undefined) {
    const tool = String(record['gen_ai.tool.name'] ?? record['tool.name'] ?? '');
    if (!/(?:^|[._/])(apply_patch|edit|write|write_file|writefile|edit_file|editfile|multiedit|str_replace_editor|exec|exec_command|execute|execute_command|shell|shell_command|bash|powershell|run_command|run_shell_command|run_terminal_cmd|terminal)(?:$|[._/])/i.test(tool)) return null;
    status = 'unmeasured';
  }
  if (/^(failure|failed|error|cancelled|canceled)$/i.test(String(record['tool.result.status'] ?? '')) || record['error.type']) status = 'failed';
  if (status !== 'measured' && status !== 'unmeasured' && status !== 'failed') return null;
  const added = nonnegativeInteger(record['gen_ai.code.lines_added']);
  const deleted = nonnegativeInteger(record['gen_ai.code.lines_deleted']);
  const files = nonnegativeInteger(record['gen_ai.code.files_changed']);
  const validStatus = status === 'measured' && (added === null || deleted === null || files === null)
    ? 'unmeasured' : status;
  return { day, agentType: String(record['gen_ai.agent.type'] ?? 'unknown'), status: validStatus,
    added: validStatus === 'measured' ? added! : 0,
    deleted: validStatus === 'measured' ? deleted! : 0,
    files: validStatus === 'measured' ? files! : 0 };
}

function nonnegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
