import { within } from '../workspace/workspace-files';
import { lstatSync, promises as fs, realpathSync, type Stats } from 'node:fs';
import { dirname, join, parse, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';
import { isPrivateStatePath, readBoundedLocalFile } from '../workspace/local-path-safety';

function canonicalSystemPath(path: string): string {
  const absolute = resolve(path);
  // Darwin's standard temporary directories have OS-owned aliases.
  if (process.platform === 'darwin') return absolute.replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1');
  if (process.platform !== 'win32') return absolute;
  // Windows 8.3 short paths (e.g. RUNNER~1) are non-symlink NTFS aliases; expand only verified non-symlink ancestors.
  const { root } = parse(absolute);
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    const next = join(cursor, parts[i]);
    try {
      if (lstatSync(next).isSymbolicLink()) return join(cursor, ...parts.slice(i));
      cursor = realpathSync.native(next);
    } catch {
      return join(cursor, ...parts.slice(i));
    }
  }
  return cursor;
}

async function checkedStat(file: string): Promise<Stats> {
  if (isForbiddenCredentialOrStatePath(file) || relative(file, await fs.realpath(file)) !== '') throw Error('不安全的数据库路径');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('不安全的数据库文件');
  return stat;
}

async function optionalStat(file: string): Promise<Stats | undefined> {
  try { return await checkedStat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameFile(before?: Stats, after?: Stats): boolean {
  if (!before || !after) return before === after;
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function ensureCacheDirectory(path: string): Promise<void> {
  if (isForbiddenCredentialOrStatePath(path) || isPrivateStatePath(path)) throw Error('不安全的快照缓存目录');
  try {
    if (relative(path, await fs.realpath(path)) !== '' || !(await fs.lstat(path)).isDirectory()) throw Error('快照缓存目录已更改');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await ensureCacheDirectory(dirname(path));
    try { await fs.mkdir(path, { mode: 0o700 }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    if (relative(path, await fs.realpath(path)) !== '' || !(await fs.lstat(path)).isDirectory()) throw Error('快照缓存目录已更改');
  }
}

/** Copy a matching DB/WAL pair into private client storage. SQLite never opens the source. */
export async function withReadonlySqliteSnapshot<T>(
  file: string, sourceRoot: string, cacheDir: string, maxBytes: number, read: (db: DatabaseSync) => T | null
): Promise<T | null> {
  const root = canonicalSystemPath(sourceRoot), source = canonicalSystemPath(file), cache = canonicalSystemPath(cacheDir);
  if (!within(root, source) || within(root, cache) || isPrivateStatePath(cache)) return null;
  let directory: string | undefined, database: DatabaseSync | undefined;
  try {
    const before = await checkedStat(source);
    const walFile = source + '-wal', walBefore = await optionalStat(walFile);
    if (before.size > maxBytes || (walBefore?.size ?? 0) > maxBytes) return null;
    const bytes = await readBoundedLocalFile(source, maxBytes);
    if (bytes.length < 100 || bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') return null;
    const wal = walBefore && (bytes[18] === 2 || bytes[19] === 2) ? await readBoundedLocalFile(walFile, maxBytes) : undefined;
    if (!sameFile(before, await checkedStat(source)) || !sameFile(walBefore, await optionalStat(walFile))) return null;
    if (!wal?.length) { bytes[18] = 1; bytes[19] = 1; }
    await ensureCacheDirectory(cache);
    directory = await fs.mkdtemp(join(cache, 'chk-'));
    const copy = join(directory, 'session.db');
    await fs.writeFile(copy, bytes, { mode: 0o600, flag: 'wx' });
    if (wal?.length) await fs.writeFile(copy + '-wal', wal, { mode: 0o600, flag: 'wx' });
    const sqlite = require('node:sqlite') as typeof import('node:sqlite');
    database = new sqlite.DatabaseSync(copy, { readOnly: true });
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
    return read(database);
  } catch { return null; }
  finally {
    try { database?.close(); } finally {
      if (directory) {
        for (const suffix of ['', '-wal', '-shm', '-journal']) await fs.unlink(join(directory, 'session.db' + suffix)).catch(() => {});
        await fs.rmdir(directory).catch(() => {});
      }
    }
  }
}
