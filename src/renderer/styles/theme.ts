import {
  GRAVITY_ICON_VARIANTS,
  THEME_PRESETS,
  THEME_TOKEN_KEYS,
  resolveEffectiveGravityIconId,
  validateCustomThemeConfig,
  type BuiltinThemeId,
  type CustomThemeConfig,
  type GravityIconPreference,
  type GravityIconVariant,
  type ThemePaletteTokens,
  type ThemePolarity,
  type ThemePreference,
  type ThemePreset,
  type ThemeSurfaceRamp,
} from '@shared';

export const DARK_THEME_PRESETS: readonly ThemePreset[] = THEME_PRESETS.filter(
  (preset) => preset.polarity === 'dark'
);

export const LIGHT_THEME_PRESETS: readonly ThemePreset[] = THEME_PRESETS.filter(
  (preset) => preset.polarity === 'light'
);

const DEFAULT_DARK_ID: BuiltinThemeId = 'claude-code-dark';
const DEFAULT_LIGHT_ID: BuiltinThemeId = 'claude-code-light';

export function detectSystemPrefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

export interface AppliedThemeResult {
  id: BuiltinThemeId | 'custom';
  polarity: ThemePolarity;
  tokens: ThemePaletteTokens;
}

/** 跟随系统时将明暗偏好解析为具体的内置主题。这里提供可直接使用的预设，自定义颜色在应用阶段单独验证。 */
export function resolveThemePreset(preference: ThemePreference): ThemePreset {
  const targetId: BuiltinThemeId =
    preference === 'system'
      ? detectSystemPrefersLight()
        ? DEFAULT_LIGHT_ID
        : DEFAULT_DARK_ID
      : preference === 'custom'
        ? DEFAULT_DARK_ID
        : preference;

  return THEME_PRESETS.find((item) => item.id === targetId) ?? THEME_PRESETS[0];
}

// 键名与共享调色板一一对应，将配置中的字段映射到组件样式实际引用的 CSS 自定义属性。
const TOKEN_TO_CSS_VAR: Record<keyof ThemePaletteTokens, string> = {
  bgApp: '--bg-app',
  bgSidebar: '--bg-sidebar',
  bgSurface: '--bg-surface',
  bgElevated: '--bg-elevated',
  bgCode: '--bg-code',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textMuted: '--text-muted',
  borderSubtle: '--border-subtle',
  borderStrong: '--border-strong',
  accentPrimary: '--accent-primary',
  accentSoft: '--accent-soft',
  statusSuccess: '--status-success',
  statusWarning: '--status-warning',
  statusDanger: '--status-danger',
  diffAddedBg: '--diff-added-bg',
  diffAddedText: '--diff-added-text',
  diffRemovedBg: '--diff-removed-bg',
  diffRemovedText: '--diff-removed-text',
  syntaxKeyword: '--syntax-keyword',
  syntaxString: '--syntax-string',
  syntaxFunction: '--syntax-function',
  syntaxComment: '--syntax-comment',
};

/* ============================================================================
 * WCAG 2.1 AA 语义文字派生（D2）：基于当前主题实际色值计算，自定义主题同样适用
 * ========================================================================== */

type Rgb = [number, number, number];

/** 解析 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`；无法解析时返回 null。 */
export function parseCssColor(value: string): Rgb | null {
  const v = (value || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.slice(0, 3).split('').map(c => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map(n => Math.max(0, Math.min(255, n))) as Rgb;
  return null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return '#' + rgb.map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
}

const AA = 4.5;

/** 语义类别基色（按明暗极性校准），最终写入前再按当前主题背景做 AA 校正。 */
type SemanticKey = 'explore' | 'edit' | 'exec' | 'web' | 'agent' | 'info';
const SEMANTIC_BASE: Record<ThemePolarity, Record<SemanticKey, string>> = {
  dark: { explore: '#8fa3b8', edit: '#f5b84a', exec: '#b197fc', web: '#34d1bf', agent: '#f38bc4', info: '#60a5fa' },
  light: { explore: '#5f7489', edit: '#b45309', exec: '#6d28d9', web: '#0f766e', agent: '#be185d', info: '#2563eb' },
};
/** 额度条独立色系：默认钴蓝；macOS 预设的强调色就是系统蓝，改走靛蓝避免与主操作混淆。 */
const QUOTA_BASE: Record<'default' | 'macos', Record<ThemePolarity, string>> = {
  default: { dark: '#6aa9ff', light: '#376fd9' },
  macos: { dark: '#8e8cf7', light: '#5856d6' },
};
const TURBO_BASE: Record<ThemePolarity, string> = { dark: '#ff7a2f', light: '#e8590c' };

/**
 * F-15：4 套带专属表面阶梯的预设（原先写死在 CSS `:root[data-theme=…]` 里）。
 * 共享层预设若已声明 `surfaceRamp` 优先使用；自定义主题使用自身经校验的 `surfaceRamp`，缺省时回退到 CSS 中按 Token 派生的阶梯。
 */
export const PRESET_SURFACE_RAMPS: Partial<Record<BuiltinThemeId, ThemeSurfaceRamp>> = {
  'claude-code-dark': {
    canvas: '#1a1917',
    rail: '#1d1c1a',
    drawer: '#21201d',
    card: '#21201d',
    composer: '#2a2825',
    hairline: 'rgba(242, 236, 228, 0.075)',
  },
  'claude-code-light': {
    canvas: '#f9f7f4',
    rail: '#f2efe9',
    drawer: '#f2efe9',
    card: '#ffffff',
    composer: '#ffffff',
    hairline: 'rgba(26, 22, 19, 0.08)',
  },
  'macos-light': {
    canvas: '#f5f5f7',
    rail: '#ececf0',
    drawer: '#f0f0f4',
    card: '#ffffff',
    composer: '#ffffff',
    hairline: 'rgba(29, 29, 31, 0.09)',
  },
  'macos-dark': {
    canvas: '#1b1c1f',
    rail: '#1f2023',
    drawer: '#232428',
    card: '#26282c',
    composer: '#2c2e33',
    hairline: 'rgba(245, 245, 247, 0.08)',
  },
};

const SURFACE_RAMP_CSS_VARS: Record<keyof ThemeSurfaceRamp, string> = {
  canvas: '--studio-canvas',
  rail: '--studio-rail',
  drawer: '--studio-drawer',
  card: '--studio-card',
  composer: '--studio-composer',
  hairline: '--hairline',
};

const DERIVED_CSS_VARS = [
  '--success-text',
  '--warning-text',
  '--danger-text',
  '--accent-text',
  '--muted-text',
  '--secondary-text',
  '--on-accent',
  '--accent-solid',
  '--on-warning',
  '--on-danger',
  '--syntax-keyword-text',
  '--syntax-string-text',
  '--syntax-function-text',
  '--syntax-comment-text',
  '--sem-explore',
  '--sem-edit',
  '--sem-exec',
  '--sem-web',
  '--sem-agent',
  '--sem-info',
  '--sem-pending',
  '--sem-danger',
  '--sem-success',
  '--sem-explore-text',
  '--sem-edit-text',
  '--sem-exec-text',
  '--sem-web-text',
  '--sem-agent-text',
  '--sem-info-text',
  '--sem-pending-text',
  '--sem-danger-text',
  '--sem-success-text',
  '--ctx-fill',
  '--quota-fill',
  '--turbo',
  '--turbo-text',
  '--tab-alert-bg',
  '--tab-alert-text',
] as const;
const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [20, 17, 15];

/** 将前景色逐步向 `toward` 混合，直到对所有背景均达到 AA；无法达到时返回 `toward`。 */
function ensureReadable(fg: Rgb, backgrounds: Rgb[], toward: Rgb): Rgb {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const candidate = mixRgb(fg, toward, Math.min(1, t));
    if (backgrounds.every(bg => contrastRatio(candidate, bg) >= AA)) return candidate;
  }
  return toward;
}

/**
 * 计算语义文字派生变量：状态色/强调色作为文字时的 AA 版本、主按钮标签色与按钮底色。
 * 返回 CSS 变量名到色值的映射；无法解析的自定义色值回退到原始变量。
 */
export function deriveAccessibleTokens(
  tokens: ThemePaletteTokens,
  polarity: ThemePolarity,
  themeId?: BuiltinThemeId | 'custom'
): Record<string, string> {
  const bgApp = parseCssColor(tokens.bgApp);
  const bgSidebar = parseCssColor(tokens.bgSidebar);
  const bgSurface = parseCssColor(tokens.bgSurface);
  const bgElevated = parseCssColor(tokens.bgElevated);
  const textPrimary = parseCssColor(tokens.textPrimary);
  if (!bgApp || !bgSurface || !textPrimary) return {};
  const backgrounds = [
    bgApp,
    ...(bgSidebar ? [bgSidebar] : []),
    bgSurface,
    ...(bgElevated ? [bgElevated] : []),
  ];
  const out: Record<string, string> = {};
  const pairs: Array<[keyof ThemePaletteTokens, string]> = [
    ['statusSuccess', '--success-text'],
    ['statusWarning', '--warning-text'],
    ['statusDanger', '--danger-text'],
    ['accentPrimary', '--accent-text'],
    ['textMuted', '--muted-text'],
    ['textSecondary', '--secondary-text'],
  ];
  for (const [key, cssVar] of pairs) {
    const fg = parseCssColor(tokens[key]);
    if (!fg) continue;
    // 状态色叠加在其自身 12–16% 的柔和底色上，也一并纳入校验
    const tinted = backgrounds.map(bg => mixRgb(bg, fg, 0.16));
    out[cssVar] = toHex(ensureReadable(fg, [...backgrounds, ...tinted], textPrimary));
  }

  const accent = parseCssColor(tokens.accentPrimary);
  if (accent) {
    if (contrastRatio(WHITE, accent) >= AA) {
      out['--on-accent'] = '#ffffff';
      out['--accent-solid'] = toHex(accent);
    } else if (polarity === 'dark' && contrastRatio(INK, accent) >= AA) {
      out['--on-accent'] = toHex(INK);
      out['--accent-solid'] = toHex(accent);
    } else {
      let solid = accent;
      for (let t = 0.05; t <= 0.8 && contrastRatio(WHITE, solid) < AA; t += 0.05) solid = mixRgb(accent, [0, 0, 0], t);
      out['--on-accent'] = '#ffffff';
      out['--accent-solid'] = toHex(solid);
    }
  }

  // 实心警告 / 危险底上的文字（待审批徽标、`.tab-alert-count`）：白字与墨字中取对比度更高者。
  const onSolid = (bg: Rgb): string => (contrastRatio(WHITE, bg) >= contrastRatio(INK, bg) ? '#ffffff' : toHex(INK));
  const warning = parseCssColor(tokens.statusWarning);
  const danger = parseCssColor(tokens.statusDanger);
  if (warning) out['--on-warning'] = onSolid(warning);
  if (danger) out['--on-danger'] = onSolid(danger);

  // 代码块语法色对 --bg-code 的 AA 版本
  const bgCode = parseCssColor(tokens.bgCode);
  if (bgCode) {
    const syntaxPairs: Array<[keyof ThemePaletteTokens, string]> = [
      ['syntaxKeyword', '--syntax-keyword-text'],
      ['syntaxString', '--syntax-string-text'],
      ['syntaxFunction', '--syntax-function-text'],
      ['syntaxComment', '--syntax-comment-text'],
    ];
    for (const [key, cssVar] of syntaxPairs) {
      const fg = parseCssColor(tokens[key]);
      if (fg) out[cssVar] = toHex(ensureReadable(fg, [bgCode], textPrimary));
    }
  }

  // 统一语义色：fill 版本保留类别辨识度（图形/色点），*-text 版本对全部表面达到 AA。
  const semantic: Array<[string, Rgb | null]> = [
    ...(Object.keys(SEMANTIC_BASE[polarity]) as SemanticKey[]).map(
      (k) => [k, parseCssColor(SEMANTIC_BASE[polarity][k])] as [string, Rgb | null]
    ),
    ['pending', warning],
    ['danger', danger],
    ['success', parseCssColor(tokens.statusSuccess)],
  ];
  for (const [name, fg] of semantic) {
    if (!fg) continue;
    out[`--sem-${name}`] = toHex(fg);
    const tinted = backgrounds.map((bg) => mixRgb(bg, fg, 0.14));
    out[`--sem-${name}-text`] = toHex(ensureReadable(fg, [...backgrounds, ...tinted], textPrimary));
  }

  const success = parseCssColor(tokens.statusSuccess);
  if (success) out['--ctx-fill'] = toHex(success);
  const macos = themeId === 'macos-light' || themeId === 'macos-dark';
  out['--quota-fill'] = QUOTA_BASE[macos ? 'macos' : 'default'][polarity];
  const turbo = parseCssColor(TURBO_BASE[polarity]);
  if (turbo) {
    out['--turbo'] = toHex(turbo);
    out['--turbo-text'] = toHex(ensureReadable(turbo, backgrounds, textPrimary));
  }

  // `.tab-alert-count`：实心危险底 + 对比度 ≥ 4.5 的文字；底色不足时向深色/浅色收敛。
  if (danger) {
    let alertBg = danger;
    const toward: Rgb = [0, 0, 0];
    for (let t = 0; t <= 0.6 && Math.max(contrastRatio(WHITE, alertBg), contrastRatio(INK, alertBg)) < AA; t += 0.05) {
      alertBg = mixRgb(danger, toward, t);
    }
    out['--tab-alert-bg'] = toHex(alertBg);
    out['--tab-alert-text'] = onSolid(alertBg);
  }
  return out;
}

/** 解析当前主题应写入的表面阶梯：自定义主题用自身 surfaceRamp，预设优先共享层声明再回退渲染层表。 */
export function resolveSurfaceRamp(
  activeId: BuiltinThemeId | 'custom',
  preset?: ThemePreset,
  custom?: CustomThemeConfig
): ThemeSurfaceRamp | undefined {
  if (activeId === 'custom') return custom?.surfaceRamp;
  return preset?.surfaceRamp ?? PRESET_SURFACE_RAMPS[activeId];
}

export function applyThemePreference(
  preference: ThemePreference,
  customTheme?: CustomThemeConfig
): AppliedThemeResult {
  let activeId: BuiltinThemeId | 'custom';
  let polarity: ThemePolarity;
  let tokens: ThemePaletteTokens;
  let surfaceRamp: ThemeSurfaceRamp | undefined;

  if (preference === 'custom' && customTheme) {
    const safeCustom = validateCustomThemeConfig(customTheme);
    activeId = 'custom';
    polarity = safeCustom.polarity;
    tokens = safeCustom.tokens;
    surfaceRamp = resolveSurfaceRamp('custom', undefined, safeCustom);
  } else {
    const preset = resolveThemePreset(preference);
    activeId = preset.id;
    polarity = preset.polarity;
    tokens = preset.tokens;
    surfaceRamp = resolveSurfaceRamp(preset.id, preset);
  }

  // 同时更新主题标识、明暗标识与原生控件的 color-scheme，再写入颜色变量，使自定义主题也能复用明暗适配样式。
  if (typeof document !== 'undefined' && document.documentElement) {
    const root = document.documentElement;
    root.setAttribute('data-theme', activeId);
    root.setAttribute('data-polarity', polarity);
    root.style.colorScheme = polarity;

    for (const key of THEME_TOKEN_KEYS) {
      root.style.setProperty(TOKEN_TO_CSS_VAR[key], tokens[key]);
    }
    const derived = deriveAccessibleTokens(tokens, polarity, activeId);
    for (const cssVar of DERIVED_CSS_VARS) {
      if (derived[cssVar]) root.style.setProperty(cssVar, derived[cssVar]);
      else root.style.removeProperty(cssVar);
    }
    // F-15：表面阶梯由 theme.ts 写入（预设与自定义同一路径），缺省时移除以回退到 CSS 中按 Token 派生的阶梯。
    for (const key of Object.keys(SURFACE_RAMP_CSS_VARS) as Array<keyof ThemeSurfaceRamp>) {
      const value = surfaceRamp?.[key];
      if (value) root.style.setProperty(SURFACE_RAMP_CSS_VARS[key], value);
      else root.style.removeProperty(SURFACE_RAMP_CSS_VARS[key]);
    }
  }

  return { id: activeId, polarity, tokens };
}

export function resolveGravityIconVariant(
  iconId?: GravityIconPreference,
  theme?: ThemePreference,
  customTheme?: CustomThemeConfig
): GravityIconVariant {
  const effectiveId = resolveEffectiveGravityIconId(
    iconId,
    theme,
    customTheme,
    detectSystemPrefersLight()
  );
  return (
    GRAVITY_ICON_VARIANTS.find((v) => v.id === effectiveId) ?? GRAVITY_ICON_VARIANTS[0]
  );
}

export function applyDocumentFavicon(
  iconId: GravityIconPreference,
  theme?: ThemePreference,
  customTheme?: CustomThemeConfig
): GravityIconVariant {
  const variant = resolveGravityIconVariant(iconId, theme, customTheme);
  if (typeof document !== 'undefined') {
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link && document.head) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      document.head.appendChild(link);
    }
    if (link) {
      link.href = variant.publicSvgUrl;
    }
  }
  return variant;
}

/** 返回成对的取消订阅函数。无媒体查询接口的环境也返回可直接调用的清理函数，统一组件卸载路径。 */
export function subscribeSystemThemeChange(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  try {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', callback);
      return () => mediaQuery.removeEventListener('change', callback);
    }
  } catch {
    // ignore in headless test environments
  }
  return () => {};
}
