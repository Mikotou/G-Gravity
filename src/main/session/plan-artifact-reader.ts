import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { PLAN_ARTIFACT_FILENAME, PLAN_ARTIFACT_MAX_BYTES, type PlanArtifactView } from '../../shared/plan-contract';
import { parsePlanOutline } from './plan-outline';
import type { GetSessionPlanArtifactInput, PlanArtifactChangedEvent, PlanArtifactSnapshot } from '../../shared/session-contract';
import { isUnsafeLocalFile, localPathMember, normalizeDarwinSystemAlias, sameLocalPath, readBoundedLocalFile } from '../workspace/local-path-safety';
import { within } from '../workspace/workspace-files';

type Owner = PlanArtifactSnapshot['owner'];
interface Context {
  homeDir?: string;
  appDataRoot?: string;
  epoch: number;
}
interface Candidate {
  anchor: string;
  path: string;
}
interface Observation {
  owner: Owner;
  contentSignature?: string;
  summarySignature?: string;
  stamp?: string;
  contentRevision: number;
  summaryRevision: number;
  watchers: Map<string, FSWatcher>;
  timer?: NodeJS.Timeout;
  reading?: Promise<PlanArtifactSnapshot>;
}

function candidates(context: Context, sessionId: string): Candidate[] {
  const home = context.homeDir || homedir();
  const roots = context.appDataRoot ? [context.appDataRoot] : ['antigravity-cli', 'antigravity'].map(dir => join(home, '.gemini', dir));
  return roots.map(root => ({ anchor: context.appDataRoot ? dirname(dirname(root)) : home,
    path: join(root, 'brain', sessionId, PLAN_ARTIFACT_FILENAME) }));
}

function inspect(candidate: Candidate, observe: (dir: string, child: string) => void, directory = false): string | undefined {
  const { anchor, path } = candidate;
  if (isUnsafeLocalFile(path) || !within(anchor, path)) throw Error('产物路径不可用');
  const normalizedAnchor = normalizeDarwinSystemAlias(resolve(anchor));
  if (lstatSync(normalizedAnchor).isSymbolicLink()) throw Error('产物目录不可重定向');
  const root = realpathSync.native(normalizedAnchor);
  if (!sameLocalPath(normalizedAnchor, root)) throw Error('产物目录不可重定向');
  let cursor = root;
  for (const part of relative(anchor, path).split(sep).filter(Boolean)) {
    const parent = cursor;
    observe(parent, part);
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw Error('不支持符号链接产物');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
  const real = realpathSync.native(cursor);
  if (!sameLocalPath(cursor, real) || localPathMember(root, real) === undefined || isUnsafeLocalFile(real)) throw Error('产物路径不可用');
  observe(dirname(real), basename(real));
  const stat = lstatSync(real);
  if (directory) {
    if (!stat.isDirectory()) throw Error('会话产物目录无效');
    return real;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > PLAN_ARTIFACT_MAX_BYTES) throw Error('仅支持 128 KiB 以内的普通 UTF-8 文件');
  return real;
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
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) this.forget(entry);
  }
  clear(): void { for (const entry of this.entries.values()) this.forget(entry); }

  private observation(owner: Owner): Observation {
    let entry = this.entries.get(owner.sessionId);
    if (entry && (entry.owner.profileId !== owner.profileId || entry.owner.epoch !== owner.epoch)) { this.forget(entry); entry = undefined; }
    if (!entry) {
      if (this.entries.size >= 256) this.forget(this.entries.values().next().value!);
      entry = { owner, contentRevision: 0, summaryRevision: 0, watchers: new Map() };
    }
    this.entries.delete(owner.sessionId);
    this.entries.set(owner.sessionId, entry);
    return entry;
  }

  observe(owner: Owner): void {
    const context = this.context(owner);
    if (context && !this.entries.has(owner.sessionId)) {
      this.observation({ ...owner, epoch: context.epoch });
      this.notice(owner.sessionId);
    }
  }
  notice(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.entries.get(id) === entry) void this.get(entry.owner).catch(() => {});
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

  async get(input: GetSessionPlanArtifactInput & Pick<Owner, 'epoch'>): Promise<PlanArtifactSnapshot> {
    const owner: Owner = { profileId: input?.profileId, sessionId: input?.sessionId, epoch: input?.epoch };
    const view = input?.view ?? 'summary';
    const denied = (): PlanArtifactSnapshot => ({ status: 'unavailable', owner, view, epoch: owner.epoch,
      revision: 0, reason: '产物不属于当前会话或视图无效' });
    if (!/^[a-z0-9_-]{1,100}$/i.test(owner.sessionId ?? '') || typeof owner.sessionId !== 'string' ||
        !['summary', 'content'].includes(view)) return denied();
    const context = this.context(owner);
    if (!context || (owner.epoch !== undefined && owner.epoch !== context.epoch)) return denied();
    owner.epoch = context.epoch;
    const entry = this.observation(owner);
    while (entry.reading) await entry.reading;
    const current = () => this.entries.get(owner.sessionId) === entry && this.context(owner)?.epoch === context.epoch;
    if (!current()) return denied();
    const reading = this.read(entry, context, view, current, input.knownRevision);
    entry.reading = reading;
    try {
      const result = await reading;
      if (!current()) return denied();
      if (result.revision && result.revision === input.knownRevision) {
        const { content, outline, ...metadata } = result;
        return { ...metadata, status: 'unchanged' };
      }
      return result;
    } finally { if (entry.reading === reading) entry.reading = undefined; }
  }

  private async read(entry: Observation, context: Context, view: PlanArtifactView, current: () => boolean, knownRevision?: number): Promise<PlanArtifactSnapshot> {
    const owner = entry.owner;
    const result: PlanArtifactSnapshot = { status: 'missing', view, owner, epoch: owner.epoch, revision: 0 };
    const targets = new Map<string, [string, string]>();
    const observe = (dir: string, child: string) => {
      // A directory replaced at the same pathname needs a watcher on its new inode.
      const { dev, ino } = lstatSync(dir, { bigint: true });
      targets.set(JSON.stringify([join(dir, child), String(dev), String(ino)]), [dir, child]);
    };
    const locate = () => {
      const files = candidates(context, owner.sessionId);
      const owners = files.filter(c => inspect({ ...c, path: dirname(c.path) }, observe, true));
      if (owners.length > 1) throw Error('会话产物存在多个归属目录');
      return owners.length ? inspect(owners[0], observe) : undefined;
    };
    let content = '';
    let validatedStamp: string | undefined;
    let outline: PlanArtifactSnapshot['outline'];
    try {
      const path = locate();
      if (path) {
        const before = fileStamp(path);
        const revision = view === 'content' ? entry.contentRevision : entry.summaryRevision;
        if (knownRevision && knownRevision === revision && entry.stamp === before) {
          this.watch(entry, targets);
          return { ...result, status: 'unchanged', source: 'brain-artifact', filePath: path, revision,
            contentRevision: entry.contentRevision, summaryRevision: entry.summaryRevision };
        }
        const bytes = await readBoundedLocalFile(path, PLAN_ARTIFACT_MAX_BYTES, true);
        if (bytes.includes(0) || locate() !== path || before !== fileStamp(path)) throw Error('文件无效或已更改');
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        outline = parsePlanOutline(content);
        validatedStamp = before;
        Object.assign(result, { status: 'ready', source: 'brain-artifact', filePath: path, truncated: false,
          updatedAt: lstatSync(path).mtime.toISOString(), ...(view === 'content' ? { content } : { outline }) });
      }
    } catch {
      result.status = 'unavailable';
      result.reason = '产物归属不唯一、无法安全读取或超过 128 KiB UTF-8 限制';
    }
    if (!current()) return { status: 'unavailable', owner, revision: 0 };
    entry.stamp = validatedStamp;
    this.watch(entry, targets);
    const signature = (value: unknown) => createHash('sha256').update(JSON.stringify([result.status, result.filePath, value])).digest('hex');
    const summarySignature = signature(outline);
    const contentSignature = signature(content);
    const changed = entry.contentSignature !== contentSignature || entry.summarySignature !== summarySignature;
    if (changed) {
      const notify = entry.contentSignature !== undefined || result.status === 'ready';
      if (notify) {
        this.revision = Math.max(this.revision, Date.now() * 1000);
        if (entry.contentSignature !== contentSignature) entry.contentRevision = ++this.revision;
        if (entry.summarySignature !== summarySignature) entry.summaryRevision = ++this.revision;
      }
      entry.contentSignature = contentSignature;
      entry.summarySignature = summarySignature;
      if (notify) this.changed({ ...owner, revision: Math.max(entry.contentRevision, entry.summaryRevision),
        summaryRevision: entry.summaryRevision, contentRevision: entry.contentRevision });
    }
    return { ...result, summaryRevision: entry.summaryRevision, contentRevision: entry.contentRevision,
      revision: view === 'summary' ? entry.summaryRevision : entry.contentRevision };
  }
}
