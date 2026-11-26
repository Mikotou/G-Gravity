import { mkdtemp, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isUnsafeLocalPath, LocalFileChangedError, openLocalFile, readPrefix } from '../workspace/local-path-safety';

export async function createAccountTempDirectory(parent: string, prefix: 'gravity-login-' | 'gravity-quota-'): Promise<string> {
  const protectedRoot = (dir: string) => isUnsafeLocalPath(dir) || /(?:^|[\\/])antigravity(?:-cli)?(?:[\\/]|$)/i.test(dir);
  const root = resolve(parent);
  if (protectedRoot(root)) throw new Error('临时目录位于受保护路径');
  const canonical = await realpath(root);
  if (protectedRoot(canonical)) throw new Error('临时目录指向受保护路径');
  return mkdtemp(join(canonical, prefix));
}

/** Read only bounded regular files in the freshly created, canonical client temp directory. */
export async function readAccountTempFile(path: string, maxBytes: number): Promise<string> {
  const { handle, stat } = await openLocalFile(path);
  try {
    if (stat.size > maxBytes) throw new Error('临时状态记录超过大小限制');
    const bytes = await readPrefix(handle, stat.size);
    if (bytes.length !== stat.size) throw new LocalFileChangedError();
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}
