import { constants, lstatSync, realpathSync, type Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';

/** Keep private OS stores out of file inspection, Finder actions and workspace references. */
export function isPrivateStatePath(path: string): boolean {
  return /(?:^|[\\/])(?:\.gemini|Library[\\/]Application Support[\\/]antigravity(?:-cli)?|profiles[\\/]profile-[a-f\d-]{36})(?:[\\/]|$)/i.test(path);
}

export function isUnsafeLocalFile(path: string): boolean {
  if (/[\0\r\n]|^(?:[\\/]{2}|\\\?\?\\)/.test(path)) return true;
  if (process.platform === 'win32' && (path.replace(/^[A-Za-z]:[\\/]/, '').includes(':') ||
      /(?:^|[\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|[\\/]|$)/i.test(path))) return true;
  return isForbiddenCredentialOrStatePath(path) || path.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part)) ||
    /(?:^|[\\/])(?:Library[\\/]Keychains?|Library[\\/]Cookies)(?:[\\/]|$)|\.(?:keychain(?:-db)?|binarycookies)(?:[.\-\\/]|$)/i.test(path) ||
    /(?:^|[\\/._-])(?:oauth2|accessToken|refreshToken|idToken)(?:[\\/._-]|$)/i.test(path);
}

export function isUnsafeLocalPath(path: string): boolean {
  return isUnsafeLocalFile(path) || isPrivateStatePath(path);
}

export class LocalFileChangedError extends Error {
  constructor() { super('读取期间文件路径已更改'); }
}

/** Pin the inspected inode before reading any bytes. A replacement FIFO must not block open(). */
export async function openLocalFile(real: string, before = lstatSync(real)): Promise<{ handle: FileHandle; stat: Stats }> {
  if (!before.isFile()) throw new Error('仅支持普通本地文件');
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(real, flags);
  try {
    const stat = await handle.stat();
    // Electron 35/libuv on Windows can report dev=0 from path stat and the volume serial from fstat.
    const devMismatch = stat.dev !== before.dev && (process.platform !== 'win32' || (before.dev !== 0 && stat.dev !== 0));
    if (!stat.isFile() || stat.ino !== before.ino || devMismatch || relative(real, realpathSync(real)) !== '') {
      throw new LocalFileChangedError();
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Positional reads bound memory even if another process grows the file after stat(). */
export async function readPrefix(handle: FileHandle, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

export const isAnyAbsolutePath = (value: string): boolean =>
  isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');

export async function readBoundedLocalFile(real: string, limit: number): Promise<Buffer> {
  const { handle, stat } = await openLocalFile(real);
  try {
    if (stat.size > limit) throw new Error('文件超过 ' + Math.ceil(limit / 1024) + ' KB 大小限制');
    const data = await readPrefix(handle, stat.size);
    const after = await handle.stat();
    if (data.length !== stat.size || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs ||
        relative(real, realpathSync(real)) !== '' || lstatSync(real).ino !== stat.ino) throw new LocalFileChangedError();
    return data;
  } finally { await handle.close(); }
}
