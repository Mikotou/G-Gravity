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

function findAllProtoSubmessages(buf: Buffer, targetField: number): Buffer[] {
  let pos = 0;
  const found: Buffer[] = [];
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
      if (field === targetField) found.push(slice);
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

function isValidCheckpointLimit(limit: number | null): limit is number {
  return limit !== null && Number.isFinite(limit) && limit >= 16_000 && limit <= 2_000_000;
}

/**
 * 从 `executor_metadata` 二进制负载解析压缩触发上限：
 * 1) 首选标准 Protobuf 路径：`cascade_config (10) -> checkpoint_config (2) -> max_token_limit (5)`；
 * 2) 兼容服务端随实验下发的 `CASCADE_USE_EXPERIMENT_CHECKPOINTER` JSON 文本（`"max_token_limit":"512000"`）。
 */
export function decodeCheckpointMaxTokenLimit(executorMetadataBlob: Buffer): number | null {
  const cascadeConfigs = findAllProtoSubmessages(executorMetadataBlob, 10);
  for (let i = cascadeConfigs.length - 1; i >= 0; i -= 1) {
    const checkpointConfigs = findAllProtoSubmessages(cascadeConfigs[i], 2);
    for (let j = checkpointConfigs.length - 1; j >= 0; j -= 1) {
      const limit = findProtoVarint(checkpointConfigs[j], 5);
      if (isValidCheckpointLimit(limit)) {
        return limit;
      }
    }
  }
  // 兜底：若二进制内嵌 `CASCADE_USE_EXPERIMENT_CHECKPOINTER` 或 checkpoint JSON 字符串，直接提取其中的 max_token_limit
  const asUtf8 = executorMetadataBlob.toString('utf8');
  const jsonMatches = [...asUtf8.matchAll(/"max_token_limit"\s*:\s*"?(\d{5,7})"?/g)];
  for (let i = jsonMatches.length - 1; i >= 0; i -= 1) {
    const parsed = Number(jsonMatches[i][1]);
    if (isValidCheckpointLimit(parsed)) {
      return parsed;
    }
  }
  return null;
}

const MAX_SESSION_DB_BYTES = 128 * 1024 * 1024;

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
  if (isForbiddenCredentialOrStatePath(cacheDir)) return null;

  const baseRoots = isolatedAppDataDir
    ? [resolve(isolatedAppDataDir)]
    : [
        join(homeDir || homedir(), '.gemini', 'antigravity-cli'),
        join(homeDir || homedir(), '.gemini', 'antigravity'),
      ];

  let sourceDb = '';
  let bytes: Buffer | undefined;
  let walBytes: Buffer | undefined;
  for (const baseRoot of baseRoots) {
    const candidate = join(baseRoot, 'conversations', `${sessionId}.db`);
    if (isForbiddenCredentialOrStatePath(candidate)) continue;
    try {
      const st = await fs.lstat(candidate);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SESSION_DB_BYTES) continue;
      const buf = await fs.readFile(candidate);
      if (buf.subarray(0, 16).toString() !== 'SQLite format 3\0') continue;
      sourceDb = candidate;
      bytes = buf;
      if (buf[18] === 2 || buf[19] === 2) {
        try {
          const walPath = `${candidate}-wal`;
          if (!isForbiddenCredentialOrStatePath(walPath)) {
            const wst = await fs.lstat(walPath);
            if (!wst.isSymbolicLink() && wst.isFile() && wst.size <= MAX_SESSION_DB_BYTES) {
              walBytes = await fs.readFile(walPath);
            }
          }
        } catch {
          /* WAL 不存在时仅规范化内存副本头 */
        }
      }
      break;
    } catch {
      /* 尝试下一候选目录 */
    }
  }
  if (!sourceDb || !bytes) return null;

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
    // 优先倒序检索最近 16 条记录（避免末尾状态更新行省略 cascade_config），若均缺失再回退首部 4 条。
    const recentRows = db
      .prepare('SELECT data FROM executor_metadata ORDER BY idx DESC LIMIT 16')
      .all() as Array<{ data?: Uint8Array | Buffer }>;
    for (const row of recentRows) {
      if (!row?.data) continue;
      const found = decodeCheckpointMaxTokenLimit(Buffer.from(row.data));
      if (found !== null) return found;
    }
    const headRows = db
      .prepare('SELECT data FROM executor_metadata ORDER BY idx ASC LIMIT 4')
      .all() as Array<{ data?: Uint8Array | Buffer }>;
    for (const row of headRows) {
      if (!row?.data) continue;
      const found = decodeCheckpointMaxTokenLimit(Buffer.from(row.data));
      if (found !== null) return found;
    }
    return null;
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
