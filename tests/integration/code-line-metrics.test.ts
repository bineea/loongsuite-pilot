import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InputManager } from '../../src/core/input-manager.js';
import { MetricsSummaryWriter } from '../../src/status-bar/metrics-summary-writer.js';
import { buildAgentActivityEntry, projectLogEntry } from '../../src/normalization/entry-builder.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';
import { MockFlusher } from '../helpers/mock-flusher.js';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('文件修改证据到本地看板摘要', () => {
  it('经过统一采集、脱敏和 JSONL 后，按 Agent 分组并在重启后保持幂等', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'pilot-code-line-integration-'));
    try {
      const manager = new InputManager();
      const sink = new MockFlusher();
      manager.setFlusher(sink);
      manager.setMaskConfig({ mode: 'all', types: [], replacementMode: 'placeholder' });
      const call = buildAgentActivityEntry({
        'event.id': 'call', 'event.name': 'tool.call', 'gen_ai.agent.type': 'codex',
        'gen_ai.session.id': 'codex-session', 'gen_ai.tool.call.id': 'patch-call',
        'gen_ai.tool.name': 'apply_patch',
        'gen_ai.tool.call.arguments': { command: '*** Begin Patch\n*** Update File: example.ts\n@@\n-old\n+new\n+extra\n*** End Patch' },
      });
      const result = buildAgentActivityEntry({
        'event.id': 'result', 'event.name': 'tool.result', 'gen_ai.agent.type': 'codex',
        'gen_ai.session.id': 'codex-session', 'gen_ai.tool.call.id': 'patch-call',
        'gen_ai.tool.name': 'apply_patch',
        'gen_ai.tool.call.result': 'Success. Updated the following files:\nM example.ts',
        'tool.result.status': 'success',
      });
      const claude = buildAgentActivityEntry({
        'event.id': 'claude-result', 'event.name': 'tool.result', 'gen_ai.agent.type': 'claude-code',
        'gen_ai.session.id': 'claude-session', 'gen_ai.tool.call.id': 'write-call',
        'gen_ai.tool.name': 'Write', 'tool.result.status': 'success',
        'gen_ai.tool.call.result': { type: 'create', content: 'one\r\ntwo\r\n', filePath: 'new.ts', structuredPatch: [] },
      });
      await manager.flushPreparedEntries([call]);
      await manager.flushPreparedEntries([result, claude]);
      const records = sink.batchCalls.flat().map(entry => projectLogEntry(entry));
      const output = path.join(dataDir, 'logs', 'output');
      await mkdir(output, { recursive: true });
      const today = getTodayDateString();
      await writeFile(path.join(output, `mixed-${today}.jsonl`),
        [...records, ...records].map(record => JSON.stringify(record)).join('\n') + '\n');
      const config = { enabled: true, metricsSummaryIntervalMs: 60000, runtimeRefreshIntervalMs: 30000 };
      await new MetricsSummaryWriter(dataDir, config).refresh();
      await new MetricsSummaryWriter(dataDir, config).refresh();
      const summary = JSON.parse(await readFile(path.join(dataDir, 'logs', 'metrics-summary.json'), 'utf8'));
      expect(summary.ranges.today.codeChanges).toEqual([
        { agentType: 'claude-code', addedLines: 2, deletedLines: 0, filesChanged: 1,
          measuredOperations: 1, unmeasuredOperations: 0, failedOperations: 0 },
        { agentType: 'codex', addedLines: 2, deletedLines: 1, filesChanged: 1,
          measuredOperations: 1, unmeasuredOperations: 0, failedOperations: 0 },
      ]);
      expect(summary.ranges.sevenDays.codeChanges).toEqual(summary.ranges.today.codeChanges);
      expect(summary.ranges.thirtyDays.codeChanges).toEqual(summary.ranges.today.codeChanges);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
