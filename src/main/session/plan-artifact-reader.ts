import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, watch, type BigIntStats, type FSWatcher } from 'node:fs';
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
  directories: Map<string, string>;
  timer?: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
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
  // Session IDs are opaque even on filesystems that resolve paths case-insensitively.
  if (directory && basename(real) !== basename(path)) return;
  if (!directory && basename(dirname(real)) !== basename(dirname(path))) throw Error('产物会话目录不匹配');
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

function directoryIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode].join(':');
}

export class PlanArtifactReader {
  private entries = new Map<string, Observation>();
  private revision = 0;
  constructor(private context: (owner: Owner) => Context | undefined, private changed: (event: PlanArtifactChangedEvent) => void) {}

  private forget(entry: Observation): void {
    clearTimeout(entry.timer);
    clearTimeout(entry.settleTimer);
    entry.settleTimer = undefined;
    for (const watcher of entry.watchers.values()) watcher.close();
    entry.watchers.clear();
    if (this.entries.get(entry.owner.sessionId) === entry) this.entries.delete(entry.owner.sessionId);
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
      entry = { owner, contentRevision: 0, summaryRevision: 0, watchers: new Map(), directories: new Map() };
    }
    this.entries.delete(owner.sessionId);
    this.entries.set(owner.sessionId, entry);
    return entry;
  }

  observe(owner: Owner): void {
    const context = this.context(owner);
    if (!context) return;
    const previous = this.entries.get(owner.sessionId)?.owner;
    if (previous?.profileId !== owner.profileId || previous?.epoch !== context.epoch) {
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
  private watch(entry: Observation, key: string, dir: string, child: string): boolean {
    if (entry.watchers.has(key)) return false;
    const notice = () => {
      if (this.entries.get(entry.owner.sessionId) === entry) this.notice(entry.owner.sessionId);
    };
    try {
      const sessionDirectory = child === entry.owner.sessionId && basename(dir).toLowerCase() === 'brain';
      const childPath = join(dir, child);
      const watcher = watch(dir, { persistent: false }, (event, filename) => {
        if (filename && (sessionDirectory ? filename !== child : filename.toLowerCase() !== child.toLowerCase())) return;
        // NTFS also signals directory mtime changes to parents. The child watcher covers its contents.
        const identity = filename && event === 'change' && entry.directories.get(childPath);
        if (identity) {
          try { if (directoryIdentity(lstatSync(childPath, { bigint: true })) === identity) return; }
          catch { /* Recheck a removed or inaccessible directory. */ }
        }
        notice();
      });
      watcher.on('error', () => {
        watcher.close();
        if (entry.watchers.get(key) === watcher) { entry.watchers.delete(key); notice(); }
      });
      entry.watchers.set(key, watcher);
      return true;
    } catch { return false; /* A force refresh always rechecks the actual file. */ }
  }

  async get(input: GetSessionPlanArtifactInput & Pick<Owner, 'epoch'>): Promise<PlanArtifactSnapshot> {
    const owner: Owner = { profileId: input?.profileId, sessionId: input?.sessionId, epoch: input?.epoch };
    const view = input?.view ?? 'summary';
    const denied = (): PlanArtifactSnapshot => ({ status: 'unavailable', owner, view, epoch: owner.epoch,
      revision: 0, reason: '产物不属于当前会话或视图无效' });
    if (!/^[a-z0-9_-]{1,100}$/i.test(owner.sessionId ?? '') || typeof owner.sessionId !== 'string' ||
        !['summary', 'content'].includes(view)) return denied();
    const context = this.context(owner);
    if (!context || (owner.epoch !== undefined && owner.epoch !== context.epoch)) {
      const existing = this.entries.get(owner.sessionId);
      if (existing && this.context(existing.owner)?.epoch !== existing.owner.epoch) this.forget(existing);
      return denied();
    }
    owner.epoch = context.epoch;
    const entry = this.observation(owner);
    while (entry.reading) await entry.reading;
    const current = () => this.entries.get(owner.sessionId) === entry && this.context(owner)?.epoch === context.epoch;
    if (!current()) { this.forget(entry); return denied(); }
    // An explicit read supersedes any queued observe/debounce timer armed before this read began.
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const reading = this.read(entry, context, view, current, input.knownRevision);
    entry.reading = reading;
    try {
      const result = await reading;
      if (!current()) { this.forget(entry); return denied(); }
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
    const targets = new Set<string>();
    const directories = new Map<string, string>();
    let addedWatcher = false;
    const observe = (dir: string, child: string) => {
      // A directory replaced at the same pathname needs a watcher on its new inode.
      const stat = lstatSync(dir, { bigint: true });
      const key = JSON.stringify([join(dir, child), String(stat.dev), String(stat.ino)]);
      targets.add(key);
      // Subscribe before probing the child, including when it has yet to be created.
      if (this.watch(entry, key, dir, child)) addedWatcher = true;
      if (entry.watchers.has(key)) directories.set(dir, directoryIdentity(stat));
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
          return { ...result, status: 'unchanged', source: 'brain-artifact', filePath: path, revision,
            contentRevision: entry.contentRevision, summaryRevision: entry.summaryRevision };
        }
        const bytes = await readBoundedLocalFile(path, PLAN_ARTIFACT_MAX_BYTES, true);
        if (!current()) return { status: 'unavailable', owner, revision: 0 };
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
    } finally {
      if (!current()) this.forget(entry);
      else {
        entry.directories = directories;
        for (const [key, watcher] of entry.watchers) {
          if (!targets.has(key)) { watcher.close(); entry.watchers.delete(key); }
        }
        // Darwin's FSEvents stream can miss writes immediately after fs.watch returns.
        if (process.platform === 'darwin' && addedWatcher) {
          clearTimeout(entry.settleTimer);
          entry.settleTimer = setTimeout(() => {
            entry.settleTimer = undefined;
            if (this.entries.get(owner.sessionId) === entry) void this.get(entry.owner).catch(() => {});
          }, 120);
          entry.settleTimer.unref();
        }
      }
    }
    if (!current()) return { status: 'unavailable', owner, revision: 0 };
    entry.stamp = validatedStamp;
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
