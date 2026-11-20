/**
 * Gravity v0.2 — 品牌定义、6 套经典预设主题（Claude Code / Ubuntu / macOS / Solarized）+
 * 自定义 Design Tokens 取色与 JSON 导入导出、原创 Gravity 多配色图标、
 * 以及中英混排专业术语策略（Unified Technical Glossary）
 */

export const APP_BRAND = {
  name: 'Gravity',
  productName: 'Gravity',
  version: '0.2.2',
  repoSlug: 'Mikotou/G-Gravity',
  repoUrl: 'https://github.com/Mikotou/G-Gravity',
  descriptionZh: '基于官方 ACP 协议的本地智能编码工作台',
  descriptionEn: 'Local Agentic Coding Studio powered by Official ACP',
} as const;

export type ThemePolarity = 'dark' | 'light';

export type BuiltinThemeId =
  | 'claude-code-dark'
  | 'claude-code-light'
  | 'ubuntu-aubergine'
  | 'macos-dark'
  | 'macos-light'
  | 'solarized-dark';

export type ThemeId = BuiltinThemeId;

export type ThemePreference = BuiltinThemeId | 'custom' | 'system';

export type ClientLocale = 'zh-CN' | 'en-US';

/**
 * 完整 Design Tokens（覆盖背景、表面、边框、主色、文字、成功/警告/危险、Diff 增删色、代码高亮）
 */
export interface ThemePaletteTokens {
  bgApp: string;
  bgSidebar: string;
  bgSurface: string;
  bgElevated: string;
  bgCode: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  borderSubtle: string;
  borderStrong: string;
  accentPrimary: string;
  accentSoft: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
  diffAddedBg: string;
  diffAddedText: string;
  diffRemovedBg: string;
  diffRemovedText: string;
  syntaxKeyword: string;
  syntaxString: string;
  syntaxFunction: string;
  syntaxComment: string;
}

export const THEME_TOKEN_KEYS: readonly (keyof ThemePaletteTokens)[] = [
  'bgApp',
  'bgSidebar',
  'bgSurface',
  'bgElevated',
  'bgCode',
  'textPrimary',
  'textSecondary',
  'textMuted',
  'borderSubtle',
  'borderStrong',
  'accentPrimary',
  'accentSoft',
  'statusSuccess',
  'statusWarning',
  'statusDanger',
  'diffAddedBg',
  'diffAddedText',
  'diffRemovedBg',
  'diffRemovedText',
  'syntaxKeyword',
  'syntaxString',
  'syntaxFunction',
  'syntaxComment',
] as const;

export interface ThemePreset {
  id: BuiltinThemeId;
  polarity: ThemePolarity;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  recommendedIconId: GravityIconId;
  tokens: ThemePaletteTokens;
}

export interface CustomThemeConfig {
  name: string;
  polarity: ThemePolarity;
  baseThemeId: BuiltinThemeId;
  tokens: ThemePaletteTokens;
}

/**
 * 6 套内置主题预设（Claude Code Dark/Light、Ubuntu、macOS Dark/Light、Solarized Dark）
 */
export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'claude-code-dark',
    polarity: 'dark',
    nameZh: 'Claude Code Dark',
    nameEn: 'Claude Code Dark',
    descriptionZh: '温润暖炭深色底搭配标志性 Terracotta 暖陶橙主色',
    descriptionEn: 'Warm charcoal canvas with signature terracotta accents',
    recommendedIconId: 'gravity-claude-dark',
    tokens: {
      bgApp: '#171513',
      bgSidebar: '#1e1b18',
      bgSurface: '#24201c',
      bgElevated: '#2d2823',
      bgCode: '#12100e',
      textPrimary: '#f2ece4',
      textSecondary: '#b8afa4',
      textMuted: '#7d756b',
      borderSubtle: '#332d27',
      borderStrong: '#473f37',
      accentPrimary: '#d97757',
      accentSoft: 'rgba(217, 119, 87, 0.16)',
      statusSuccess: '#4ade80',
      statusWarning: '#f59e0b',
      statusDanger: '#ef4444',
      diffAddedBg: 'rgba(74, 222, 128, 0.14)',
      diffAddedText: '#86efac',
      diffRemovedBg: 'rgba(239, 68, 68, 0.15)',
      diffRemovedText: '#fca5a5',
      syntaxKeyword: '#e08b6d',
      syntaxString: '#86efac',
      syntaxFunction: '#eab308',
      syntaxComment: '#7d756b',
    },
  },
  {
    id: 'claude-code-light',
    polarity: 'light',
    nameZh: 'Claude Code Light',
    nameEn: 'Claude Code Light',
    descriptionZh: '柔和暖羊皮纸浅色底搭配 Terracotta 暖陶橙主色',
    descriptionEn: 'Warm parchment daylight workspace with terracotta highlights',
    recommendedIconId: 'gravity-claude-light',
    tokens: {
      bgApp: '#f7f4ee',
      bgSidebar: '#efeae0',
      bgSurface: '#ffffff',
      bgElevated: '#f4efe6',
      bgCode: '#ede7dc',
      textPrimary: '#241f1c',
      textSecondary: '#5c534b',
      textMuted: '#8c8177',
      borderSubtle: '#e2dacf',
      borderStrong: '#cfc3b4',
      accentPrimary: '#c6613f',
      accentSoft: 'rgba(198, 97, 63, 0.12)',
      statusSuccess: '#16a34a',
      statusWarning: '#d97706',
      statusDanger: '#dc2626',
      diffAddedBg: 'rgba(22, 163, 74, 0.12)',
      diffAddedText: '#166534',
      diffRemovedBg: 'rgba(220, 38, 38, 0.12)',
      diffRemovedText: '#991b1b',
      syntaxKeyword: '#b54d2b',
      syntaxString: '#15803d',
      syntaxFunction: '#9a3412',
      syntaxComment: '#8c8177',
    },
  },
  {
    id: 'ubuntu-aubergine',
    polarity: 'dark',
    nameZh: 'Ubuntu',
    nameEn: 'Ubuntu',
    descriptionZh: '经典 Aubergine 深茄紫终端底搭配 Ubuntu Orange 活力橙',
    descriptionEn: 'Classic Ubuntu aubergine terminal surfaces with vibrant orange',
    recommendedIconId: 'gravity-ubuntu',
    tokens: {
      bgApp: '#24071b',
      bgSidebar: '#2c001e',
      bgSurface: '#370c29',
      bgElevated: '#461435',
      bgCode: '#1b0414',
      textPrimary: '#f7f3f6',
      textSecondary: '#ccb8c6',
      textMuted: '#94788c',
      borderSubtle: '#521a3f',
      borderStrong: '#6e2856',
      accentPrimary: '#e95420',
      accentSoft: 'rgba(233, 84, 32, 0.18)',
      statusSuccess: '#38b44a',
      statusWarning: '#efb73e',
      statusDanger: '#df382c',
      diffAddedBg: 'rgba(56, 180, 74, 0.16)',
      diffAddedText: '#8ce098',
      diffRemovedBg: 'rgba(223, 56, 44, 0.18)',
      diffRemovedText: '#ffa39c',
      syntaxKeyword: '#ff7a4d',
      syntaxString: '#8ce098',
      syntaxFunction: '#f6c358',
      syntaxComment: '#94788c',
    },
  },
  {
    id: 'macos-dark',
    polarity: 'dark',
    nameZh: 'macOS Dark',
    nameEn: 'macOS Dark',
    descriptionZh: '原生 Graphite 石墨深灰毛玻璃质感配 System Blue 系统蓝',
    descriptionEn: 'macOS Graphite dark appearance paired with System Blue',
    recommendedIconId: 'gravity-macos-dark',
    tokens: {
      bgApp: '#1b1c1f',
      bgSidebar: '#232428',
      bgSurface: '#282a2f',
      bgElevated: '#32353b',
      bgCode: '#141518',
      textPrimary: '#f5f5f7',
      textSecondary: '#a1a1a6',
      textMuted: '#6e6e73',
      borderSubtle: '#35373d',
      borderStrong: '#484a52',
      accentPrimary: '#0a84ff',
      accentSoft: 'rgba(10, 132, 255, 0.16)',
      statusSuccess: '#30d158',
      statusWarning: '#ff9f0a',
      statusDanger: '#ff453a',
      diffAddedBg: 'rgba(48, 209, 88, 0.15)',
      diffAddedText: '#7ee787',
      diffRemovedBg: 'rgba(255, 69, 58, 0.16)',
      diffRemovedText: '#ffa198',
      syntaxKeyword: '#ff7b72',
      syntaxString: '#7ee787',
      syntaxFunction: '#79c0ff',
      syntaxComment: '#6e6e73',
    },
  },
  {
    id: 'macos-light',
    polarity: 'light',
    nameZh: 'macOS Light',
    nameEn: 'macOS Light',
    descriptionZh: '纯净银白浅色桌面层次搭配锐利 System Blue 系统蓝',
    descriptionEn: 'Clean macOS daylight chrome with crisp System Blue accents',
    recommendedIconId: 'gravity-macos-light',
    tokens: {
      bgApp: '#f5f5f7',
      bgSidebar: '#ebebf0',
      bgSurface: '#ffffff',
      bgElevated: '#f2f2f7',
      bgCode: '#ededf2',
      textPrimary: '#1d1d1f',
      textSecondary: '#515154',
      textMuted: '#86868b',
      borderSubtle: '#dcdce2',
      borderStrong: '#c7c7cc',
      accentPrimary: '#007aff',
      accentSoft: 'rgba(0, 122, 255, 0.12)',
      statusSuccess: '#28cd41',
      statusWarning: '#ff9500',
      statusDanger: '#ff3b30',
      diffAddedBg: 'rgba(40, 205, 65, 0.13)',
      diffAddedText: '#146c2e',
      diffRemovedBg: 'rgba(255, 59, 48, 0.12)',
      diffRemovedText: '#b31d28',
      syntaxKeyword: '#cf222e',
      syntaxString: '#116329',
      syntaxFunction: '#0550ae',
      syntaxComment: '#86868b',
    },
  },
  {
    id: 'solarized-dark',
    polarity: 'dark',
    nameZh: 'Solarized Dark',
    nameEn: 'Solarized Dark',
    descriptionZh: '传奇终端精密光学对比度深青色板，长时间审阅零眩光',
    descriptionEn: 'Precision-engineered Solarized dark palette for terminal purists',
    recommendedIconId: 'gravity-solarized',
    tokens: {
      bgApp: '#002b36',
      bgSidebar: '#073642',
      bgSurface: '#093d4a',
      bgElevated: '#0f4957',
      bgCode: '#00212b',
      textPrimary: '#fdf6e3',
      textSecondary: '#93a1a1',
      textMuted: '#657b83',
      borderSubtle: '#134e5e',
      borderStrong: '#246678',
      accentPrimary: '#2aa198',
      accentSoft: 'rgba(42, 161, 152, 0.18)',
      statusSuccess: '#859900',
      statusWarning: '#b58900',
      statusDanger: '#dc322f',
      diffAddedBg: 'rgba(133, 153, 0, 0.16)',
      diffAddedText: '#b8d631',
      diffRemovedBg: 'rgba(220, 50, 47, 0.16)',
      diffRemovedText: '#ff8785',
      syntaxKeyword: '#859900',
      syntaxString: '#2aa198',
      syntaxFunction: '#268bd2',
      syntaxComment: '#657b83',
    },
  },
] as const;

/**
 * 安全校验 CSS 颜色值（严禁 `url(...)`、分号、花括号或脚本表达式，防止自定义主题绕过 CSP）
 */
const SAFE_HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SAFE_FUNC_COLOR_RE =
  /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]{3,40}\s*\)$/;

/** 校验可直接写入 CSS 变量的单个色值。只允许限定的十六进制或数值颜色函数语法。 */
export function isValidCssColorToken(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (/[;{}<>\\]|url\s*\(|expression\s*\(/i.test(trimmed)) return false;
  return SAFE_HEX_COLOR_RE.test(trimmed) || SAFE_FUNC_COLOR_RE.test(trimmed);
}

/**
 * 校验并规范化用户导入或编辑的自定义主题 JSON
 */
export function validateCustomThemeConfig(input: unknown): CustomThemeConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('主题配置必须是有效的 JSON 对象');
  }
  const obj = input as Record<string, unknown>;
  const polarity: ThemePolarity = obj.polarity === 'light' ? 'light' : 'dark';
  const baseIdRaw = typeof obj.baseThemeId === 'string' ? obj.baseThemeId : '';
  const fallbackPreset =
    THEME_PRESETS.find((p) => p.id === baseIdRaw) ??
    (polarity === 'light' ? THEME_PRESETS[1] : THEME_PRESETS[0]);

  const rawTokens =
    obj.tokens && typeof obj.tokens === 'object'
      ? (obj.tokens as Record<string, unknown>)
      : {};

  // 先复制基础主题，再逐项应用已知色键。省略的颜色沿用基础主题，提供了非法值则中止整个导入。
  const validatedTokens = { ...fallbackPreset.tokens };
  for (const key of THEME_TOKEN_KEYS) {
    if (rawTokens[key] !== undefined) {
      if (!isValidCssColorToken(rawTokens[key])) {
        throw new Error(`非法的颜色 Token 值 (${key})：仅支持 #HEX 或 rgb/rgba/hsl 格式`);
      }
      validatedTokens[key] = rawTokens[key].trim();
    }
  }

  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim().slice(0, 40)
      : 'Custom Gravity Theme';

  return {
    name,
    polarity,
    baseThemeId: fallbackPreset.id,
    tokens: validatedTokens,
  };
}

/**
 * 原创 Gravity 应用图标变体定义（100% 原创引力轨道 + `>_` 终端徽标，提供 SVG + PNG + .ico）
 */
export type GravityIconId =
  | 'gravity-claude-dark'
  | 'gravity-claude-light'
  | 'gravity-ubuntu'
  | 'gravity-macos-dark'
  | 'gravity-macos-light'
  | 'gravity-solarized';

export interface GravityIconVariant {
  id: GravityIconId;
  nameZh: string;
  nameEn: string;
  accentHex: string;
  bgHex: string;
  /** 前端渲染层相对路径（位于 public/icons/） */
  publicSvgUrl: string;
  publicPngUrl: string;
  /** 工程根目录下真实图标资产相对路径 */
  assetSvgRelPath: string;
  assetPngRelPath: string;
  assetIcoRelPath: string;
}

export const GRAVITY_ICON_VARIANTS: readonly GravityIconVariant[] = [
  {
    id: 'gravity-claude-dark',
    nameZh: 'Gravity · Terracotta Dark',
    nameEn: 'Gravity · Terracotta Dark',
    accentHex: '#d97757',
    bgHex: '#1c1917',
    publicSvgUrl: './icons/gravity-claude-dark.svg',
    publicPngUrl: './icons/gravity-claude-dark.png',
    assetSvgRelPath: 'assets/icons/gravity-claude-dark.svg',
    assetPngRelPath: 'assets/icons/gravity-claude-dark.png',
    assetIcoRelPath: 'assets/icons/gravity-claude-dark.ico',
  },
  {
    id: 'gravity-claude-light',
    nameZh: 'Gravity · Terracotta Light',
    nameEn: 'Gravity · Terracotta Light',
    accentHex: '#c6613f',
    bgHex: '#f8f4ec',
    publicSvgUrl: './icons/gravity-claude-light.svg',
    publicPngUrl: './icons/gravity-claude-light.png',
    assetSvgRelPath: 'assets/icons/gravity-claude-light.svg',
    assetPngRelPath: 'assets/icons/gravity-claude-light.png',
    assetIcoRelPath: 'assets/icons/gravity-claude-light.ico',
  },
  {
    id: 'gravity-ubuntu',
    nameZh: 'Gravity · Ubuntu Aubergine',
    nameEn: 'Gravity · Ubuntu Aubergine',
    accentHex: '#e95420',
    bgHex: '#300a24',
    publicSvgUrl: './icons/gravity-ubuntu.svg',
    publicPngUrl: './icons/gravity-ubuntu.png',
    assetSvgRelPath: 'assets/icons/gravity-ubuntu.svg',
    assetPngRelPath: 'assets/icons/gravity-ubuntu.png',
    assetIcoRelPath: 'assets/icons/gravity-ubuntu.ico',
  },
  {
    id: 'gravity-macos-dark',
    nameZh: 'Gravity · macOS Graphite',
    nameEn: 'Gravity · macOS Graphite',
    accentHex: '#0a84ff',
    bgHex: '#26272b',
    publicSvgUrl: './icons/gravity-macos-dark.svg',
    publicPngUrl: './icons/gravity-macos-dark.png',
    assetSvgRelPath: 'assets/icons/gravity-macos-dark.svg',
    assetPngRelPath: 'assets/icons/gravity-macos-dark.png',
    assetIcoRelPath: 'assets/icons/gravity-macos-dark.ico',
  },
  {
    id: 'gravity-macos-light',
    nameZh: 'Gravity · macOS Silver',
    nameEn: 'Gravity · macOS Silver',
    accentHex: '#007aff',
    bgHex: '#fafafc',
    publicSvgUrl: './icons/gravity-macos-light.svg',
    publicPngUrl: './icons/gravity-macos-light.png',
    assetSvgRelPath: 'assets/icons/gravity-macos-light.svg',
    assetPngRelPath: 'assets/icons/gravity-macos-light.png',
    assetIcoRelPath: 'assets/icons/gravity-macos-light.ico',
  },
  {
    id: 'gravity-solarized',
    nameZh: 'Gravity · Solarized',
    nameEn: 'Gravity · Solarized',
    accentHex: '#2aa198',
    bgHex: '#002b36',
    publicSvgUrl: './icons/gravity-solarized.svg',
    publicPngUrl: './icons/gravity-solarized.png',
    assetSvgRelPath: 'assets/icons/gravity-solarized.svg',
    assetPngRelPath: 'assets/icons/gravity-solarized.png',
    assetIcoRelPath: 'assets/icons/gravity-solarized.ico',
  },
] as const;

/**
 * 统一中英技术术语表（v0.2 第 4 条规范：以下技术专有名词在中英文界面下均保留英文原名，严禁生硬汉化）
 */
export const TECHNICAL_GLOSSARY_KEEP_ENGLISH = [
  'Gravity',
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Grep',
  'Glob',
  'WebSearch',
  'Swarm',
  'Subagent',
  'Token',
  'Tokens',
  'tok/s',
  'MCP',
  'Skills',
  'Plugins',
  'Built-in',
  'Diff',
  'Files Changed',
  'Plan',
  'Todo',
  'Terminal',
  'Context',
  'Cost',
  'Approve for me',
  'Thinking',
  'default',
  'accept-edits',
  'plan',
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'Ctrl+B',
  'Ctrl+J',
  'Ctrl+\\',
  'Shift+Tab',
] as const;

/**
 * 将底层异构 ACP 工具名映射为 Claude Code 标准简洁英文工具名（如 `⏺ Bash`, `⏺ Read`, `⏺ Edit`）
 */
const CANONICAL_TOOL_MAP: Record<string, string> = {
  run_command: 'Bash',
  bash: 'Bash',
  sh: 'Bash',
  powershell: 'Bash',
  cmd: 'Bash',
  execute_command: 'Bash',
  read_file: 'Read',
  view_file: 'Read',
  edit_file: 'Edit',
  replace_in_file: 'Edit',
  multi_edit: 'Edit',
  write_file: 'Write',
  create_file: 'Write',
  grep_search: 'Grep',
  grep: 'Grep',
  ripgrep: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'Glob',
  glob: 'Glob',
  search_web: 'WebSearch',
  web_search: 'WebSearch',
  swarm: 'Swarm',
  post_message: 'Swarm',
  read_board: 'Swarm',
  swarm_wait: 'Swarm',
  invoke_subagent: 'Subagent',
  send_message: 'Subagent',
  manage_subagents: 'Subagent',
};

/** 将工具别名归一成卡片、统计和筛选共用的名称。未知工具保留原有拼写，让新类型仍可显示。 */
export function getCanonicalToolName(rawToolName: string): string {
  const normalized = (rawToolName || '').trim().toLowerCase();
  if (!normalized) return 'Tool';
  return CANONICAL_TOOL_MAP[normalized] ?? rawToolName.trim();
}

/**
 * 遵循 v0.2 第 4 条术语策略：工具名称统一保留简洁英文标识（如 Bash / Read / Edit）
 */
export function getLocalizedToolLabel(
  rawToolName: string,
  _locale?: ClientLocale
): string {
  return getCanonicalToolName(rawToolName);
}

/** 保存项目的名称、目录和默认选项。侧栏以路径匹配已有会话，新建会话时可沿用项目指定的执行模式。 */
export interface WorkspaceProjectConfig {
  id: string;
  name: string;
  path: string;
  description?: string;
  defaultMode?: 'default' | 'accept-edits' | 'plan' | 'auto';
  defaultModelId?: string;
  pinned?: boolean;
}

/**
 * 客户端全局用户偏好设置
 */
export interface ClientPreferences {
  locale: ClientLocale;
  theme: ThemePreference;
  customTheme?: CustomThemeConfig;
  appIcon: GravityIconId;
  defaultThoughtTrack: 'zh' | 'raw';
  translationEngine?: 'local';
  processPerSession: boolean;
  activeProfileId: string;
  defaultWorkspaceCwd?: string;
  projects?: WorkspaceProjectConfig[];
  /** 界面缩放倍率（高分辨率屏幕适配），由主进程写入窗口 zoomFactor，缺省 1 */
  uiScale?: number;
  /** 启动时自动从 GitHub Releases 检查更新（默认 true） */
  autoCheckUpdates?: boolean;
}

/** 界面缩放的允许区间与步进。快捷键 Ctrl+= / Ctrl+- / Ctrl+0 与设置页共用。 */
export const UI_SCALE_LIMITS = { min: 0.8, max: 1.6, step: 0.1, default: 1 } as const;

/** 把缩放倍率对齐到 0.05 并限制在允许区间。非数字回到 1。 */
export function clampUiScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : UI_SCALE_LIMITS.default;
  const snapped = Math.round(n * 20) / 20;
  return Math.min(UI_SCALE_LIMITS.max, Math.max(UI_SCALE_LIMITS.min, snapped));
}
