import { sanitizeOutput, maskKnownSecret, redactCliValue, redactCliDiagnostic } from '../security/redaction';
import { readBoundedLocalFile } from '../workspace/local-path-safety';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  GRAVITY_BUILTIN_CAPABILITIES, isSafePluginTarget, isSafeLocalPluginDirectory, isSafeMcpServerName,
} from '../../shared/plugins-contract';
import type {
  PluginsManagerSnapshot, PluginActionInput, McpActionInput, DiscoveredSkillItem, InstalledPluginItem,
  ConfiguredMcpServerItem,
} from '../../shared/plugins-contract';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';
import { discoverAgyBinary } from '../acp/acp-client';
import { buildAgyEnvironment } from '../acp/agy-environment';
import { ClientStore } from '../storage/client-store';
import { within } from '../workspace/workspace-files';

export type CliExecutor = (binary: string, args: string[], options: { shell: false; cwd?: string; timeout: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr?: string }>;
export const executeOfficialCli: CliExecutor = (binary, args, options) => new Promise((resolve, reject) => {
  execFile(binary, args, { ...options, shell: false, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(safeCliError({ stderr, stdout, message: error.message, code: error.code }, args)));
    else resolve({ stdout, stderr });
  });
});
function safeCliError(value: unknown, args: readonly string[] = []): string {
  const fields = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  let detail = typeof value === 'string' ? value :
    [...new Set([fields.code, fields.stderr, fields.stdout, fields.message].filter(field => typeof field === 'string' || typeof field === 'number'))].join(' ');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') {
      const assignment = args[++i] || '';
      const secret = assignment.slice(assignment.indexOf('=') + 1);
      if (secret) detail = maskKnownSecret(detail, secret, '[已隐藏]');
    }
  }
  return redactCliDiagnostic(detail);
}

interface PluginsManagerOptions { store: ClientStore; binaryPath?: string; executor?: CliExecutor; homeDir?: string }
export class PluginsManager {
  private snapshot: PluginsManagerSnapshot = { builtins: GRAVITY_BUILTIN_CAPABILITIES, plugins: [], mcpServers: [], skills: [], refreshedAt: new Date().toISOString() };
  private skillPrefs: Record<string, boolean>;
  private queueTail?: Promise<unknown>;
  private workspaceCwd?: string;
  private loading?: { cwd?: string; result: Promise<PluginsManagerSnapshot> };
  constructor(private options: PluginsManagerOptions) { this.skillPrefs = options.store.read('skill-preferences.json', {}); }
  /** 启动快照只复制现有内存数据。设置页请求刷新时才会运行官方列表命令。 */
  getCachedSnapshot(): PluginsManagerSnapshot { return structuredClone(this.snapshot); }
  private async run(args: string[]): Promise<string> {
    const binary = this.options.executor ? this.options.binaryPath || 'agy' : discoverAgyBinary(this.options.binaryPath);
    try {
      const result = await (this.options.executor || executeOfficialCli)(binary, args, {
        shell: false, cwd: this.workspaceCwd, timeout: 30000, env: buildAgyEnvironment(binary),
      });
      return result.stdout ? result.stdout : result.stderr ? safeCliError(result.stderr, args) : '';
    } catch (error) {
      throw new Error(safeCliError(error, args));
    }
  }
  /** Reads wait in arrival order. Explicit mutations still reject a concurrent management action. */
  private exclusive<T>(fn: () => Promise<T>, wait = false): Promise<T> {
    if (this.queueTail && !wait) return Promise.reject(new Error('另一条 Plugins/MCP 管理命令正在执行'));
    const next = (this.queueTail ?? Promise.resolve()).then(fn, fn);
    this.queueTail = next;
    const release = () => { if (this.queueTail === next) this.queueTail = undefined; };
    next.then(release, release);
    return next;
  }
  async getSnapshot(workspaceCwd?: string): Promise<PluginsManagerSnapshot> {
    if (this.loading && this.loading.cwd === workspaceCwd) return this.loading.result;
    const result = this.exclusive(() => {
      this.workspaceCwd = workspaceCwd;
      return this.refresh();
    }, true);
    this.loading = { cwd: workspaceCwd, result };
    try { return await result; }
    finally { if (this.loading?.result === result) this.loading = undefined; }
  }
  private async refresh(): Promise<PluginsManagerSnapshot> {
    const [plugins, mcp, skills] = await Promise.allSettled([
      this.run(['plugin', 'list', '--json']).then(output => ({ output, items: this.parsePlugins(output) })),
      this.run(['mcp', 'list']).then(output => ({ output, items: this.parseMcpList(output) })),
      this.scanSkills(this.workspaceCwd),
    ]);
    const sectionErrors: NonNullable<PluginsManagerSnapshot['sectionErrors']> = {};
    for (const [section, result] of [['plugins', plugins], ['mcp', mcp], ['skills', skills]] as const) {
      if (result.status === 'rejected') {
        const reason = result.reason;
        sectionErrors[section] = safeCliError(reason instanceof Error ? reason.message : reason);
      }
    }
    this.snapshot = {
      builtins: GRAVITY_BUILTIN_CAPABILITIES,
      plugins: plugins.status === 'fulfilled' ? plugins.value.items : [],
      mcpServers: mcp.status === 'fulfilled' ? mcp.value.items : [],
      skills: skills.status === 'fulfilled' ? skills.value : [],
      ...(Object.keys(sectionErrors).length > 0 && { sectionErrors }),
      lastCommandOutput: [plugins, mcp].flatMap(r => r.status === 'fulfilled' ? [sanitizeOutput(r.value.output)] : []).join('\n').trim().slice(0, 50000),
      refreshedAt: new Date().toISOString(),
    };
    return this.getCachedSnapshot();
  }

  private parsePlugins(output: string): InstalledPluginItem[] {
    let data;
    try { data = JSON.parse(output, redactCliValue); } catch { throw new Error('无法识别官方插件列表格式'); }
    const entries = Array.isArray(data) ? data : data?.plugins;
    if (!Array.isArray(entries)) throw new Error('无法识别官方插件列表格式');
    return entries.filter((item: InstalledPluginItem) => typeof item?.name === 'string').map((item: InstalledPluginItem) => ({
      name: item.name, version: item.version, enabled: item.enabled !== false, description: item.description,
      marketplace: item.marketplace, path: item.path,
    }));
  }
  /** 兼容 MCP 列表的结构化和文本两种输出。解析后的条目共享同一种界面模型。 */
  parseMcpList(output: string): ConfiguredMcpServerItem[] {
    try {
      const data = JSON.parse(output, redactCliValue); const servers = data.mcpServers || data.servers || data;
      const list = Array.isArray(servers) ? servers : Object.entries(servers).map(([name, value]) => ({ name, ...(value as object) }));
      return list.filter(item => isSafeMcpServerName(item?.name)).map(item => ({ name: item.name, type: item.type === 'http' || item.url ? 'http' : 'stdio', commandOrUrl: item.url || item.command || item.commandOrUrl || '', args: Array.isArray(item.args) ? item.args : [], enabled: item.enabled !== false && item.disabled !== true, status: item.status }));
    } catch {
      return sanitizeOutput(output).split(/\r?\n/).flatMap(line => {
        const row = /^\s*([\w.-]+)\s+(stdio|http|sse)\s+(enabled|disabled)\s+(.+?)\s*$/i.exec(line);
        if (row && isSafeMcpServerName(row[1])) {
          return [{ name: row[1], type: row[2].toLowerCase() === 'stdio' ? 'stdio' as const : 'http' as const, commandOrUrl: row[4], args: [], enabled: row[3].toLowerCase() === 'enabled', status: row[3] }];
        }
        const match = /^\s*(?:[-*]\s+)?([\w.-]+)\s*:\s*(.+)$/.exec(line); if (!match || !isSafeMcpServerName(match[1])) return [];
        if (/^(?:name|status|type|command|url|version|description|enabled|disabled|servers?|total|warning|error|note|usage|configuration)$/i.test(match[1])) return [];
        const text = match[2].trim();
        const marker = /\s+[\[(](enabled|disabled)[\])]$/i.exec(text);
        const destination = marker ? text.slice(0, marker.index).trimEnd() : text;
        const url = /^https?:\/\/[^\s]+$/i.test(destination);
        const command = /^(?:(?:"[^"]+"|[^\s]+)\.(?:exe|cmd|bat|sh|js|py)|\.{0,2}[\\/]\S+|[A-Za-z]:[\\/]\S+|(?:node|npx|npm|bunx?|deno|python[\d.]*|uvx?|docker|java|go|ruby|dotnet))(?:\s|$)/i.test(destination);
        if (!url && !command) return [];
        return [{ name: match[1], type: url ? 'http' as const : 'stdio' as const, commandOrUrl: destination, args: [], enabled: marker?.[1].toLowerCase() !== 'disabled', status: marker?.[1] || '官方 CLI 列表（文本）' }];
      });
    }
  }
  async runPluginAction(input: PluginActionInput): Promise<PluginsManagerSnapshot> {
    if (!input || typeof input.target !== 'string' || !['install', 'uninstall', 'enable', 'disable'].includes(input.action)) throw new Error('插件名称或操作无效');
    const target = input.target.trim();
    const local = /^(?:[a-z]:[\\/]|[\\/])/i.test(target);
    if (local ? input.action !== 'install' || !isSafeLocalPluginDirectory(target) : !isSafePluginTarget(target)) throw new Error('插件名称或操作无效');
    return this.exclusive(async () => { const output = await this.run(['plugin', input.action, target]); await this.refresh(); this.snapshot.lastCommandOutput = sanitizeOutput(output).slice(0, 50000); return this.getCachedSnapshot(); });
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
    return this.exclusive(async () => { const output = await this.run(args); await this.refresh(); this.snapshot.lastCommandOutput = sanitizeOutput(output).slice(0, 50000); return this.getCachedSnapshot(); });
  }
  private async scanSkills(workspaceCwd?: string): Promise<DiscoveredSkillItem[]> {
    const home = this.options.homeDir || homedir();
    const scopes: Array<{ base: string; rel: string[]; scope: DiscoveredSkillItem['scope'] }> = [
      ...(workspaceCwd ? [{ base: workspaceCwd, rel: ['.agents', 'skills'], scope: 'workspace' as const }] : []),
      { base: home, rel: ['.gemini', 'config', 'skills'], scope: 'global' },
    ];
    const pluginRoot = join(home, '.gemini', 'config', 'plugins');
    try {
      for (const entry of await fs.readdir(pluginRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          scopes.push({ base: home, rel: ['.gemini', 'config', 'plugins', entry.name, 'skills'], scope: 'plugin' });
        }
      }
    } catch { /* Unavailable scopes do not suppress skills from other scopes. */ }
    const insensitive = process.platform === 'win32' || process.platform === 'darwin';
    const result: DiscoveredSkillItem[] = [];
    for (const scope of scopes) {
      const rawPath = join(scope.base, ...scope.rel);
      if (isForbiddenCredentialOrStatePath(rawPath)) continue;
      try {
        const realBase = await fs.realpath(scope.base);
        let cursor = realBase;
        let hasSymlink = false;
        for (const part of scope.rel) {
          cursor = join(cursor, part);
          if ((await fs.lstat(cursor)).isSymbolicLink()) { hasSymlink = true; break; }
        }
        if (hasSymlink || isForbiddenCredentialOrStatePath(cursor)) continue;
        const realScope = await fs.realpath(cursor);
        const sameScope = insensitive ? realScope.toLowerCase() === cursor.toLowerCase() : realScope === cursor;
        if (!sameScope || isForbiddenCredentialOrStatePath(realScope) || !within(realBase, realScope)) continue;
        for (const entry of await fs.readdir(realScope, { withFileTypes: true })) {
          if (result.length >= 300) break;
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const path = join(realScope, entry.name, 'SKILL.md');
          if (isForbiddenCredentialOrStatePath(path)) continue;
          try {
            const actual = await fs.realpath(path);
            const same = insensitive ? actual.toLowerCase() === path.toLowerCase() : actual === path;
            if (!same || !within(realScope, actual) || isForbiddenCredentialOrStatePath(actual)) continue;
            const stat = await fs.lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) continue;
            const text = (await readBoundedLocalFile(actual, 256 * 1024)).toString('utf8'); const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
            const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(frontmatter)?.[1].replace(/^['"]|['"]$/g, '').trim();
            // 将技能文件路径转换为稳定 ID，启用偏好可按来源区分同名技能。
            const id = createHash('sha256').update(path).digest('hex');
            result.push({ id, name: field('name') || entry.name, description: field('description') || '', scope: scope.scope, skillFilePath: path, enabled: this.skillPrefs[id] !== false });
          } catch { /* 单个技能异常不影响其他项 */ }
        }
      } catch { /* Unavailable scopes do not suppress skills from other scopes. */ }
    }
    return result;
  }
  toggleSkillEnabled(skillId: string, enabled: boolean): PluginsManagerSnapshot {
    if (typeof enabled !== 'boolean' || !this.snapshot.skills.some(skill => skill.id === skillId)) throw new Error('Skill 不存在或开关值无效');
    const next = { ...this.skillPrefs, [skillId]: enabled };
    this.options.store.write('skill-preferences.json', next);
    this.skillPrefs = next;
    this.snapshot.skills = this.snapshot.skills.map(skill => skill.id === skillId ? { ...skill, enabled } : skill); return this.getCachedSnapshot();
  }
}
