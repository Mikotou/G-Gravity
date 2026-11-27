import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hasPlanText, planFilename, planReferences } from './plan-references';
import type { ChatMessageItem, GetSessionPlanArtifactInput, PlanArtifactChangedEvent, PlanArtifactSnapshot } from '../../shared/session-contract';
import { isUnsafeLocalFile, localPathMember, normalizeDarwinSystemAlias, sameLocalPath, openLocalFile, readPrefix, readBoundedLocalFile } from '../workspace/local-path-safety';
import { safeWorkspacePath, within } from '../workspace/workspace-files';

const maxFileSize = 4 * 1024 * 1024;
const limit = 131_072;
type Owner = PlanArtifactSnapshot['owner'];
interface Context {
  cwd: string;
  homeDir?: string;
  appDataRoot?: string;
  generation: object;
  references(readArchives: boolean): Iterable<string>;
}
interface Candidate {
  anchor: string;
  path: string;
  source: NonNullable<PlanArtifactSnapshot['source']>;
}
interface Observation {
  owner: Owner;
  signature?: string;
  fileStamp?: string;
  revision: number;
  watchers: Map<string, FSWatcher>;
  timer?: NodeJS.Timeout;
  reading?: Promise<PlanArtifactSnapshot>;
}

function* candidates(context: Context, sessionId: string, readArchives: boolean): Generator<Candidate> {
  const home = context.homeDir || homedir();
  const roots = context.appDataRoot ? [context.appDataRoot] : ['antigravity-cli', 'antigravity'].map(dir => join(home, '.gemini', dir));
  for (const root of roots) yield { anchor: context.appDataRoot ? dirname(dirname(root)) : home,
    path: join(root, 'brain', sessionId, planFilename), source: 'brain-artifact' };
  if (!isAbsolute(context.cwd) || !safeWorkspacePath(context.cwd)) return;
  const seen = new Set<string>();
  for (const raw of context.references(readArchives)) {
    if (!safeWorkspacePath(raw) || raw.split(/[\\/]/).includes('..')) continue;
    const target = resolve(context.cwd, raw);
    const member = localPathMember(context.cwd, target) ?? localPathMember(realpathSync.native(context.cwd), target);
    if (member === undefined) continue;
    const path = join(context.cwd, member);
    if (seen.has(path) || !safeWorkspacePath(path)) continue;
    seen.add(path);
    yield { anchor: context.cwd, path, source: 'workspace-reference' };
  }
}

function inspect(candidate: Candidate, observe: (dir: string, child: string) => void): string | undefined {
  const { anchor, path, source } = candidate;
  if (isUnsafeLocalFile(path) || !within(anchor, path)) throw Error('产物路径不可用');
  const normalizedAnchor = normalizeDarwinSystemAlias(resolve(anchor));
  if (lstatSync(normalizedAnchor).isSymbolicLink()) throw Error('产物目录不可重定向');
  const root = realpathSync.native(normalizedAnchor);
  if (!sameLocalPath(normalizedAnchor, root)) throw Error('产物目录不可重定向');
  let cursor = root;
  for (const part of relative(anchor, path).split(sep).filter(Boolean)) {
    const parent = cursor;
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) { observe(parent, part); throw Error('不支持符号链接产物'); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      observe(parent, part);
      return;
    }
  }
  const real = realpathSync.native(cursor);
  if (!sameLocalPath(cursor, real) || localPathMember(root, real) === undefined || isUnsafeLocalFile(real) ||
      (source === 'workspace-reference' && !safeWorkspacePath(real))) throw Error('产物路径不可用');
  observe(dirname(real), basename(real));
  const stat = lstatSync(real);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > maxFileSize) throw Error('仅支持 4 MiB 以内的普通 UTF-8 文件');
  return real;
}

async function readPreview(path: string): Promise<{ content: string; truncated: boolean }> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function decode(bytes: Buffer, stream: boolean) {
    if (bytes.includes(0)) throw Error('产物含有 NUL 字节');
    return decoder.decode(bytes, { stream });
  }
  if (lstatSync(path).size <= limit) return { content: decode(await readBoundedLocalFile(path, limit), false), truncated: false };
  const { handle, stat } = await openLocalFile(path);
  try {
    if (stat.size <= limit || stat.size > maxFileSize) throw Error('产物大小已变化');
    const prefix = await readPrefix(handle, limit);
    if (prefix.length !== limit) throw Error('产物读取不完整');
    // The decoder holds any unfinished character at the preview boundary for the next chunk.
    const content = decode(prefix, true);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (let pos = limit; pos < stat.size;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - pos), pos);
      if (!bytesRead) throw Error('产物读取不完整');
      pos += bytesRead;
      decode(chunk.subarray(0, bytesRead), pos < stat.size);
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.ctimeMs !== stat.ctimeMs) throw Error('读取期间产物已更改');
    return { content, truncated: true };
  } finally { await handle.close(); }
}

function fileStamp(path: string): string {
  const s = lstatSync(path, { bigint: true });
  return [path, s.dev, s.ino, s.size, s.ctimeNs, s.mtimeNs].join('\0');
}

export class PlanArtifactReader {
  private entries = new Map<string, Observation>();
  private revision = 0;
  constructor(private context: (owner: Owner) => Context | undefined, private changed: (event: PlanArtifactChangedEvent) => void) {}

  private forget(entry: Observation): void {
    clearTimeout(entry.timer);
    for (const watcher of entry.watchers.values()) watcher.close();
    this.entries.delete(entry.owner.sessionId);
  }
  clear(): void { for (const entry of this.entries.values()) this.forget(entry); }

  private observation(owner: Owner): Observation {
    let entry = this.entries.get(owner.sessionId);
    if (entry && entry.owner.profileId !== owner.profileId) { this.forget(entry); entry = undefined; }
    if (!entry) {
      if (this.entries.size >= 256) this.forget(this.entries.values().next().value!);
      entry = { owner, revision: 0, watchers: new Map() };
    }
    this.entries.delete(owner.sessionId);
    this.entries.set(owner.sessionId, entry);
    return entry;
  }

  observe(owner: Owner): void {
    if (!this.entries.has(owner.sessionId) && this.context(owner)) {
      this.observation(owner);
      this.notice(owner.sessionId);
    }
  }

  messageChanged(owner: Owner, message: ChatMessageItem): void {
    if (!message.todos && !message.references?.length && !message.toolCalls?.length && !hasPlanText(message.content || '')) return;
    if (!message.todos && planReferences([message]).next().done) return;
    this.observe(owner);
    this.notice(owner.sessionId);
  }
  notice(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.entries.get(id) === entry) void this.get({ ...entry.owner, knownRevision: entry.revision }, false).catch(() => {});
    }, 60);
    entry.timer.unref();
  }
  private watch(entry: Observation, targets: Map<string, [string, string]>): void {
    for (const [key, watcher] of entry.watchers) if (!targets.has(key)) { watcher.close(); entry.watchers.delete(key); }
    for (const [key, [dir, child]] of targets) {
      if (entry.watchers.has(key)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (!filename || filename.toLowerCase() === child.toLowerCase()) this.notice(entry.owner.sessionId);
        });
        watcher.on('error', () => { watcher.close(); entry.watchers.delete(key); this.notice(entry.owner.sessionId); });
        entry.watchers.set(key, watcher);
      } catch { /* A force refresh always rechecks the actual file. */ }
    }
  }

  async get(input: GetSessionPlanArtifactInput, readArchives = true): Promise<PlanArtifactSnapshot> {
    const owner = { profileId: input?.profileId, sessionId: input?.sessionId };
    const denied = (): PlanArtifactSnapshot => ({ status: 'unavailable', owner, revision: 0, reason: '产物不属于当前 Profile 会话' });
    if (typeof owner.sessionId !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(owner.sessionId) ||
        typeof owner.profileId !== 'string' || !this.context(owner)) return denied();
    const entry = this.observation(owner);
    while (entry.reading) await entry.reading;
    const context = this.context(owner);
    if (!context || this.entries.get(owner.sessionId) !== entry) return denied();
    const reading = this.read(entry, context, readArchives, input.knownRevision);
    entry.reading = reading;
    try {
      const result = await reading;
      const current = this.context(owner);
      if (this.entries.get(owner.sessionId) !== entry || current?.generation !== context.generation || current.cwd !== context.cwd) return denied();
      return result.revision > 0 && input.knownRevision === result.revision ? { status: 'unchanged', owner, revision: result.revision } : result;
    } finally { if (entry.reading === reading) entry.reading = undefined; }
  }

  private async read(entry: Observation, context: Context, readArchives: boolean, knownRevision?: number): Promise<PlanArtifactSnapshot> {
    const owner = entry.owner;
    let stamp: string | undefined;
    let result: PlanArtifactSnapshot = { status: 'missing', owner, revision: 0 };
    const targets = new Map<string, [string, string]>();
    const observe = (dir: string, child: string) => { if (targets.size < 16) targets.set(join(dir, child), [dir, child]); };
    try {
      for (const candidate of candidates(context, owner.sessionId, readArchives)) {
        let file: string | undefined;
        try { file = inspect(candidate, observe); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (!file) continue;
        const before = fileStamp(file);
        if (entry.revision > 0 && knownRevision === entry.revision && before === entry.fileStamp) {
          this.watch(entry, targets);
          return { status: 'unchanged', owner, revision: entry.revision };
        }
        const preview = await readPreview(file);
        if (inspect(candidate, observe) !== file || before !== fileStamp(file)) throw Error('读取期间产物路径已更改');
        stamp = before;
        result = { status: 'ready', owner, revision: 0, source: candidate.source, filePath: file, ...preview, updatedAt: lstatSync(file).mtime.toISOString() };
        break;
      }
    } catch {
      result = { status: 'unavailable', owner, revision: 0, reason: '产物无法安全读取或超出 4 MiB UTF-8 文本限制' };
    }
    const current = this.context(owner);
    if (this.entries.get(owner.sessionId) !== entry || current?.generation !== context.generation || current.cwd !== context.cwd) {
      return { status: 'unavailable', owner, revision: 0, reason: '会话归属已改变' };
    }
    this.watch(entry, targets);
    entry.fileStamp = stamp;
    const signature = createHash('sha256').update(JSON.stringify(result)).update(stamp ?? '').digest('hex');
    if (signature !== entry.signature) {
      const changed = entry.signature !== undefined || result.status === 'ready';
      entry.signature = signature;
      if (changed) {
        entry.revision = this.revision = Math.max(this.revision + 1, Date.now() * 1000);
        this.changed({ ...owner, revision: entry.revision });
      }
    }
    return { ...result, revision: entry.revision };
  }
}
