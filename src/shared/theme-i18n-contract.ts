/**
 * Gravity v0.2 — 品牌定义、6 套经典预设主题（Claude Code / Ubuntu / macOS / Solarized）+
 * 自定义 Design Tokens 取色与 JSON 导入导出、原创 Gravity 多配色图标、
 * 以及中英混排专业术语策略（Unified Technical Glossary）
 */

export const APP_BRAND = {
  name: 'Gravity',
  productName: 'Gravity',
  version: '0.3.5',
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

export interface ThemeSurfaceRamp {
  canvas?: string;
  rail?: string;
  drawer?: string;
  card?: string;
  composer?: string;
  hairline?: string;
}

export const THEME_SURFACE_RAMP_KEYS: readonly (keyof ThemeSurfaceRamp)[] = [
  'canvas',
  'rail',
  'drawer',
  'card',
  'composer',
  'hairline',
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
  /** 可选阶梯表面元数据，替代 CSS 硬编码覆盖，确保预览、实际界面与导出自定义主题一致 */
  surfaceRamp?: ThemeSurfaceRamp;
}

export interface CustomThemeConfig {
  name: string;
  polarity: ThemePolarity;
  baseThemeId: BuiltinThemeId;
  tokens: ThemePaletteTokens;
  surfaceRamp?: ThemeSurfaceRamp;
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
      textMuted: '#999086',
      borderSubtle: '#332d27',
      borderStrong: '#473f37',
      accentPrimary: '#d97757',
      accentSoft: 'rgba(217, 119, 87, 0.16)',
      statusSuccess: '#4ade80',
      statusWarning: '#f59e0b',
      statusDanger: '#f87171',
      diffAddedBg: 'rgba(74, 222, 128, 0.14)',
      diffAddedText: '#86efac',
      diffRemovedBg: 'rgba(239, 68, 68, 0.15)',
      diffRemovedText: '#fca5a5',
      syntaxKeyword: '#e08b6d',
      syntaxString: '#86efac',
      syntaxFunction: '#eab308',
      syntaxComment: '#999086',
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
      textMuted: '#685f56',
      borderSubtle: '#e2dacf',
      borderStrong: '#cfc3b4',
      accentPrimary: '#b5502e',
      accentSoft: 'rgba(181, 80, 46, 0.12)',
      statusSuccess: '#157f3d',
      statusWarning: '#9a5404',
      statusDanger: '#c41e1e',
      diffAddedBg: 'rgba(21, 127, 61, 0.12)',
      diffAddedText: '#166534',
      diffRemovedBg: 'rgba(196, 30, 30, 0.12)',
      diffRemovedText: '#991b1b',
      syntaxKeyword: '#a34121',
      syntaxString: '#116932',
      syntaxFunction: '#9a3412',
      syntaxComment: '#685f56',
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
      textMuted: '#ab8fa3',
      borderSubtle: '#521a3f',
      borderStrong: '#6e2856',
      accentPrimary: '#e95420',
      accentSoft: 'rgba(233, 84, 32, 0.18)',
      statusSuccess: '#38b44a',
      statusWarning: '#efb73e',
      statusDanger: '#f26b61',
      diffAddedBg: 'rgba(56, 180, 74, 0.16)',
      diffAddedText: '#8ce098',
      diffRemovedBg: 'rgba(242, 107, 97, 0.18)',
      diffRemovedText: '#ffa39c',
      syntaxKeyword: '#ff7a4d',
      syntaxString: '#8ce098',
      syntaxFunction: '#f6c358',
      syntaxComment: '#ab8fa3',
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
      textMuted: '#a0a0a8',
      borderSubtle: '#35373d',
      borderStrong: '#484a52',
      accentPrimary: '#0a84ff',
      accentSoft: 'rgba(10, 132, 255, 0.16)',
      statusSuccess: '#30d158',
      statusWarning: '#ff9f0a',
      statusDanger: '#ff6961',
      diffAddedBg: 'rgba(48, 209, 88, 0.15)',
      diffAddedText: '#7ee787',
      diffRemovedBg: 'rgba(255, 69, 58, 0.16)',
      diffRemovedText: '#ffa198',
      syntaxKeyword: '#ff7b72',
      syntaxString: '#7ee787',
      syntaxFunction: '#79c0ff',
      syntaxComment: '#a0a0a8',
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
      textMuted: '#636368',
      borderSubtle: '#dcdce2',
      borderStrong: '#c7c7cc',
      accentPrimary: '#0066d6',
      accentSoft: 'rgba(0, 102, 214, 0.12)',
      statusSuccess: '#147e36',
      statusWarning: '#a35500',
      statusDanger: '#c9221a',
      diffAddedBg: 'rgba(20, 126, 54, 0.13)',
      diffAddedText: '#146c2e',
      diffRemovedBg: 'rgba(201, 34, 26, 0.12)',
      diffRemovedText: '#b31d28',
      syntaxKeyword: '#cf222e',
      syntaxString: '#116329',
      syntaxFunction: '#0550ae',
      syntaxComment: '#636368',
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
      textSecondary: '#a3b3b3',
      textMuted: '#9cb6bd',
      borderSubtle: '#134e5e',
      borderStrong: '#246678',
      accentPrimary: '#2aa198',
      accentSoft: 'rgba(42, 161, 152, 0.18)',
      statusSuccess: '#a8c730',
      statusWarning: '#e0b338',
      statusDanger: '#fa908c',
      diffAddedBg: 'rgba(168, 199, 48, 0.16)',
      diffAddedText: '#b8d631',
      diffRemovedBg: 'rgba(250, 144, 140, 0.16)',
      diffRemovedText: '#ff9b99',
      syntaxKeyword: '#a8c730',
      syntaxString: '#2aa198',
      syntaxFunction: '#4aa8ea',
      syntaxComment: '#9cb6bd',
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

  const rawSurface =
    obj.surfaceRamp && typeof obj.surfaceRamp === 'object'
      ? (obj.surfaceRamp as Record<string, unknown>)
      : undefined;
  let validatedSurface: ThemeSurfaceRamp | undefined = fallbackPreset.surfaceRamp
    ? { ...fallbackPreset.surfaceRamp }
    : undefined;
  if (rawSurface) {
    validatedSurface = validatedSurface ?? {};
    for (const key of THEME_SURFACE_RAMP_KEYS) {
      if (rawSurface[key] !== undefined) {
        if (!isValidCssColorToken(rawSurface[key])) {
          throw new Error(`非法的表面颜色值 (surfaceRamp.${key})：仅支持 #HEX 或 rgb/rgba/hsl 格式`);
        }
        validatedSurface[key] = rawSurface[key].trim();
      }
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
    ...(validatedSurface && Object.keys(validatedSurface).length > 0 ? { surfaceRamp: validatedSurface } : {}),
  };
}

/**
 * 启动期迁移/恢复专用：尽量保留用户已保存的每个合法自定义色键，仅对个别损坏或过时色值回退基础预设，
 * 绝不因单个字段异常而清空整套自定义配色。
 */
export function sanitizeCustomThemeConfig(input: unknown): CustomThemeConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;
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
  const tokens = { ...fallbackPreset.tokens };
  for (const key of THEME_TOKEN_KEYS) {
    if (isValidCssColorToken(rawTokens[key])) {
      tokens[key] = rawTokens[key].trim();
    }
  }
  const rawSurface =
    obj.surfaceRamp && typeof obj.surfaceRamp === 'object'
      ? (obj.surfaceRamp as Record<string, unknown>)
      : undefined;
  let surfaceRamp: ThemeSurfaceRamp | undefined = fallbackPreset.surfaceRamp
    ? { ...fallbackPreset.surfaceRamp }
    : undefined;
  if (rawSurface) {
    surfaceRamp = surfaceRamp ?? {};
    for (const key of THEME_SURFACE_RAMP_KEYS) {
      if (isValidCssColorToken(rawSurface[key])) {
        surfaceRamp[key] = rawSurface[key].trim();
      }
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
    tokens,
    ...(surfaceRamp && Object.keys(surfaceRamp).length > 0 ? { surfaceRamp } : {}),
  };
}

/**
 * 原创 Gravity 应用图标变体定义（100% 原创 C4 Deep Well 深井引力徽标，提供 SVG + PNG + 1024px HIG macOS PNG + .ico）
 */
export type GravityIconId =
  | 'gravity-claude-dark'
  | 'gravity-claude-light'
  | 'gravity-ubuntu'
  | 'gravity-macos-dark'
  | 'gravity-macos-light'
  | 'gravity-solarized';

/** 应用图标偏好：'auto' 表示跟随当前生效主题的 recommendedIconId，其余为手动锁定指定原创图标 */
export type GravityIconPreference = GravityIconId | 'auto';

export interface GravityIconVariant {
  id: GravityIconId;
  nameZh: string;
  nameEn: string;
  accentHex: string;
  bgHex: string;
  /** 前端渲染层相对路径（位于 public/icons/） */
  publicSvgUrl: string;
  /** 工程根目录下真实图标资产相对路径（Linux 窗格） */
  assetPngRelPath: string;
  /** macOS Apple HIG 留白规范 1024×1024 Dock 专用 PNG 相对路径 */
  assetMacPngRelPath: string;
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
    assetPngRelPath: 'assets/icons/gravity-claude-dark.png',
    assetMacPngRelPath: 'assets/icons/gravity-claude-dark-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-claude-dark.ico',
  },
  {
    id: 'gravity-claude-light',
    nameZh: 'Gravity · Terracotta Light',
    nameEn: 'Gravity · Terracotta Light',
    accentHex: '#c6613f',
    bgHex: '#f8f4ec',
    publicSvgUrl: './icons/gravity-claude-light.svg',
    assetPngRelPath: 'assets/icons/gravity-claude-light.png',
    assetMacPngRelPath: 'assets/icons/gravity-claude-light-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-claude-light.ico',
  },
  {
    id: 'gravity-ubuntu',
    nameZh: 'Gravity · Ubuntu Aubergine',
    nameEn: 'Gravity · Ubuntu Aubergine',
    accentHex: '#e95420',
    bgHex: '#300a24',
    publicSvgUrl: './icons/gravity-ubuntu.svg',
    assetPngRelPath: 'assets/icons/gravity-ubuntu.png',
    assetMacPngRelPath: 'assets/icons/gravity-ubuntu-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-ubuntu.ico',
  },
  {
    id: 'gravity-macos-dark',
    nameZh: 'Gravity · macOS Graphite',
    nameEn: 'Gravity · macOS Graphite',
    accentHex: '#0a84ff',
    bgHex: '#26272b',
    publicSvgUrl: './icons/gravity-macos-dark.svg',
    assetPngRelPath: 'assets/icons/gravity-macos-dark.png',
    assetMacPngRelPath: 'assets/icons/gravity-macos-dark-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-macos-dark.ico',
  },
  {
    id: 'gravity-macos-light',
    nameZh: 'Gravity · macOS Silver',
    nameEn: 'Gravity · macOS Silver',
    accentHex: '#007aff',
    bgHex: '#fafafc',
    publicSvgUrl: './icons/gravity-macos-light.svg',
    assetPngRelPath: 'assets/icons/gravity-macos-light.png',
    assetMacPngRelPath: 'assets/icons/gravity-macos-light-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-macos-light.ico',
  },
  {
    id: 'gravity-solarized',
    nameZh: 'Gravity · Solarized',
    nameEn: 'Gravity · Solarized',
    accentHex: '#2aa198',
    bgHex: '#05323e',
    publicSvgUrl: './icons/gravity-solarized.svg',
    assetPngRelPath: 'assets/icons/gravity-solarized.png',
    assetMacPngRelPath: 'assets/icons/gravity-solarized-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-solarized.ico',
  },
] as const;

export function isGravityIconPreference(value: unknown): value is GravityIconPreference {
  return value === 'auto' || GRAVITY_ICON_VARIANTS.some((icon) => icon.id === value);
}

/** 将应用图标偏好解析为实际原创 C4 图标 ID（'auto' 时跟随当前主题或自定义主题基准预设）。 */
export function resolveEffectiveGravityIconId(
  appIcon: GravityIconPreference | undefined,
  theme: ThemePreference = 'claude-code-dark',
  customTheme?: Pick<CustomThemeConfig, 'baseThemeId' | 'polarity'>,
  systemPrefersLight = false
): GravityIconId {
  if (appIcon && appIcon !== 'auto' && GRAVITY_ICON_VARIANTS.some((icon) => icon.id === appIcon)) {
    return appIcon;
  }
  const targetThemeId: BuiltinThemeId =
    theme === 'system'
      ? systemPrefersLight
        ? 'claude-code-light'
        : 'claude-code-dark'
      : theme === 'custom'
        ? customTheme?.baseThemeId ?? (customTheme?.polarity === 'light' ? 'claude-code-light' : 'claude-code-dark')
        : theme;
  return THEME_PRESETS.find((p) => p.id === targetThemeId)?.recommendedIconId ?? GRAVITY_ICON_VARIANTS[0].id;
}

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
  'full-access',
  'Turbo',
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

/** 保存项目的名称、目录和默认选项。侧栏以路径匹配已有会话，新建会话时可沿用项目指定的执行模式。 */
export interface WorkspaceProjectConfig {
  id: string;
  name: string;
  path: string;
  description?: string;
  defaultMode?: 'default' | 'accept-edits' | 'plan' | 'full-access' | 'auto';
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
  appIcon: GravityIconPreference;
  defaultThoughtTrack: 'zh' | 'raw';
  translationEngine?: 'local' | 'external-api';
  processPerSession: boolean;
  activeProfileId: string;
  defaultWorkspaceCwd?: string;
  projects?: WorkspaceProjectConfig[];
  /** 界面缩放倍率（高分辨率屏幕适配），由主进程写入窗口 zoomFactor，缺省 1 */
  uiScale?: number;
  /** 启动时自动从 GitHub Releases 检查更新（默认 true） */
  autoCheckUpdates?: boolean;
  /** 思考块默认展开或折叠（持久化至 preferences.json，跨便携版更新不丢失） */
  thoughtExpandedByDefault?: boolean;
}

/** 界面缩放的允许区间与步进。快捷键 Ctrl+= / Ctrl+- / Ctrl+0 与设置页共用。 */
export const UI_SCALE_LIMITS = { min: 0.8, max: 1.6, step: 0.1, default: 1 } as const;

export type UiScaleCommand = 'increase' | 'decrease' | 'reset';

export function uiScaleCommandForKey(key: string): UiScaleCommand | undefined {
  if (key === '=' || key === '+') return 'increase';
  if (key === '-' || key === '_') return 'decrease';
  if (key === '0') return 'reset';
  return undefined;
}

/** 把缩放倍率对齐到 0.05 并限制在允许区间。非数字回到 1。 */
export function clampUiScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : UI_SCALE_LIMITS.default;
  const snapped = Math.round(n * 20) / 20;
  return Math.min(UI_SCALE_LIMITS.max, Math.max(UI_SCALE_LIMITS.min, snapped));
}
