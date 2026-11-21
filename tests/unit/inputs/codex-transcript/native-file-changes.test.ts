import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../../../src/inputs/codex-transcript/codex-transcript-input.js';
import { CodeChangeProcessor } from '../../../../src/normalization/code-change-processor.js';
import { buildAgentActivityEntry, projectLogEntry } from '../../../../src/normalization/entry-builder.js';
import { MetricsSummaryWriter } from '../../../../src/status-bar/metrics-summary-writer.js';
import { getTodayDateString } from '../../../../src/utils/fs-utils.js';
import { WorkspacePolicy } from '../../../../src/core/workspace-policy.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const change = (overrides = {}) => ({ type: 'update', unified_diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n', move_path: null, ...overrides });
function native(id = 'exec-edit-1', status = 'completed', changes = { 'a.ts': change() }) {
  return { type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    type: 'item_completed', thread_id: 'thread', turn_id: 'turn',
    item: { type: 'FileChange', id, status, changes, stdout: '', stderr: '' },
  } };
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-file-change-')); dirs.push(root);
  const file = path.join(root, 'rollout-thread_resume.jsonl');
  const store = new StateStore(path.join(root, 'state.json')); await store.load();
  const makeInput = () => new CodexTranscriptInput({ stateStore: store, sessionDir: root, wakeupDir: path.join(root, 'wakeups') });
  const input = makeInput(); const entries: AgentActivityEntry[] = [];
  const watch = (i: CodexTranscriptInput) => i.on('entries', batch => entries.push(...batch)); watch(input);
  const write = async (records: unknown[]) => fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n')+'\n');
  const meta = { type: 'session_meta', payload: { id: 'thread', cwd: root, originator: 'Codex Desktop' } };
  const scan = async (i = input) => (i as any).processFile(file);
  return {root, file, store, input, entries, makeInput, watch, write, meta, scan};
}
it('已有会话基线仍补采桌面 FileChange，随后仅处理追加记录并在重启后去重', async () => {
  const s = await setup(); await s.write([s.meta, native()]);
  await (s.input as any).baselineFile(s.file, (s.input as any).stateKey(s.file));
  await s.scan();
  new CodeChangeProcessor().enrich(s.entries);
  expect(s.entries).toHaveLength(1);
  expect(s.entries[0]).toMatchObject({'gen_ai.session.id':'thread','gen_ai.code.change_status':'measured','gen_ai.code.lines_added':2,'gen_ai.code.lines_deleted':1});
  expect(JSON.stringify(s.entries[0]['gen_ai.tool.call.result'])).not.toContain('extra');
  await s.scan(); expect(s.entries).toHaveLength(1);
  const restarted=s.makeInput();s.watch(restarted);await s.scan(restarted);expect(s.entries).toHaveLength(1);
  const tail=JSON.stringify(native('exec-edit-2'));
  await fs.appendFile(s.file,tail);await s.scan(restarted);expect(s.entries).toHaveLength(1);
  await fs.appendFile(s.file,'\n');await s.scan(restarted);expect(s.entries).toHaveLength(2);
});
it('恢复持久化游标不重放，截断替换为更长文件后能发现新回执', async () => {
  const s=await setup();await s.write([s.meta,native()]);await s.scan();await s.store.save();
  const loaded=new StateStore(path.join(s.root,'state.json'));await loaded.load();
  const input=new CodexTranscriptInput({stateStore:loaded,sessionDir:s.root,wakeupDir:path.join(s.root,'wakeups')});s.watch(input);
  await s.scan(input);expect(s.entries).toHaveLength(1);
  await s.write([s.meta,native('exec-edit-2'),native('exec-third')]);
  await s.scan(input);expect(s.entries).toHaveLength(3);
  const cursor=loaded.get((input as any).stateKey(s.file)).extra?.codexFileChanges as {anchor:string};
  expect(cursor.anchor).toMatch(/^[a-f0-9]{64}$/);
});
it('排除工作区不会从原生文件回执泄漏计量事件', async () => {
  const s=await setup();s.input.setWorkspacePolicy(new WorkspacePolicy([s.root]));
  await s.write([s.meta,native()]);await s.scan();expect(s.entries).toEqual([]);
});
it('原生多文件与多 hunk 分别计数，同名文件不把多个 hunk 计成多文件', async () => {
  const s=await setup();await s.write([s.meta,native('exec-many','completed',{
    'a.ts':change({unified_diff:'@@ -1 +1 @@\n-old\n+new\n@@ -4,0 +5 @@\n+extra\n'}),
    'b.ts':change(),
  })]);await s.scan();new CodeChangeProcessor().enrich(s.entries);
  expect(s.entries[0]).toMatchObject({'gen_ai.code.lines_added':4,'gen_ai.code.lines_deleted':2,'gen_ai.code.files_changed':2});
});
it('父线程副本及非 exec 的直接调用镜像不计量，失败不产生行数', async () => {
  const s=await setup();const copied=native('exec-parent');copied.payload.thread_id='parent';
  await s.write([s.meta,copied,native('call-direct'),native('exec-failed','failed')]);await s.scan();
  new CodeChangeProcessor().enrich(s.entries);
  expect(s.entries).toHaveLength(1);expect(s.entries[0]['gen_ai.code.change_status']).toBe('failed');
  expect(s.entries[0]['gen_ai.code.lines_added']).toBeUndefined();
});
it.each([
  [change({unified_diff:'@@ -1,2 +1,3 @@\n-old\n+new\n'}),'invalid_patch'],
  [change({move_path:'target.ts'}),'missing_original_content'],
  [{type:'add',content:'new\n'},'missing_original_content'],
])('拒绝不完整或不能证明旧内容的原生变更 %j', (value, reason) => {
  const entry=buildAgentActivityEntry({'event.name':'tool.result','gen_ai.agent.type':'codex','gen_ai.tool.name':'codex_file_change','tool.result.status':'success','gen_ai.tool.call.result':{changes:{'a.ts':value}}});
  new CodeChangeProcessor().enrich([entry]);
  expect(entry['gen_ai.code.change_status']).toBe('unmeasured');expect(entry['gen_ai.code.change_reason']).toBe(reason);
});
it('补采按事件日期归档，多次重放不重复计数', async () => {
  const s=await setup();const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
  const record=native();record.timestamp=yesterday.toISOString();await s.write([s.meta,record]);await s.scan();
  new CodeChangeProcessor().enrich(s.entries);
  await fs.mkdir(path.join(s.root,'logs/output'),{recursive:true});
  await fs.writeFile(path.join(s.root,'logs/output',`codex-${getTodayDateString()}.jsonl`),[...s.entries,...s.entries].map(e=>JSON.stringify(projectLogEntry(e))).join('\n')+'\n');
  const writer=new MetricsSummaryWriter(s.root,{enabled:true,metricsSummaryIntervalMs:60000,runtimeRefreshIntervalMs:30000});await writer.refresh();await writer.refresh();
  const summary=JSON.parse(await fs.readFile(path.join(s.root,'logs/metrics-summary.json'),'utf8'));
  expect(summary.ranges.today.codeChanges).toEqual([]);
  expect(summary.ranges.sevenDays.codeChanges[0]).toMatchObject({addedLines:2,deletedLines:1,measuredOperations:1});
});
