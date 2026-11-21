import { createHash } from 'node:crypto';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';

export interface NativeFileChangeCursor {
  version?: number;
  inode: number;
  offset: number;
  owner?: string;
  cwd?: string;
  parent?: string;
  size?: number;
  mtimeMs?: number;
  tailEnd?: number;
  anchor?: string;
}

/** 只接受桌面端内层工具的原生回执；call_* 的直接 apply_patch 仍走原采集路径。 */
export function nativeFileChangeEntry(record: Record<string, unknown>, cursor: NativeFileChangeCursor): AgentActivityEntry | null {
  const payload = record.payload as Record<string, unknown> | undefined;
  if (record.type !== 'event_msg' || payload?.type !== 'item_completed' || payload.thread_id !== cursor.owner) return null;
  const item = payload.item as Record<string, unknown> | undefined;
  if (item?.type !== 'FileChange' || typeof item.id !== 'string' || !item.id.startsWith('exec-')) return null;
  if (!['completed', 'failed', 'declined'].includes(String(item.status))) return null;
  const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - 200);
  if (timestamp < cutoff.getTime() || timestamp > Date.now() + 60_000) return null;
  const callId = `native-file-change:${item.id}`;
  const eventId = createHash('sha256').update(JSON.stringify([cursor.owner, callId])).digest('hex').slice(0, 32);
  return buildAgentActivityEntry({
    timestamp, 'event.id': eventId, 'event.name': 'tool.result',
    'gen_ai.agent.type': 'codex', 'gen_ai.session.id': cursor.owner,
    'gen_ai.turn.id': typeof payload.turn_id === 'string' ? `${cursor.owner}:${payload.turn_id}` : undefined,
    'workspace.path': cursor.cwd, 'gen_ai.tool.name': 'codex_file_change',
    'gen_ai.tool.call.id': callId,
    'tool.result.status': item.status === 'completed' ? 'success' : 'error',
    'gen_ai.tool.call.result': { changes: item.changes as JsonValue ?? null },
  });
}
