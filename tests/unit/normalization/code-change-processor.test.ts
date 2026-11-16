import { describe, it, expect } from 'vitest';
import { CodeChangeProcessor } from '../../../src/normalization/code-change-processor.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
function event(
  name: 'tool.call' | 'tool.result',
  extra: Record<string, unknown> = {},
): AgentActivityEntry {
  return {
    time_unix_nano: '1',
    'event.id': name,
    'user.id': '',
    'event.name': name,
    'gen_ai.session.id': 's',
    'gen_ai.agent.type': 'codex',
    'gen_ai.provider.name': '',
    'gen_ai.tool.call.id': 'c',
    'gen_ai.tool.name': 'apply_patch',
    ...extra,
  } as AgentActivityEntry;
}
describe('代码修改证据', () => {
  it('跨批次关联成功补丁并按物理行统计', () => {
    const processor = new CodeChangeProcessor();
    processor.enrich([
      event('tool.call', {
        'gen_ai.tool.call.arguments':
          '*** Begin Patch\n*** Update File: a\n@@\n-old-a\n+x\n+\n*** Update File: b\n@@\n-old\n+new\n*** End Patch',
      }),
    ]);
    const result = event('tool.result', {
      'gen_ai.tool.call.result':
        'Success. Updated the following files:\nM a\nM b',
    });
    processor.enrich([result]);
    expect(result['gen_ai.code.change_status']).toBe('measured');
    expect(result['gen_ai.code.lines_added']).toBe(3);
    expect(result['gen_ai.code.lines_deleted']).toBe(2);
    expect(result['gen_ai.code.files_changed']).toBe(2);
  });
  it.each(['Error: patch failed', 'arbitrary output'])(
    '不将完成状态当作补丁成功证据 %s',
    (output) => {
      const result = event('tool.result', {
        'tool.result.status': 'success',
        'gen_ai.tool.call.result': output,
      });
      new CodeChangeProcessor().enrich([
        event('tool.call', {
          'gen_ai.tool.call.arguments':
            '*** Begin Patch\n*** Update File: a\n@@\n-old\n+x\n*** End Patch',
        }),
        result,
      ]);
      expect(result['gen_ai.code.change_status']).not.toBe('measured');
    },
  );
  it('整文件删除缺少原文时未知', () => {
    const result = event('tool.result', {
      'gen_ai.tool.call.result': 'Success. Updated the following files:\nD a',
    });
    new CodeChangeProcessor().enrich([
      event('tool.call', {
        'gen_ai.tool.call.arguments':
          '*** Begin Patch\n*** Delete File: a\n*** End Patch',
      }),
      result,
    ]);
    expect(result['gen_ai.code.change_status']).toBe('unmeasured');
  });
  it('Claude 原生 structuredPatch 结果独立测量', () => {
    const result = event('tool.result', {
      'gen_ai.tool.name': 'Edit',
      'tool.result.status': 'success',
      'gen_ai.tool.call.result': {
        structuredPatch: [{ lines: [' a', '-b', '+c', '+'] }],
        filePath: 'a',
      },
    });
    new CodeChangeProcessor().enrich([result]);
    expect(result['gen_ai.code.lines_added']).toBe(2);
    expect(result['gen_ai.code.lines_deleted']).toBe(1);
  });
  it('读取无修改，shell 未知，缺少调用未知', () => {
    const results = ['Read', 'exec_command', 'apply_patch'].map((name) =>
      event('tool.result', { 'gen_ai.tool.name': name }),
    );
    new CodeChangeProcessor().enrich(results);
    expect(results.map((e) => e['gen_ai.code.change_status'])).toEqual([
      'not_applicable',
      'unmeasured',
      'unmeasured',
    ]);
  });
});

it('Codex 原生对象输出与非零 exit_code', () => {
  const processor = new CodeChangeProcessor();
  const call = event('tool.call', {
    'gen_ai.tool.call.arguments':
      '*** Begin Patch\n*** Update File: a\n@@\n-old\n+x\n*** End Patch',
  });
  const result = event('tool.result', {
    'gen_ai.tool.call.result': {
      output: 'Success. Updated the following files:\nM a',
      metadata: { exit_code: 0 },
    },
  });
  processor.enrich([call, result]);
  expect(result['gen_ai.code.change_status']).toBe('measured');
  const failed = event('tool.result', {
    'gen_ai.tool.call.result': { output: 'failed', metadata: { exit_code: 1 } },
  });
  processor.enrich([failed]);
  expect(failed['gen_ai.code.change_status']).toBe('failed');
});
it('跨 Agent 会话隔离，重放一致，有界淘汰', () => {
  const processor = new CodeChangeProcessor(1);
  const args =
    '*** Begin Patch\n*** Update File: a\n@@\n-old\n+x\n*** End Patch';
  processor.enrich([
    event('tool.call', { 'gen_ai.tool.call.arguments': args }),
  ]);
  const replay = () =>
    event('tool.result', {
      'gen_ai.tool.call.result': 'Success. Updated the following files:\nM a',
    });
  const first = replay(),
    second = replay();
  processor.enrich([first, second]);
  expect(first['gen_ai.code.lines_added']).toBe(1);
  expect(second['gen_ai.code.lines_added']).toBe(1);
  const isolated = event('tool.result', {
    'gen_ai.session.id': 'other',
    'gen_ai.tool.call.result': 'Success. Updated the following files:\nM a',
  });
  processor.enrich([isolated]);
  expect(isolated['gen_ai.code.change_status']).toBe('unmeasured');
  processor.enrich([event('tool.call', { 'gen_ai.tool.call.id': 'new' })]);
  const evicted = replay();
  processor.enrich([evicted]);
  expect(evicted['gen_ai.code.change_status']).toBe('unmeasured');
});
it('Claude 创建空文件和 CRLF 行数，覆盖缺少原文未知', () => {
  const results = ['', 'a\r\n\r\nb\r\n'].map((content) =>
    event('tool.result', {
      'gen_ai.tool.name': 'Write',
      'tool.result.status': 'success',
      'gen_ai.tool.call.result': { type: 'create', content },
    }),
  );
  const overwrite = event('tool.result', {
    'gen_ai.tool.name': 'Write',
    'tool.result.status': 'success',
    'gen_ai.tool.call.result': { type: 'update', content: 'x' },
  });
  new CodeChangeProcessor().enrich([...results, overwrite]);
  expect(results.map((e) => e['gen_ai.code.lines_added'])).toEqual([0, 3]);
  expect(overwrite['gen_ai.code.change_status']).toBe('unmeasured');
});

it('成功状态、创建优先级、读取失败与无操作补丁', () => {
  const processor = new CodeChangeProcessor();
  const native = event('tool.result', {
    'gen_ai.tool.name': 'Edit',
    'gen_ai.tool.call.result': { structuredPatch: [{ lines: ['-a', '+b'] }] },
  });
  const created = event('tool.result', {
    'gen_ai.tool.name': 'Write',
    'tool.result.status': 'success',
    'gen_ai.tool.call.result': {
      type: 'create',
      content: 'a\n',
      structuredPatch: [],
    },
  });
  const read = event('tool.result', {
    'gen_ai.tool.name': 'Read',
    'tool.result.status': 'error',
  });
  processor.enrich([native, created, read]);
  expect(native['gen_ai.code.change_status']).toBe('unmeasured');
  expect(created['gen_ai.code.lines_added']).toBe(1);
  expect(read['gen_ai.code.change_status']).toBe('not_applicable');
  const noop = event('tool.result', {
    'gen_ai.tool.call.result': 'Success. Updated the following files:\nM a',
  });
  processor.enrich([
    event('tool.call', {
      'gen_ai.tool.call.arguments': {
        command:
          '*** Begin Patch\n*** Update File: a\n@@\n-a\n+a\n*** End Patch',
      },
    }),
    noop,
  ]);
  expect(noop['gen_ai.code.lines_added']).toBe(0);
  expect(noop['gen_ai.code.lines_deleted']).toBe(0);
  expect(noop['gen_ai.code.files_changed']).toBe(0);
});

it('真实 Codex extractor builder 与 JSONL 投影保留数值', async () => {
  const { extractCodexTerminalTurn } = await import(
    '../../../src/inputs/codex-transcript/codex-transcript-extractor.js'
  );
  const { buildCodexTranscriptEntries } = await import(
    '../../../src/inputs/codex-transcript/codex-transcript-builder.js'
  );
  const { projectLogEntry } = await import(
    '../../../src/normalization/entry-builder.js'
  );
  const record = (type: string, payload: Record<string, unknown>) => ({
    type,
    timestamp: '2026-11-16T01:00:00Z',
    payload,
  });
  const turn = extractCodexTerminalTurn(
    [
      record('event_msg', { type: 'task_started', turn_id: 't' }),
      record('response_item', {
        type: 'custom_tool_call',
        call_id: 'c',
        name: 'apply_patch',
        input:
          '*** Begin Patch\n*** Update File: a\n@@\n-old\n+x\n*** End Patch',
      }),
      record('response_item', {
        type: 'custom_tool_call_output',
        call_id: 'c',
        output: JSON.stringify({
          output: 'Success. Updated the following files:\nM a',
          metadata: { exit_code: 0 },
        }),
      }),
      record('event_msg', { type: 'task_complete', turn_id: 't' }),
    ],
    null,
    'session',
    't',
  );
  expect(turn).not.toBeNull();
  const entries = buildCodexTranscriptEntries(turn!);
  new CodeChangeProcessor().enrich(entries);
  const result = entries.find(
    (entry) => entry['event.name'] === 'tool.result',
  )!;
  expect(
    JSON.parse(JSON.stringify(projectLogEntry(result)))[
      'gen_ai.code.lines_added'
    ],
  ).toBe(1);
});
it.each([
  '*** Begin Patch\n*** Update File: a\n@@\n-old\n+x\n*** End Patch\ntrailing',
  '*** Begin Patch\n*** Update File: a\n+x\n*** End Patch',
  '*** Begin Patch\n*** Add File: a\n' +
    'x'.repeat(2 * 1024 * 1024) +
    '\n*** End Patch',
])('拒绝不完整或过大的补丁', (patch) => {
  const result = event('tool.result', {
    'gen_ai.tool.call.result': 'Success. Updated the following files:\nM a',
  });
  new CodeChangeProcessor().enrich([
    event('tool.call', { 'gen_ai.tool.call.arguments': patch }),
    result,
  ]);
  expect(result['gen_ai.code.change_status']).toBe('unmeasured');
});

it('缺少 session 不关联调用，非文件 create 不计为文件修改', () => {
  const result = event('tool.result', {
    'gen_ai.session.id': '',
    'gen_ai.tool.call.result': 'Success. Updated the following files:\nM a',
  });
  const issue = event('tool.result', {
    'gen_ai.tool.name': 'create_issue',
    'tool.result.status': 'success',
    'gen_ai.tool.call.result': { type: 'create', content: 'issue text' },
  });
  new CodeChangeProcessor().enrich([
    event('tool.call', {
      'gen_ai.session.id': '',
      'gen_ai.tool.call.arguments':
        '*** Begin Patch\n*** Update File: a\n@@\n-old\n+x\n*** End Patch',
    }),
    result,
    issue,
  ]);
  expect(result['gen_ai.code.change_status']).toBe('unmeasured');
  expect(issue['gen_ai.code.change_status']).toBe('unmeasured');
});
it('原生差异也限制证据大小', () => {
  const result = event('tool.result', {
    'gen_ai.tool.name': 'Write',
    'tool.result.status': 'success',
    'gen_ai.tool.call.result': {
      type: 'create',
      content: 'a'.repeat(2 * 1024 * 1024 + 1),
    },
  });
  new CodeChangeProcessor().enrich([result]);
  expect(result['gen_ai.code.change_reason']).toBe('evidence_too_large');
});
it('InputManager 脱敏前提取并通过真实 JSONL 输出保留数字', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { InputManager } = await import('../../../src/core/input-manager.js');
  const { JsonlFlusher } = await import(
    '../../../src/flushers/jsonl-flusher.js'
  );
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pilot-code-lines-'),
  );
  const flusher = new JsonlFlusher({
    enabled: true,
    outputDir,
    maxFileSizeMb: 10,
    rotateDaily: false,
  });
  const manager = new InputManager();
  manager.setFlusher(flusher);
  manager.setMaskConfig({ mode: 'all', types: [] });
  try {
    await flusher.start();
    await manager.flushPreparedEntries([
      event('tool.call', {
        'gen_ai.tool.call.arguments':
          '*** Begin Patch\n*** Update File: a\n@@\n-old\n+sk-1234567890abcdefghijklmnop\n*** End Patch',
      }),
      event('tool.result', {
        'gen_ai.tool.call.result': 'Success. Updated the following files:\nM a',
      }),
    ]);
    await flusher.flush();
    const text = await fs.readFile(
      path.join(outputDir, 'codex-all.jsonl'),
      'utf8',
    );
    const result = JSON.parse(text.trim().split('\n').at(-1)!);
    expect(result['gen_ai.code.lines_added']).toBe(1);
    expect(text).not.toContain('sk-1234567890abcdefghijklmnop');
  } finally {
    await flusher.shutdown();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

it.each([
  { before: ['a', 'b'], after: ['a', 'c'], added: 1, deleted: 1 },
  { before: ['a', 'b', 'c'], after: ['a', 'x', 'c'], added: 1, deleted: 1 },
  { before: ['a', 'b', 'a'], after: ['a', 'a'], added: 0, deleted: 1 },
  { before: ['', 'a', ''], after: ['', '', 'a'], added: 1, deleted: 1 },
])(
  '移除部分共同内容并正确匹配重复行 $before',
  ({ before, after, added, deleted }) => {
    const lines = [
      ...before.map((line) => '-' + line),
      ...after.map((line) => '+' + line),
    ];
    const patchResult = event('tool.result', {
      'gen_ai.tool.call.result': 'Success. Updated the following files:\nM a',
    });
    const nativeResult = event('tool.result', {
      'gen_ai.tool.name': 'Edit',
      'tool.result.status': 'success',
      'gen_ai.tool.call.result': { structuredPatch: [{ lines }] },
    });
    new CodeChangeProcessor().enrich([
      event('tool.call', {
        'gen_ai.tool.call.arguments':
          '*** Begin Patch\n*** Update File: a\n@@\n' +
          lines.join('\n') +
          '\n*** End Patch',
      }),
      patchResult,
      nativeResult,
    ]);
    for (const result of [patchResult, nativeResult]) {
      expect(result['gen_ai.code.lines_added']).toBe(added);
      expect(result['gen_ai.code.lines_deleted']).toBe(deleted);
    }
  },
);
it('复杂差异超过计算预算时两条管道均标记未知', () => {
  const lines = [
    ...Array.from({ length: 1100 }, (_, index) => '-old-' + index),
    ...Array.from({ length: 1100 }, (_, index) => '+new-' + index),
  ];
  const patchResult = event('tool.result', {
    'gen_ai.tool.call.result': 'Success. Updated the following files:\nM a',
  });
  const nativeResult = event('tool.result', {
    'gen_ai.tool.name': 'Edit',
    'tool.result.status': 'success',
    'gen_ai.tool.call.result': { structuredPatch: [{ lines }] },
  });
  new CodeChangeProcessor().enrich([
    event('tool.call', {
      'gen_ai.tool.call.arguments':
        '*** Begin Patch\n*** Update File: a\n@@\n' +
        lines.join('\n') +
        '\n*** End Patch',
    }),
    patchResult,
    nativeResult,
  ]);
  for (const result of [patchResult, nativeResult]) {
    expect(result['gen_ai.code.change_status']).toBe('unmeasured');
    expect(result['gen_ai.code.change_reason']).toBe('diff_budget_exceeded');
    expect(result['gen_ai.code.lines_added']).toBeUndefined();
  }
});

it('Add File 成功输出不能证明此前文件不存在，覆盖缺少原文时未知', () => {
  const result = event('tool.result', {
    'gen_ai.tool.call.result': 'Success. Updated the following files:\nA a',
  });
  new CodeChangeProcessor().enrich([
    event('tool.call', {
      'gen_ai.tool.call.arguments':
        '*** Begin Patch\n*** Add File: a\n+new1\n*** End Patch',
    }),
    result,
  ]);
  expect(result['gen_ai.code.change_status']).toBe('unmeasured');
  expect(result['gen_ai.code.change_reason']).toBe('missing_original_content');
  expect(result['gen_ai.code.lines_added']).toBeUndefined();
  expect(result['gen_ai.code.lines_deleted']).toBeUndefined();
});

it('Move to 可能覆盖已有目标，缺少目标原文时未知', () => {
  const result = event('tool.result', {
    'gen_ai.tool.call.result':
      'Success. Updated the following files:\nM target',
  });
  new CodeChangeProcessor().enrich([
    event('tool.call', {
      'gen_ai.tool.call.arguments':
        '*** Begin Patch\n*** Update File: source\n*** Move to: target\n@@\n-source1\n+source2\n*** End Patch',
    }),
    result,
  ]);
  expect(result['gen_ai.code.change_status']).toBe('unmeasured');
  expect(result['gen_ai.code.change_reason']).toBe('missing_original_content');
  expect(result['gen_ai.code.lines_added']).toBeUndefined();
  expect(result['gen_ai.code.lines_deleted']).toBeUndefined();
});
