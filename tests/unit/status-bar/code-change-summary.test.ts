import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { MetricsSummaryWriter } from '../../../src/status-bar/metrics-summary-writer.js';
import { scanJsonlTail } from '../../../src/status-bar/jsonl-tail-reader.js';
import * as fsUtils from '../../../src/utils/fs-utils.js';

vi.mock('../../../src/status-bar/jsonl-tail-reader.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/status-bar/jsonl-tail-reader.js')>();
  return { ...actual, scanJsonlTail: vi.fn(actual.scanJsonlTail) };
});

describe('代码修改摘要', () => {
  let dir: string;
  const config = { enabled: true, metricsSummaryIntervalMs: 60_000, runtimeRefreshIntervalMs: 30_000 };
  const today = '2026-11-16';
  const record = (id: string, overrides = {}) => ({
    'event.name': 'tool.result', 'event.id': id,
    'gen_ai.agent.type': 'custom-agent', 'gen_ai.session.id': 'session',
    'gen_ai.tool.call.id': id, 'gen_ai.code.change_status': 'measured',
    'gen_ai.code.lines_added': '8', 'gen_ai.code.lines_deleted': 3,
    'gen_ai.code.files_changed': 1, ...overrides,
  });
  const append = async (day: string, records: unknown[], prefix = 'agent') => {
    await fs.appendFile(path.join(dir, 'logs/output', `${prefix}-${day}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  };
  const refresh = async () => {
    await new MetricsSummaryWriter(dir, config).refresh();
    return JSON.parse(await fs.readFile(path.join(dir, 'logs/metrics-summary.json'), 'utf8'));
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(today + 'T12:00:00'));
    dir = await createTempDir('code-summary-');
    await fs.mkdir(path.join(dir, 'logs/output'), { recursive: true });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await cleanupTempDir(dir); });

  it('按任意 Agent 统计结果、失败和未测量，拒绝非法整数和读取事件', async () => {
    await append(today, [record('ok'), record('failed', { 'gen_ai.code.change_status': 'failed' }),
      record('unknown', { 'gen_ai.code.change_status': 'unmeasured' }),
      record('invalid', { 'gen_ai.code.lines_added': -1 }),
      record('call', { 'event.name': 'tool.call' }),
      record('read', { 'gen_ai.code.change_status': 'not_applicable' }),
      { 'event.name': 'tool.result', 'event.id': 'legacy', 'gen_ai.agent.type': 'old', 'gen_ai.tool.name': 'exec_command' },
      { 'event.name': 'tool.result', 'event.id': 'read-old', 'gen_ai.tool.name': 'Read' }]);
    const summary = await refresh();
    expect(summary.ranges.today.codeChanges).toEqual([
      { agentType: 'custom-agent', addedLines: 8, deletedLines: 3, filesChanged: 1, measuredOperations: 1, unmeasuredOperations: 2, failedOperations: 1 },
      { agentType: 'old', addedLines: 0, deletedLines: 0, filesChanged: 0, measuredOperations: 0, unmeasuredOperations: 1, failedOperations: 0 },
    ]);
  });

  it('跨文件、跨日、增量、重启及截断重放保持幂等并隔离会话', async () => {
    await append('2026-11-15', [record('duplicate')]);
    await append(today, [record('duplicate'), record('other-session', { 'gen_ai.tool.call.id': 'duplicate', 'gen_ai.session.id': 'other' })]);
    let summary = await refresh();
    expect(summary.ranges.today.codeChanges[0].measuredOperations).toBe(1);
    expect(summary.ranges.sevenDays.codeChanges[0].measuredOperations).toBe(2);
    await append(today, [record('duplicate')], 'copy');
    summary = await refresh();
    expect(summary.ranges.thirtyDays.codeChanges[0].measuredOperations).toBe(2);
    await fs.writeFile(path.join(dir, 'logs/output', `agent-${today}.jsonl`), JSON.stringify(record('duplicate')) + '\n');
    summary = await refresh();
    expect(summary.ranges.thirtyDays.codeChanges[0].measuredOperations).toBe(2);
  });

  it('旧 Token 缓存存在时仍回填历史代码数据，缺 call id 按 event id 去重', async () => {
    await refresh();
    const fallback = record('fallback', { 'gen_ai.tool.call.id': undefined });
    await append('2026-11-14', [fallback, fallback]);
    const summary = await refresh();
    expect(summary.ranges.today.codeChanges).toEqual([]);
    expect(summary.ranges.sevenDays.codeChanges[0].measuredOperations).toBe(1);
  });

  it('重启后仅扫描追加字节，轮转后复用 inode 游标，跨日延续去重', async () => {
    await append(today, [record('first')]);
    await refresh();
    vi.mocked(scanJsonlTail).mockClear();
    await refresh();
    expect(vi.mocked(scanJsonlTail).mock.calls.every(([, start, end]) => start === end)).toBe(true);
    const file = path.join(dir, 'logs/output', `agent-${today}.jsonl`);
    await fs.rename(file, path.join(dir, 'logs/output', `agent.rotated-${today}.jsonl`));
    await append(today, [record('first'), record('second')]);
    let summary = await refresh();
    expect(summary.ranges.today.codeChanges[0].measuredOperations).toBe(2);
    vi.setSystemTime(new Date('2026-11-17T12:00:00'));
    await append('2026-11-17', [record('first'), record('third')]);
    summary = await refresh();
    expect(summary.ranges.today.codeChanges[0].measuredOperations).toBe(1);
    expect(summary.ranges.sevenDays.codeChanges[0].measuredOperations).toBe(3);
  });

  it('缓存提交失败后重试不会丢失或重复计数', async () => {
    await append(today, [record('first')]);
    await refresh();
    await append(today, [record('first'), record('second')]);
    const original = fsUtils.writeJsonFile;
    const write = vi.spyOn(fsUtils, 'writeJsonFile').mockImplementation(async (file, data) => {
      if (file.endsWith('metrics-code-changes.json')) throw new Error('模拟原子提交失败');
      return original(file, data);
    });
    await new MetricsSummaryWriter(dir, config).refresh();
    const degraded = JSON.parse(await fs.readFile(path.join(dir, 'logs/metrics-summary.json'), 'utf8'));
    expect(degraded.ranges.today.totalEvents).toBe(3);
    expect(degraded.ranges.today.codeChanges).toEqual([]);
    write.mockRestore();
    const summary = await refresh();
    expect(summary.ranges.today.codeChanges[0].measuredOperations).toBe(2);
  });

  it('历史失败和冲突失败优先，未测量可升级为已测量', async () => {
    await append(today, [record('legacy-failed', { 'gen_ai.code.change_status': undefined, 'gen_ai.tool.name': 'Write', 'tool.result.status': 'error' }),
      record('contradiction', { 'error.type': 'ToolError' }),
      record('upgrade', { 'gen_ai.code.change_status': 'unmeasured' })]);
    await refresh();
    await append(today, [record('upgrade'), record('contradiction')]);
    const summary = await refresh();
    expect(summary.ranges.today.codeChanges[0]).toMatchObject({ measuredOperations: 1, unmeasuredOperations: 0, failedOperations: 2, addedLines: 8 });
  });

  it('缺少会话时使用 event id，缺少所有身份时跳过', async () => {
    await append(today, [record('one', { 'gen_ai.session.id': '', 'gen_ai.tool.call.id': 'reused' }),
      record('two', { 'gen_ai.session.id': '', 'gen_ai.tool.call.id': 'reused' }),
      record('none', { 'gen_ai.session.id': '', 'gen_ai.tool.call.id': 'reused', 'event.id': undefined })]);
    const summary = await refresh();
    expect(summary.ranges.today.codeChanges[0].measuredOperations).toBe(2);
  });
});
