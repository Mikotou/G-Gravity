import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, appendFileSync, unlinkSync, openSync,
  closeSync, readSync, fstatSync,
} from 'node:fs';
import { writeFile, copyFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { validateUserDataDirectory } from './data-directory';
import { join } from 'node:path';

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const AUDIT_RECEIPTS = 'audit-grant-receipts.json';
const retryDelaysMs = [10, 25, 50, 100, 200];
const retryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface PendingWrite { fileName: string; data: unknown; timer?: NodeJS.Timeout }

export interface JournalRecordPosition { offset: number; length: number; digest: string }

/** 这些用户核心配置文件在成功落盘后额外保留一份 .bak 影子副本，防止升级重启瞬间锁定或异常断电导致配置回退默认。 */
const BACKED_UP_SETTINGS_FILES = new Set([
  'preferences.json',
  'approval-config.json',
  'translation-config.json',
  'layout.json',
  'window-state.json',
  'profiles.json',
  'model-rate-cards.json',
  'external-reviewer-totals.json',
  'external-translator-totals.json',
  'v2-external-reviewer-totals.json',
  'v2-external-translator-totals.json',
  'v2-session-telemetry.json',
  'v2-compactions.json',
  'skill-preferences.json',
  'titles.json',
]);

function keepsShadowCopy(name: string): boolean {
  return BACKED_UP_SETTINGS_FILES.has(name.toLowerCase()) || /^(?:message-index-v2|owned-sessions|conversation-trees|inspector-states)-[a-z0-9-]+\.json$/i.test(name) ||
    /^telemetry-stream-[a-f0-9]{64}\.json$/i.test(name);
}

function isTransientSharingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EBUSY' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
}

function withWindowsRetry<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      const delay = retryDelaysMs[attempt];
      if (!isTransientSharingError(error) || delay === undefined) throw error;
      Atomics.wait(retryWait, 0, 0, delay);
    }
  }
}

export async function withWindowsRetryAsync<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const backoff = retryDelaysMs[attempt];
      if (!isTransientSharingError(error) || backoff === undefined) throw error;
      await delay(backoff);
    }
  }
}

function writeAtomicFile(target: string, data: Buffer | string): void {
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    withWindowsRetry(() => writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' }));
    withWindowsRetry(() => renameSync(temporary, target));
  } catch (error) {
    try { withWindowsRetry(() => unlinkSync(temporary)); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

/** 只管理调用者指定的客户端专属目录，不探测官方账号或配置目录。 */
export class ClientStore {
  readonly dataDir: string;
  private readonly pending = new Map<string, PendingWrite>();
  private readonly writing = new Map<string, Promise<void>>();
  constructor(dataDir: string) {
    this.dataDir = validateUserDataDirectory(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
  }
  // 只接受当前目录下的 JSON 或 JSONL 名称，所有读写共用这一处路径约束。
  private path(name: string): string {
    if (!/^[a-z0-9-]+\.(?:json|jsonl)$/i.test(name)) throw new Error('无效的客户端存储文件名');
    return join(this.dataDir, name);
  }
  // 专用于操作系统加密密文（如 Electron safeStorage 加密后的外部复核 API Key）
  private secretPath(name: string): string {
    if (!/^[a-z0-9-]+\.enc$/i.test(name)) throw new Error('无效的加密存储文件名');
    return join(this.dataDir, name);
  }
  read<T>(name: string, fallback: T): T {
    const target = this.path(name);
    try {
      return JSON.parse(withWindowsRetry(() => readFileSync(target, 'utf8'))) as T;
    } catch {
      if (keepsShadowCopy(name)) {
        try {
          return JSON.parse(withWindowsRetry(() => readFileSync(`${target}.bak`, 'utf8'))) as T;
        } catch {
          return fallback;
        }
      }
      return fallback;
    }
  }
  /** Permission records never use older copies. Missing or damaged JSON grants nothing, an I/O failure must not be overwritten. */
  readGrantSnapshot<T>(name: string): T | null {
    try {
      return JSON.parse(withWindowsRetry(() => readFileSync(this.path(name), 'utf8'))) as T;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  /** Older releases stored inspector and swarm records for every profile in a single file. */
  readSessionRecords<T>(name: string, legacyName: string, owned?: ReadonlySet<string>): Record<string, T> {
    const saved = this.read<Record<string, T> | null>(name, null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
    if (!owned) return {};
    const legacy = this.read<Record<string, T> | null>(legacyName, null);
    return Object.fromEntries(Object.entries(legacy || {}).filter(([id]) => owned.has(id)));
  }
  /** 将完整 JSON 写到同目录临时文件，再改名替换目标。序列化或写入中途出错时，旧文件仍可读取。 */
  write(name: string, value: unknown, durability: 'immediate' | 'queued' = 'immediate'): void {
    if (durability === 'queued') { this.writeDebounced(name, value, 0); return; }
    const target = this.path(name);
    const contents = JSON.stringify(value, null, 2);
    writeAtomicFile(target, contents);
    const pending = this.pending.get(this.fileKey(name));
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(this.fileKey(name));
    }
    if (pending || keepsShadowCopy(name)) {
      try { writeAtomicFile(target + '.bak', contents); } catch { /* Best-effort shadow copy. */ }
    }
  }
  private fileKey(name: string): string {
    return process.platform === 'win32' || process.platform === 'darwin' ? name.toLowerCase() : name;
  }

  writeDebounced(fileName: string, data: unknown, delayMs = 300): void {
    const name = this.fileKey(fileName);
    this.path(name);
    const previous = this.pending.get(name);
    const pending: PendingWrite = { fileName, data, timer: previous?.timer };
    this.pending.set(name, pending);
    if (pending.timer || this.writing.has(name)) return;
    const timer = setTimeout(() => this.startPending(name), delayMs);
    timer.unref();
    pending.timer = timer;
  }

  private startPending(name: string): void {
    const pending = this.pending.get(name);
    if (!pending || this.writing.has(name)) return;
    pending.timer = undefined;
    const operation = this.writeInBackground(name, pending).finally(() => {
      this.writing.delete(name);
      const next = this.pending.get(name);
      if (next && next !== pending && !next.timer) this.startPending(name);
    });
    this.writing.set(name, operation);
  }
  async drain(): Promise<void> {
    this.flushPending();
    while (this.writing.size) await Promise.all(this.writing.values());
  }

  private async writeInBackground(name: string, pending: PendingWrite): Promise<void> {
    const target = this.path(pending.fileName);
    const temporary = target + '.' + randomUUID() + '.tmp';
    const backup = temporary + '.bak';
    try {
      await writeFile(temporary, JSON.stringify(pending.data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const hasBackup = await copyFile(temporary, backup).then(() => true, () => false);
      // Test ownership and rename in the same JS turn. A flush, revocation or newer write can
      // supersede this revision even while the temporary file is being written or retried.
      await withWindowsRetryAsync(async () => {
        if (this.pending.get(name) !== pending) return;
        renameSync(temporary, target);
        if (hasBackup) {
          try { renameSync(backup, target + '.bak'); } catch { /* Shadow copy is best effort. */ }
        }
        this.pending.delete(name);
      });
    } catch {
      // Keep the dirty value. An explicit flush reports persistent failures to its caller.
    } finally {
      await Promise.all([unlink(temporary).catch(() => {}), unlink(backup).catch(() => {})]);
    }
  }

  flushPending(fileName?: string): void {
    const names = fileName === undefined ? [...this.pending.keys()] : [this.fileKey(fileName)];
    const errors: unknown[] = [];
    for (const name of names) {
      const pending = this.pending.get(name);
      if (!pending) continue;
      clearTimeout(pending.timer);
      pending.timer = undefined;
      try { this.write(pending.fileName, pending.data); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }

  dispose(): void { this.flushPending(); }

  readEncryptedBlob(name: string): Buffer | null {
    try {
      return withWindowsRetry(() => readFileSync(this.secretPath(name)));
    } catch {
      return null;
    }
  }
  writeEncryptedBlob(name: string, data: Buffer): void {
    writeAtomicFile(this.secretPath(name), data);
  }
  deleteEncryptedBlob(name: string): void {
    try {
      withWindowsRetry(() => unlinkSync(this.secretPath(name)));
    } catch {
      /* 文件不存在时忽略 */
    }
  }
  append(name: string, value: unknown): void {
    const line = JSON.stringify(value) + '\n';
    const separator = name === 'audit.jsonl' ? this.prepareAuditAppend(Buffer.byteLength(line)).separator : '';
    withWindowsRetry(() => appendFileSync(this.path(name), separator + line, { encoding: 'utf8', mode: 0o600 }));
  }
  private journalEnd(name: string): { size: number; separator: string } {
    let fd: number | undefined;
    try {
      fd = withWindowsRetry(() => openSync(this.path(name), 'r'));
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size && readSync(fd, last, 0, 1, size - 1) !== 1) throw new Error('无法读取审计日志末尾');
      // A new record must neither join a torn line nor supply a missing commit newline for an interrupted grant.
      return { size, separator: size && last[0] !== 10 ? ' [incomplete audit record]\n' : '' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { size: 0, separator: '' };
      throw err;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  nextJournalRecord(name: string, value: unknown): JournalRecordPosition {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    const { size, separator } = name === 'audit.jsonl' ? this.prepareAuditAppend(bytes.length) : this.journalEnd(name);
    return { offset: size + Buffer.byteLength(separator), length: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
  }
  hasJournalRecord(name: string, position: JournalRecordPosition): boolean {
    if (!position || !Number.isSafeInteger(position.offset) || position.offset < 0 ||
        !Number.isSafeInteger(position.length) || position.length < 1 || !/^[a-f0-9]{64}$/.test(position.digest)) return false;
    if (name === 'audit.jsonl' && this.readGrantSnapshot<string[]>(AUDIT_RECEIPTS)?.includes(this.receiptKey(position))) return true;
    let fd: number | undefined;
    try {
      fd = withWindowsRetry(() => openSync(this.path(name), 'r'));
      const digest = createHash('sha256');
      const buf = Buffer.allocUnsafe(Math.min(position.length, 32768));
      let total = 0;
      while (total < position.length) {
        const read = readSync(fd, buf, 0, Math.min(buf.length, position.length - total), position.offset + total);
        if (!read) return false;
        digest.update(buf.subarray(0, read));
        total += read;
      }
      return digest.digest('hex') === position.digest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  private receiptKey(record: JournalRecordPosition): string {
    return [record.offset, record.length, record.digest].join(':');
  }

  private prepareAuditAppend(bytes: number): { size: number; separator: string } {
    const name = 'audit.jsonl';
    if (bytes > MAX_AUDIT_BYTES) throw new Error('单条审批审计记录超过大小限制');
    const end = this.journalEnd(name);
    const capacity = MAX_AUDIT_BYTES - bytes - Buffer.byteLength(end.separator);
    if (end.size <= capacity) return end;

    // Each profile can have one committed grant whose recovery still refers to an offset in
    // the old journal. Preserve just its verified receipt before moving any offsets.
    const receipts: string[] = [];
    for (const file of readdirSync(this.dataDir)) {
      if (!/^approval-grants-[a-f0-9]{64}\.json$/.test(file)) continue;
      const record = this.readGrantSnapshot<{ pending?: { audit?: JournalRecordPosition } }>(file)?.pending?.audit;
      if (record && this.hasJournalRecord(name, record)) receipts.push(this.receiptKey(record));
    }
    this.write(AUDIT_RECEIPTS, receipts);
    const keepBytes = Math.max(0, Math.min(MAX_AUDIT_BYTES / 2, capacity));
    writeAtomicFile(this.path(name), this.tailBytes(name, 2000, keepBytes));
    return this.journalEnd(name);
  }

  // Walk backwards from EOF. Decode UTF-8 only after joining complete lines, including
  // lines that straddle chunks. A giant or torn leading record cannot exhaust memory.
  private tailBytes(name: string, limit: number, byteLimit: number): Buffer {
    const fd = withWindowsRetry(() => openSync(this.path(name), 'r'));
    try {
      const size = fstatSync(fd).size;
      const floor = Math.max(0, size - byteLimit);
      const chunks: Buffer[] = [];
      let lines = 0, pos = size;
      while (pos > floor) {
        const length = Math.min(16384, pos - floor);
        pos -= length;
        const chunk = Buffer.allocUnsafe(length);
        if (readSync(fd, chunk, 0, length, pos) !== length) throw new Error('读取日志期间文件已更改');
        for (let i = chunk.length - 1; i >= 0; i--) {
          if (chunk[i] === 10 && pos + i !== size - 1 && ++lines === limit) {
            chunks.push(chunk.subarray(i + 1));
            return Buffer.concat(chunks.reverse());
          }
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks.reverse());
      if (!floor) return bytes;
      const first = bytes.indexOf(10);
      return first < 0 ? Buffer.alloc(0) : bytes.subarray(first + 1);
    } finally { closeSync(fd); }
  }

  removeMessagePages(prefix: string, keep?: ReadonlySet<string>): void {
    if (!/^messages-page-[a-f0-9]{64}-$/.test(prefix)) throw new Error('无效的历史消息索引');
    for (const name of readdirSync(this.dataDir)) {
      if (!keep?.has(name) && name.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(name.slice(prefix.length))) withWindowsRetry(() => unlinkSync(this.path(name)));
    }
  }
  /** 仅解析末尾指定行数，按原有顺序返回。单行损坏时仍保留同一批次中的其他有效记录。 */
  readTailLines<T>(name: string, limit = 500): T[] {
    if (!Number.isFinite(limit) || limit < 1) return [];
    try {
      return this.tailBytes(name, Math.floor(limit), MAX_AUDIT_BYTES).toString('utf8').trimEnd().split('\n').flatMap(line => {
        try { return [JSON.parse(line) as T]; } catch { return []; }
      });
    } catch { return []; }
  }
}
