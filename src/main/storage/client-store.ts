import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

const renameDelaysMs = [10, 25, 50, 100, 200];
const renameWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function replaceSnapshot(temporary: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const sharingError = code === 'EBUSY' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
      const delay = renameDelaysMs[attempt];
      if (!sharingError || delay === undefined) throw error;
      // Short-lived Windows file handles can prevent replacement. Existing callers require a synchronous commit.
      Atomics.wait(renameWait, 0, 0, delay);
    }
  }
}

/** 只管理调用者指定的客户端专属目录，不探测官方账号或配置目录。 */
export class ClientStore {
  readonly dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    if (/(^|[\\/])(?:\.gemini|antigravity-cli)(?:[\\/]|$)/i.test(this.dataDir)) {
      throw new Error('客户端数据目录不能使用官方凭据或内部状态目录');
    }
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
  }
  // 只接受当前目录下的 JSON 或 JSONL 名称，所有读写共用这一处路径约束。
  private path(name: string): string {
    if (!/^[a-z0-9-]+\.(?:json|jsonl)$/i.test(name)) throw new Error('无效的客户端存储文件名');
    return join(this.dataDir, name);
  }
  read<T>(name: string, fallback: T): T {
    try { return JSON.parse(readFileSync(this.path(name), 'utf8')) as T; }
    catch { return fallback; }
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
  write(name: string, value: unknown): void {
    const target = this.path(name);
    const contents = JSON.stringify(value, null, 2);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      replaceSnapshot(temporary, target);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Preserve the original write error. */ }
      throw error;
    }
  }
  append(name: string, value: unknown): void {
    appendFileSync(this.path(name), `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  /** 仅解析末尾指定行数，按原有顺序返回。单行损坏时仍保留同一批次中的其他有效记录。 */
  lines<T>(name: string, limit = 500): T[] {
    try {
      return readFileSync(this.path(name), 'utf8').trim().split('\n').slice(-limit).flatMap(line => {
        try { return [JSON.parse(line) as T]; } catch { return []; }
      });
    } catch { return []; }
  }
}
