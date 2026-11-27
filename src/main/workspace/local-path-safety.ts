import { constants, lstatSync, realpathSync, type Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { relative, isAbsolute, join, parse, resolve, sep } from 'node:path';
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

/** Map macOS root system aliases (/tmp, /var, /etc) to their canonical /private targets when SIP-verified. */
export function normalizeDarwinSystemAlias(path: string): string {
  if (process.platform !== 'darwin') return path;
  const match = /^\/(tmp|var|etc)(?=\/|$)/i.exec(path);
  if (!match) return path;
  const alias = '/' + match[1];
  const canonical = '/private/' + match[1].toLowerCase();
  try {
    if (lstatSync(alias).isSymbolicLink() && realpathSync.native(alias) === canonical) {
      return canonical + path.slice(alias.length);
    }
  } catch { /* Fall back to literal path. */ }
  return path;
}

/** Accept alternate case, Unicode normalization or DOS short names only when both spellings identify the same filesystem object. */
export function sameLocalPath(left: string, right: string): boolean {
  const leftPath = normalizeDarwinSystemAlias(resolve(left));
  const rightPath = normalizeDarwinSystemAlias(resolve(right));
  if (leftPath === rightPath) return true;
  if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
  let leftPrefix = parse(leftPath).root, rightPrefix = parse(rightPath).root;
  if (leftPrefix.toLowerCase() !== rightPrefix.toLowerCase()) return false;
  const leftParts = leftPath.slice(leftPrefix.length).split(sep).filter(Boolean);
  const rightParts = rightPath.slice(rightPrefix.length).split(sep).filter(Boolean);
  if (leftParts.length !== rightParts.length) return false;
  try {
    for (let i = 0; i < leftParts.length; i++) {
      const leftName = leftParts[i], rightName = rightParts[i];
      leftPrefix = join(leftPrefix, leftName); rightPrefix = join(rightPrefix, rightName);
      if (leftName === rightName) continue;
      const dosAlias = process.platform === 'win32' && [leftName, rightName].some(name => /~\d+(?:\.|$)/.test(name));
      const sameFolded = process.platform === 'darwin'
        ? leftName.normalize('NFC').toLowerCase() === rightName.normalize('NFC').toLowerCase()
        : leftName.toLowerCase() === rightName.toLowerCase();
      if (!dosAlias && !sameFolded) return false;
      const leftStat = lstatSync(leftPrefix, { bigint: true }), rightStat = lstatSync(rightPrefix, { bigint: true });
      if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink() || !leftStat.ino ||
          leftStat.dev !== rightStat.dev || leftStat.ino !== rightStat.ino) return false;
    }
    return true;
  } catch { return false; }
}

export function localPathMember(root: string, target: string): string | undefined {
  const base = normalizeDarwinSystemAlias(resolve(root));
  const path = normalizeDarwinSystemAlias(resolve(target));
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (path === base || path.startsWith(prefix)) return relative(base, path);
  const volume = parse(path).root;
  const depth = base.slice(parse(base).root.length).split(sep).filter(Boolean).length;
  const parts = path.slice(volume.length).split(sep).filter(Boolean);
  if (parts.length >= depth && sameLocalPath(base, join(volume, ...parts.slice(0, depth)))) return parts.slice(depth).join(sep);
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
    if (!stat.isFile() || stat.ino !== before.ino || devMismatch || relative(real, realpathSync.native(real)) !== '') {
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
        relative(real, realpathSync.native(real)) !== '' || lstatSync(real).ino !== stat.ino) throw new LocalFileChangedError();
    return data;
  } finally { await handle.close(); }
}
