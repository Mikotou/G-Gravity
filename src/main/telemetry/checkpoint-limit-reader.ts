import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';

/** 读取 Protobuf 的变长整数并返回下一字段的位置。截断或位宽超限时用 null 结束当前解析。 */
function readVarint(buf: Buffer, offset: number): { value: number; next: number } | null {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: Number(result), next: pos };
    }
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function findProtoSubmessage(buf: Buffer, targetField: number): Buffer | null {
  let pos = 0;
  let found: Buffer | null = null;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag || tag.value === 0) break;
    pos = tag.next;
    const field = tag.value >> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      pos = v.next;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len || len.next + len.value > buf.length) break;
      const slice = buf.subarray(len.next, len.next + len.value);
      pos = len.next + len.value;
      if (field === targetField) found = slice;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      break;
    }
  }
  return found;
}

function findProtoVarint(buf: Buffer, targetField: number): number | null {
  let pos = 0;
  let found: number | null = null;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag || tag.value === 0) break;
    pos = tag.next;
    const field = tag.value >> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      pos = v.next;
      if (field === targetField) found = v.value;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len || len.next + len.value > buf.length) break;
      pos = len.next + len.value;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      break;
    }
  }
  return found;
}

/**
 * 从 `executor_metadata` 二进制负载解析 `cascade_config (10) -> checkpoint_config (2) -> max_token_limit (5)`。
 */
export function decodeCheckpointMaxTokenLimit(executorMetadataBlob: Buffer): number | null {
  const cascadeConfig = findProtoSubmessage(executorMetadataBlob, 10);
  if (!cascadeConfig) return null;
  const checkpointConfig = findProtoSubmessage(cascadeConfig, 2);
  if (!checkpointConfig) return null;
  const limit = findProtoVarint(checkpointConfig, 5);
  // 仅采纳处于客户端可识别范围内的阈值。返回 null 时调用者保留已有的窗口估计值。
  if (limit !== null && limit >= 16_000 && limit <= 2_000_000) {
    return limit;
  }
  return null;
}

/**
 * 纯只读提取会话数据库 `<sessionId>.db` 中 `executor_metadata -> cascade_config.checkpoint_config.max_token_limit`：
 * 仅在客户端专属缓存目录建立只读临时快照后立即销毁，对源目录执行 0 字节写入。
 */
export async function readSessionCheckpointLimit(options: {
  sessionId: string;
  cacheDir: string;
  isolatedAppDataDir?: string;
  homeDir?: string;
}): Promise<number | null> {
  const { sessionId, cacheDir, isolatedAppDataDir, homeDir } = options;
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) return null;

  const baseRoot = isolatedAppDataDir
    ? resolve(isolatedAppDataDir)
    : join(homeDir || homedir(), '.gemini', 'antigravity-cli');
  const sourceDb = join(baseRoot, 'conversations', `${sessionId}.db`);
  if (isForbiddenCredentialOrStatePath(sourceDb) || isForbiddenCredentialOrStatePath(cacheDir)) {
    return null;
  }

  let bytes: Buffer;
  let walBytes: Buffer | undefined;
  try {
    const st = await fs.lstat(sourceDb);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 32 * 1024 * 1024) return null;
    bytes = await fs.readFile(sourceDb);
    if (bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') return null;
    if (bytes[18] === 2 || bytes[19] === 2) {
      try {
        const walPath = `${sourceDb}-wal`;
        if (!isForbiddenCredentialOrStatePath(walPath)) {
          const wst = await fs.lstat(walPath);
          if (!wst.isSymbolicLink() && wst.isFile() && wst.size <= 32 * 1024 * 1024) {
            walBytes = await fs.readFile(walPath);
          }
        }
      } catch {
        /* WAL 不存在时仅规范化内存副本头 */
      }
    }
  } catch {
    return null;
  }

  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const snapDir = join(resolve(cacheDir), `chk-${randomUUID()}`);
  await fs.mkdir(snapDir, { mode: 0o700 });
  const snapDb = join(snapDir, 'session.db');
  // 更改日志模式标记只作用于内存副本。带 WAL 的快照保留原标记，让 SQLite 读取配套日志。
  const copy = Buffer.from(bytes);
  if (!walBytes) {
    copy[18] = 1;
    copy[19] = 1;
  }

  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    await fs.writeFile(snapDb, copy, { mode: 0o600, flag: 'wx' });
    if (walBytes) await fs.writeFile(`${snapDb}-wal`, walBytes, { mode: 0o600, flag: 'wx' });
    db = new DatabaseSync(snapDb, { open: true, readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='executor_metadata'")
      .get();
    if (!hasTable) return null;
    // 按 idx 取最近一次记录。空表、缺字段及不可解析的内容均可回到模型默认窗口。
    const row = db.prepare('SELECT data FROM executor_metadata ORDER BY idx DESC LIMIT 1').get() as
      | { data?: Uint8Array | Buffer }
      | undefined;
    if (!row?.data) return null;
    return decodeCheckpointMaxTokenLimit(Buffer.from(row.data));
  } catch {
    return null;
  } finally {
    db?.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await fs.unlink(`${snapDb}${suffix}`).catch(() => {});
    }
    await fs.rmdir(snapDir).catch(() => {});
  }
}
