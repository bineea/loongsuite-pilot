import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BoundedTtlCache } from '../utils/git-context.js';

export type FileLineCounts = { path: string; added: number; deleted: number; files: number };
export type RepositoryLineCounts = { id: string; name: string; added: number; deleted: number; files: number };
type Repository = { id: string; name: string };
const unknown: Repository = { id: 'unknown', name: '' };
const cache = new BoundedTtlCache<{ expiresAt: number; repository: Repository }>(512);
const exec = promisify(execFile);
async function git(directory: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['-C', directory, ...args], { timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

export function absoluteCodePath(file: string, workspace?: string): string | undefined {
  if (!file || file.includes('\0') || file.length > 32768) return undefined;
  if (path.isAbsolute(file)) return path.normalize(file);
  // 不将其他操作系统的绝对路径误当成本机相对路径。
  if (path.win32.isAbsolute(file) || path.posix.isAbsolute(file)) return undefined;
  return workspace && path.isAbsolute(workspace) ? path.resolve(workspace, file) : undefined;
}

/** 只发布无凭据的主机/仓库名；不输出 remote 原文、查询参数或用户信息。 */
function remoteRepository(remote: string | undefined): Repository | undefined {
  if (!remote) return undefined;
  let value = remote;
  if (!value.includes('://')) {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(value);
    if (!scp || /^[A-Za-z]:[\\/]/.test(value)) return undefined;
    value = `ssh://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return undefined;
    const repo = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (!repo || repo.length > 2048) return undefined;
    const defaultPort = ({ 'http:':'80', 'https:':'443', 'ssh:':'22', 'git:':'9418' } as Record<string,string>)[url.protocol];
    const port = url.port && url.port !== defaultPort ? `:${url.port}` : '';
    const name = `${url.hostname.toLowerCase()}${port}/${repo}`;
    return { id: `remote:${name}`, name };
  } catch { return undefined; }
}

/** 以实际文件目录探测 Git；新建/已删除文件允许向上寻找仍存在的父目录。 */
export async function resolveCodeRepository(file: string, workspace?: string): Promise<Repository> {
  const absolute = absoluteCodePath(file, workspace);
  if (!absolute) return unknown;
  const directory = path.dirname(absolute);
  const cached = cache.get(directory);
  if (cached) return cached.repository;
  let probe = directory;
  for (let depth = 0; depth < 64; depth++) {
    try { if ((await fs.stat(probe)).isDirectory()) break; } catch { /* 继续寻找父目录。 */ }
    const parent = path.dirname(probe);
    if (parent === probe) return unknown;
    probe = parent;
  }
  let repository = unknown;
  const root = await git(probe, ['rev-parse', '--show-toplevel']);
  if (root) {
    const remote = remoteRepository(await git(root, ['config', '--get', 'remote.origin.url']));
    if (remote) repository = remote;
    else {
      const common = await git(root, ['rev-parse', '--git-common-dir']);
      if (common) {
        try {
          let canonical = await fs.realpath(path.resolve(root, common));
          if (process.platform === 'win32') canonical = canonical.toLowerCase();
          const digest = createHash('sha256').update(canonical).digest('hex');
          const label = path.basename(canonical) === '.git' ? path.basename(path.dirname(canonical)) : path.basename(canonical);
          repository = { id: `local:${digest}`, name: `${label} [local:${digest.slice(0, 8)}]` };
        } catch { /* Git 元数据消失时保持未知。 */ }
      }
    }
  }
  cache.set(directory, { expiresAt: Date.now() + 30_000, repository });
  return repository;
}

export async function groupCodeRepositories(files: FileLineCounts[], workspace?: string): Promise<RepositoryLineCounts[]> {
  const groups = new Map<string, RepositoryLineCounts>();
  for (const file of files) {
    const repository = await resolveCodeRepository(file.path, workspace);
    const group = groups.get(repository.id) ?? { ...repository, added: 0, deleted: 0, files: 0 };
    group.added += file.added; group.deleted += file.deleted; group.files += file.files;
    groups.set(group.id, group);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}
