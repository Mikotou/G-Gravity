/**
 * Gravity v0.2 — Plugins / MCP Servers / Skills 管理栏目契约
 *
 * 合规铁律：
 * 1. Plugins 与 MCP 的增删启停必须且仅能在用户在界面点击后，以 `shell: false` 短时运行原版官方 CLI 子命令：
 *    - `agy plugin list --json | install <target> | uninstall <name> | enable <name> | disable <name>`
 *    - `agy mcp list | add [flags] <name> <commandOrUrl> [args...] | remove <name> | enable <name> | disable <name>`
 * 2. 严禁客户端直接改写 `agy` 内部的 `settings.json` 或 `mcp_config.json`；
 * 3. 内置能力（`Approve for me`、`Context & Cost` 看板）在面板中固定标记为 `Built-in`。
 */

export interface BuiltinPluginItem {
  id: 'builtin-approve-for-me' | 'builtin-context-cost';
  name: string;
  badge: 'Built-in';
  enabled: true;
  descriptionZh: string;
  descriptionEn: string;
}

export const GRAVITY_BUILTIN_CAPABILITIES: readonly BuiltinPluginItem[] = [
  {
    id: 'builtin-approve-for-me',
    name: 'Approve for me',
    badge: 'Built-in',
    enabled: true,
    descriptionZh: '零 CLI 冷启动内联权限安全审查引擎（词法快筛 + 会话前缀放行 + 审计日志）',
    descriptionEn: 'Zero-cold-start inline permission security engine with audit trail',
  },
  {
    id: 'builtin-context-cost',
    name: 'Context & Cost Inspector',
    badge: 'Built-in',
    enabled: true,
    descriptionZh: '实时 Context 占用、24h/7d/30d Token 热力图与分模型 Cost 构成分析',
    descriptionEn: 'Real-time Context gauge, 24h/7d/30d Token heatmaps, and per-model Cost breakdown',
  },
] as const;

export interface InstalledPluginItem {
  name: string;
  version?: string;
  enabled: boolean;
  description?: string;
  marketplace?: string;
  path?: string;
}

export interface ConfiguredMcpServerItem {
  name: string;
  type: 'stdio' | 'http';
  commandOrUrl: string;
  args: string[];
  enabled: boolean;
  status?: string;
}

export interface DiscoveredSkillItem {
  id: string;
  name: string;
  description: string;
  scope: 'workspace' | 'global' | 'plugin';
  skillFilePath: string;
  /** 客户端本地维护的会话技能启用偏好（不改写 agy 内部配置） */
  enabled: boolean;
}

/** 内置能力、官方插件、MCP 服务与发现的技能分别列出。快照还保存最近一次管理命令的回显和刷新时间。 */
export interface PluginsManagerSnapshot {
  builtins: readonly BuiltinPluginItem[];
  plugins: InstalledPluginItem[];
  mcpServers: ConfiguredMcpServerItem[];
  skills: DiscoveredSkillItem[];
  lastCommandOutput?: string;
  refreshedAt: string;
}

export type PluginCliAction = 'install' | 'uninstall' | 'enable' | 'disable';

export interface PluginActionInput {
  action: PluginCliAction;
  /** 插件名或 plugin@marketplace */
  target: string;
}

export type McpCliAction = 'add' | 'remove' | 'enable' | 'disable';

export interface McpActionInput {
  action: McpCliAction;
  name: string;
  type?: 'stdio' | 'http';
  commandOrUrl?: string;
  args?: string[];
  env?: Record<string, string>;
}

import { isForbiddenCredentialOrStatePath } from './accounts-history-contract';

/**
 * 严格校验插件名或 MCP 名称，禁止以 `-` 开头（防止伪造 CLI flag 参数注入）或包含控制字符
 */
const SAFE_PLUGIN_TARGET_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,127}$/;
const SAFE_MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * 校验目录路径以外的插件标识。
 * 该参数直接作为单个 CLI 实参使用，可接受的字符及长度与本地目录单独判定。
 */
export function isSafePluginTarget(target: string): boolean {
  if (!target || typeof target !== 'string') return false;
  const trimmed = target.trim();
  if (trimmed.startsWith('-') || /\s/.test(trimmed) || trimmed.includes('..')) {
    return false;
  }
  return SAFE_PLUGIN_TARGET_RE.test(trimmed);
}

/**
 * 适配本机 `agy plugin install <localDirectory>` 行为：
 * 允许安全的绝对本地插件目录路径（Windows 盘符路径或 POSIX 绝对路径），
 * 严禁 `..` 路径穿越、控制字符、CLI flag 前缀及任何 `.gemini` / `antigravity-cli` / 敏感凭据路径。
 */
export function isSafeLocalPluginDirectory(dirPath: string): boolean {
  if (!dirPath || typeof dirPath !== 'string') return false;
  const trimmed = dirPath.trim();
  if (!trimmed || trimmed.length > 260 || trimmed.startsWith('-')) return false;
  if (/[\x00-\x1f\x7f;<>|`$]/.test(trimmed)) return false;
  const normalized = trimmed.replace(/\\/g, '/');
  if (/(?:^|\/)\.\.(?:\/|$)/.test(normalized)) return false;
  if (/(?:^|\/)(?:\.gemini|antigravity-cli)(?:\/|$)/i.test(normalized)) return false;
  if (isForbiddenCredentialOrStatePath(normalized)) return false;
  const isWinAbs = /^[a-zA-Z]:\/[^/].*$/.test(normalized);
  const isPosixAbs = /^\/[^/].*$/.test(normalized);
  return isWinAbs || isPosixAbs;
}

/** 服务名称参与命令参数和列表解析，两处沿用同一格式，避免管理操作与面板中的标识不一致。 */
export function isSafeMcpServerName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.startsWith('-')) return false;
  return SAFE_MCP_NAME_RE.test(trimmed);
}
