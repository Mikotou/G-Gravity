import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GRAVITY_BUILTIN_CAPABILITIES, isSafePluginTarget, isSafeMcpServerName } from '../../shared/plugins-contract';
import type { PluginsManagerSnapshot, PluginActionInput, McpActionInput, DiscoveredSkillItem, InstalledPluginItem, ConfiguredMcpServerItem } from '../../shared/plugins-contract';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';
import { discoverAgyBinary } from '../acp/acp-client';
import { ClientStore } from '../storage/client-store';
import { within } from '../workspace/workspace-files';

export type CliExecutor = (binary: string, args: string[], options: { shell: false; cwd?: string; timeout: number }) => Promise<{ stdout: string; stderr?: string }>;
export const executeOfficialCli: CliExecutor = (binary, args, options) => new Promise((resolve, reject) => {
  execFile(binary, args, { ...options, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error('官方管理命令未成功完成，请核对输入或通过官方 CLI 查看原因'));
    else resolve({ stdout, stderr });
  });
});
function sanitizeOutput(value: string): string { return value.replace(/(bearer\s+)[\w.\-+/=]+/gi, '$1[已隐藏]').replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[已隐藏]').replace(/(https?:\/\/)[^/\s"']+:[^@\s"']+@/gi, '$1[已隐藏]@').slice(0, 50000); }
export interface PluginsManagerOptions { store: ClientStore; binaryPath?: string; executor?: CliExecutor; homeDir?: string }
export class PluginsManager {
  private snapshot: PluginsManagerSnapshot = { builtins: GRAVITY_BUILTIN_CAPABILITIES, plugins: [], mcpServers: [], skills: [], refreshedAt: new Date().toISOString() };
  private skillPrefs: Record<string, boolean>;
  private busy = false;
  private workspaceCwd?: string;
  constructor(private options: PluginsManagerOptions) { this.skillPrefs = options.store.read('skill-preferences.json', {}); }
  /** 启动快照只复制现有内存数据。设置页请求刷新时才会运行官方列表命令。 */
  getCachedSnapshot(): PluginsManagerSnapshot { return structuredClone(this.snapshot); }
  private async run(args: string[]): Promise<string> {
    const binary = this.options.executor ? this.options.binaryPath || 'agy' : discoverAgyBinary(this.options.binaryPath);
    const result = await (this.options.executor || executeOfficialCli)(binary, args, { shell: false, cwd: this.workspaceCwd, timeout: 30000 });
    return sanitizeOutput(result.stdout || result.stderr || '');
  }
  /** 让操作和随后刷新共用一次互斥区间。并发请求立即收到繁忙提示，异常也会释放占用。 */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> { if (this.busy) throw new Error('另一条 Plugins/MCP 管理命令正在执行'); this.busy = true; try { return await fn(); } finally { this.busy = false; } }
  async getSnapshot(workspaceCwd?: string): Promise<PluginsManagerSnapshot> {
    this.workspaceCwd = workspaceCwd;
    return this.exclusive(() => this.refresh());
  }
  private async refresh(): Promise<PluginsManagerSnapshot> {
    const output = await this.run(['plugin', 'list', '--json']);
    try {
      const data = JSON.parse(output); const plugins = Array.isArray(data) ? data : data.plugins || [];
      this.snapshot.plugins = plugins.filter((item: any) => typeof item?.name === 'string').map((item: any): InstalledPluginItem => ({ name: item.name, version: item.version, enabled: item.enabled !== false, description: item.description, marketplace: item.marketplace, path: item.path }));
    } catch { this.snapshot.plugins = []; }
    const mcp = await this.run(['mcp', 'list']); this.snapshot.mcpServers = this.parseMcpList(mcp);
    this.snapshot.skills = await this.scanSkills(this.workspaceCwd); this.snapshot.lastCommandOutput = `${output}\n${mcp}`.trim(); this.snapshot.refreshedAt = new Date().toISOString(); return this.getCachedSnapshot();
  }
  /** 兼容 MCP 列表的结构化和文本两种输出。解析后的条目共享同一种界面模型。 */
  parseMcpList(output: string): ConfiguredMcpServerItem[] {
    try {
      const data = JSON.parse(output); const servers = data.mcpServers || data.servers || data;
      const list = Array.isArray(servers) ? servers : Object.entries(servers).map(([name, value]) => ({ name, ...(value as object) }));
      return list.filter(item => isSafeMcpServerName(item?.name)).map(item => ({ name: item.name, type: item.type === 'http' || item.url ? 'http' : 'stdio', commandOrUrl: item.url || item.command || item.commandOrUrl || '', args: Array.isArray(item.args) ? item.args : [], enabled: item.enabled !== false && item.disabled !== true, status: item.status }));
    } catch {
      return output.split(/\r?\n/).flatMap(line => {
        const match = /^\s*(?:[-*]\s+)?([\w.-]+)\s*:\s*(.+)$/.exec(line); if (!match || !isSafeMcpServerName(match[1])) return [];
        return [{ name: match[1], type: /^https?:\/\//.test(match[2]) ? 'http' as const : 'stdio' as const, commandOrUrl: match[2], args: [], enabled: !/disabled/i.test(match[2]), status: '官方 CLI 列表（文本）' }];
      });
    }
  }
  async runPluginAction(input: PluginActionInput): Promise<PluginsManagerSnapshot> {
    if (!input || !['install', 'uninstall', 'enable', 'disable'].includes(input.action) || !isSafePluginTarget(input.target)) throw new Error('插件名称或操作无效');
    return this.exclusive(async () => { const output = await this.run(['plugin', input.action, input.target.trim()]); await this.refresh(); this.snapshot.lastCommandOutput = output; return this.getCachedSnapshot(); });
  }
  async runMcpAction(input: McpActionInput): Promise<PluginsManagerSnapshot> {
    if (!input || !['add', 'remove', 'enable', 'disable'].includes(input.action) || !isSafeMcpServerName(input.name)) throw new Error('MCP 名称或操作无效');
    const args = ['mcp', input.action];
    if (input.action === 'add') {
      if (!input.commandOrUrl || input.commandOrUrl.startsWith('-') || /[\0\r\n]/.test(input.commandOrUrl)) throw new Error('MCP 命令或 URL 无效');
      if (input.type && !['stdio', 'http'].includes(input.type)) throw new Error('MCP 类型无效');
      const type = input.type || (/^https?:\/\//i.test(input.commandOrUrl) ? 'http' : 'stdio');
      if (type === 'http') { const url = new URL(input.commandOrUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP HTTP URL 无效'); }
      args.push('--type', type);
      for (const [key, value] of Object.entries(input.env || {})) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('MCP 环境变量格式无效'); args.push('--env', `${key}=${value}`); }
      if ((input.args || []).some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) throw new Error('MCP 参数格式无效');
      // 名称和管理选项位于分隔符前，服务程序及其参数位于分隔符后，从而保留传给服务本身的选项。
      args.push(input.name.trim(), '--', input.commandOrUrl, ...(input.args || []));
    } else args.push(input.name.trim());
    return this.exclusive(async () => { const output = await this.run(args); await this.refresh(); this.snapshot.lastCommandOutput = output; return this.getCachedSnapshot(); });
  }
  async scanSkills(workspaceCwd?: string): Promise<DiscoveredSkillItem[]> {
    const home = this.options.homeDir || homedir();
    const scopes: Array<{ path: string; scope: DiscoveredSkillItem['scope'] }> = [
      ...(workspaceCwd ? [{ path: join(workspaceCwd, '.agents', 'skills'), scope: 'workspace' as const }] : []),
      { path: join(home, '.gemini', 'config', 'skills'), scope: 'global' },
    ];
    const pluginRoot = join(home, '.gemini', 'config', 'plugins');
    try { for (const entry of await fs.readdir(pluginRoot, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) scopes.push({ path: join(pluginRoot, entry.name, 'skills'), scope: 'plugin' }); } catch { /* 无插件目录 */ }
    const result: DiscoveredSkillItem[] = [];
    for (const scope of scopes) {
      if (isForbiddenCredentialOrStatePath(scope.path)) continue;
      try {
        if (await fs.realpath(scope.path) !== resolve(scope.path)) continue;
        for (const entry of await fs.readdir(scope.path, { withFileTypes: true })) {
          if (result.length >= 300) break;
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const path = join(scope.path, entry.name, 'SKILL.md');
          if (isForbiddenCredentialOrStatePath(path)) continue;
          try {
            const actual = await fs.realpath(path); if (actual !== path || !within(scope.path, actual) || isForbiddenCredentialOrStatePath(actual)) continue;
            const stat = await fs.lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) continue;
            const text = await fs.readFile(path, 'utf8'); const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
            const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(frontmatter)?.[1].replace(/^['"]|['"]$/g, '').trim();
            // 将技能文件路径转换为稳定 ID，启用偏好可按来源区分同名技能。
            const id = createHash('sha256').update(path).digest('hex');
            result.push({ id, name: field('name') || entry.name, description: field('description') || '', scope: scope.scope, skillFilePath: path, enabled: this.skillPrefs[id] !== false });
          } catch { /* 单个技能异常不影响其他项 */ }
        }
      } catch { /* 公开技能目录不存在 */ }
    }
    return result;
  }
  toggleSkillEnabled(skillId: string, enabled: boolean): PluginsManagerSnapshot {
    if (typeof enabled !== 'boolean' || !this.snapshot.skills.some(skill => skill.id === skillId)) throw new Error('Skill 不存在或开关值无效');
    this.skillPrefs[skillId] = enabled; this.options.store.write('skill-preferences.json', this.skillPrefs);
    this.snapshot.skills = this.snapshot.skills.map(skill => skill.id === skillId ? { ...skill, enabled } : skill); return this.getCachedSnapshot();
  }
}
