import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';

function checkLocation(path: string): void {
  if (path === parse(path).root || isForbiddenCredentialOrStatePath(path) ||
      /(?:^|[\\/])(?:\.gemini|antigravity(?:-cli)?|\.ssh|\.gnupg|\.aws|Library[\\/]Keychains?)(?:[\\/]|$)/i.test(path)) {
    throw new Error('客户端数据目录不能使用官方凭据或系统状态目录');
  }
  const protectedRoots = process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    : ['/etc', '/private/etc', '/System', '/usr', '/bin', '/sbin', '/dev', '/proc', '/sys', '/boot', '/Library/Keychains'];
  for (const root of protectedRoots) {
    if (!root) continue;
    const suffix = relative(root, path);
    if (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep)) throw new Error('禁止使用系统目录存储客户端数据');
  }
}

/** Resolve existing ancestors before Electron places its lock or creates the data directory. */
export function validateUserDataDirectory(value: string): string {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value) || value.split(/[\\/]/).includes('..') ||
      (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || /[:*?"<>|]|[. ](?:[\\/]|$)|(?:^|[\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.\\/]|$)/i.test(value.slice(2))))) {
    throw new Error('客户端数据目录必须是合法的本地绝对路径');
  }
  const target = resolve(value);
  checkLocation(target);
  const missing: string[] = [];
  let ancestor = target;
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const canonical = join(realpathSync.native(ancestor), ...missing);
  checkLocation(canonical);
  return canonical;
}
