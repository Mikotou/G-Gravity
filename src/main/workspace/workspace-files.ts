import { readBoundedLocalFile } from './local-path-safety';
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isUnsafeLocalPath } from './local-path-safety';

const SKIP = new Set(['.git', 'node_modules', 'dist', '.gemini', 'antigravity-cli', '.ssh', '.aws', '.gnupg', '.env', '.next', '.cache']);
/** 根据相对路径的目录分段判断归属，兼顾同名前缀的相邻目录及 Windows 的跨盘路径。 */
export function within(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
export function safeWorkspacePath(path: string): boolean {
  return !isUnsafeLocalPath(path) && !path.split(/[\\/]/).some(part => SKIP.has(part.toLowerCase()));
}
export class WorkspaceFiles {
  async list(cwd: string, query = ''): Promise<string[]> {
    if (!isAbsolute(cwd) || !safeWorkspacePath(cwd)) throw new Error('工作区路径无效或包含敏感目录');
    const root = await fs.realpath(cwd); if (!safeWorkspacePath(root)) throw new Error('工作区真实路径指向敏感目录');
    // 文件补全采用广度优先遍历。分别限制扫描条目数、目录深度和命中数，大型工作区也能及时返回。
    const queue = [root]; const result: string[] = []; let visited = 0;
    while (queue.length && result.length < 100 && visited < 10000) {
      const directory = queue.shift()!; let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++visited > 10000 || result.length >= 100) break;
        const path = resolve(directory, entry.name);
        if (!safeWorkspacePath(path) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && relative(root, path).split(sep).length < 10) queue.push(path);
        if (entry.isFile()) { const rel = relative(root, path).split(sep).join('/'); if (rel.toLowerCase().includes(query.toLowerCase())) result.push(rel); }
      }
    }
    return result.sort();
  }
  /**
   * 将选中的文件引用转成工作区相对路径和 UTF-8 正文。
   * 目录归属、权限路径、文件类型和体积均在主进程复核。
   */
  async readReference(cwd: string, file: string): Promise<{ path: string; text: string }> {
    if (!isAbsolute(cwd) || !safeWorkspacePath(cwd) || !safeWorkspacePath(file)) throw new Error('拒绝敏感文件引用');
    const root = await fs.realpath(cwd); const target = resolve(root, file);
    if (!within(root, target) || !safeWorkspacePath(root)) throw new Error('文件引用超出工作区');
    // 每个路径分段都拒绝符号链接/Junction，避免穿越到凭据目录。
    let cursor = root;
    for (const part of relative(root, target).split(sep).filter(Boolean)) { cursor = resolve(cursor, part); if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('文件引用不能经过符号链接'); }
    const actual = await fs.realpath(target); if (!within(root, actual) || !safeWorkspacePath(actual)) throw new Error('文件真实路径超出工作区或涉及敏感文件');
    const data = await readBoundedLocalFile(actual, 512 * 1024); if (data.includes(0)) throw new Error('二进制文件不能作为文本引用');
    return { path: relative(root, actual).split(sep).join('/'), text: data.toString('utf8') };
  }
}
