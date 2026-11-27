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

/* ============================================================================
 * v0.3.5 热力图 OKLCH 色阶（deriveHeatmapRamp）
 *
 * - 以主题强调色的色相 / 彩度为基准，在 OKLCH 中按 WCAG 相对亮度（Y + 0.05）的对数空间等距排布 5 档；
 * - 浅色模式向深处走、深色模式向亮处走；若卡片底色处在中灰导致该方向无法满足 4.5:1，则自动翻转方向；
 * - 约束（全部以最终 8-bit 十六进制色值实测）：
 *   hm-4 对卡片 ≥ 4.5:1；hm-0→hm-1 ≥ 1.38:1；其余相邻档 ≥ 1.30:1；浅色模式 hm-1 的 OKLCH L ≤ 0.86；
 *   每档文字色 --hm-ink-N 对 --hm-N ≥ 4.5:1；中性灰强调色（C < 0.03）退化为纯中性灰阶。
 * ========================================================================== */

export const HEATMAP_RAMP_CSS_VARS = [
  '--hm-0',
  '--hm-1',
  '--hm-2',
  '--hm-3',
  '--hm-4',
  '--hm-0-border',
  '--hm-ink-0',
  '--hm-ink-1',
  '--hm-ink-2',
  '--hm-ink-3',
  '--hm-ink-4',
] as const;

export type HeatmapRampVar = (typeof HEATMAP_RAMP_CSS_VARS)[number];
export type HeatmapRamp = Record<HeatmapRampVar, string>;

/** 热力色阶的设计下限（测试与运行时自检共用） */
export const HEATMAP_RAMP_LIMITS = Object.freeze({
  topVsCard: 4.5,
  firstStep: 1.38,
  adjacentStep: 1.3,
  inkContrast: 4.5,
  lightL1Max: 0.86,
  neutralChroma: 0.03,
});

interface Oklch {
  l: number;
  c: number;
  h: number;
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}

export function rgbToOklch(rgb: Rgb): Oklch {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/** OKLCH → 线性 sRGB（未裁剪） */
function oklchToLinear({ l: L, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(lin: [number, number, number]): boolean {
  return lin.every((v) => v >= -0.0001 && v <= 1.0001);
}

/** 固定 L / h，二分收缩彩度直到落入 sRGB 色域，返回 8-bit 量化后的颜色。 */
function oklchToRgbGamut(color: Oklch): Rgb {
  let lin = oklchToLinear(color);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 22; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    lin = oklchToLinear({ ...color, c: lo });
  }
  return lin.map((v) => Math.round(Math.max(0, Math.min(255, linearToSrgb(Math.max(0, Math.min(1, v))))))) as Rgb;
}

/** 在给定色相 / 彩度下二分 OKLCH L，使量化后的颜色相对亮度逼近目标值。 */
function colorForLuminance(targetY: number, chroma: number, hue: number, maxL = 1): Rgb {
  let lo = 0;
  let hi = maxL;
  let best: Rgb = oklchToRgbGamut({ l: hi, c: chroma, h: hue });
  for (let i = 0; i < 26; i += 1) {
    const mid = (lo + hi) / 2;
    const rgb = oklchToRgbGamut({ l: mid, c: chroma, h: hue });
    const y = relativeLuminance(rgb);
    best = rgb;
    if (y < targetY) lo = mid;
    else hi = mid;
  }
  return best;
}

/** 对数亮度坐标：u = sign · ln(Y + 0.05)，sign = +1 代表向亮处走。 */
const logLum = (y: number) => Math.log(y + 0.05);

function pickInk(bg: Rgb, preferred: Rgb[]): Rgb {
  for (const c of preferred) if (contrastRatio(c, bg) >= HEATMAP_RAMP_LIMITS.inkContrast + 0.02) return c;
  return contrastRatio(WHITE, bg) >= contrastRatio([0, 0, 0], bg) ? WHITE : [0, 0, 0];
}

/** 内部：按给定方向生成 5 档 + 边框；返回 null 表示该方向不可行。 */
function buildRamp(
  card: Rgb,
  accent: Oklch,
  neutral: boolean,
  sign: 1 | -1,
  lightMode: boolean,
  extraPush: number
): { levels: Rgb[]; border: Rgb } | null {
  const yCard = relativeLuminance(card);
  const uCard = sign * logLum(yCard);
  const uMax = sign === 1 ? logLum(1) : -logLum(0);
  if (uMax - uCard < Math.log(HEATMAP_RAMP_LIMITS.topVsCard) + 0.002) return null;
  const hue = accent.h;
  const baseC = neutral ? 0 : Math.min(accent.c, 0.2);
  const chromaAt = [0.16, 0.5, 0.72, 0.9, 1].map((k) => (neutral ? 0 : Math.max(0.012, baseC * k)));
  const yFromU = (u: number) => Math.max(0, Math.min(1, Math.exp(sign * u) - 0.05));
  const make = (u: number, idx: number, maxL = 1) => colorForLuminance(yFromU(u), chromaAt[idx], hue, maxL);

  const g0 = Math.log(1.085);
  const gFirst = Math.log(HEATMAP_RAMP_LIMITS.firstStep + 0.05 + extraPush * 0.02);
  const gStep = Math.log(HEATMAP_RAMP_LIMITS.adjacentStep + 0.04 + extraPush * 0.02);
  const u0 = uCard + g0;
  const uTopMin = uCard + Math.log(HEATMAP_RAMP_LIMITS.topVsCard + 0.2 + extraPush * 0.05);
  const uAccent = sign * logLum(relativeLuminance(oklchToRgbGamut(accent)));
  let u4 = Math.max(uTopMin, uAccent, u0 + gFirst + 3 * gStep);
  u4 = Math.min(u4, uMax);

  const total = u4 - u0;
  let g1 = Math.max(gFirst, total / 4);
  let u1 = u0 + g1;
  const level0 = make(u0, 0);
  let level1 = make(u1, 1);
  if (lightMode && sign === -1 && rgbToOklch(level1).l > HEATMAP_RAMP_LIMITS.lightL1Max) {
    level1 = colorForLuminance(yFromU(u1), chromaAt[1], hue, HEATMAP_RAMP_LIMITS.lightL1Max - 0.004);
    u1 = sign * logLum(relativeLuminance(level1));
    g1 = u1 - u0;
  }
  const rest = (u4 - u1) / 3;
  const level2 = make(u1 + rest, 2);
  const level3 = make(u1 + 2 * rest, 3);
  const level4 = make(u4, 4);
  const border = colorForLuminance(yFromU(uCard + Math.log(1.4 + extraPush * 0.02)), chromaAt[0], hue);
  return { levels: [level0, level1, level2, level3, level4], border };
}

function rampSatisfies(card: Rgb, levels: Rgb[], border: Rgb, lightMode: boolean, sign: 1 | -1): boolean {
  const L = HEATMAP_RAMP_LIMITS;
  if (contrastRatio(border, card) < 1.35) return false;
  if (contrastRatio(levels[4], card) < L.topVsCard) return false;
  if (contrastRatio(levels[0], levels[1]) < L.firstStep) return false;
  for (let i = 0; i < 4; i += 1) {
    if (contrastRatio(levels[i + 1], card) <= contrastRatio(levels[i], card)) return false;
  }
  for (let i = 1; i < 4; i += 1) if (contrastRatio(levels[i], levels[i + 1]) < L.adjacentStep) return false;
  if (lightMode && sign === -1 && rgbToOklch(levels[1]).l > L.lightL1Max) return false;
  return true;
}

/**
 * 派生热力图 5 档色阶、空格描边与每档读数文字色。
 * `surfaceCard` 为当前卡片底色（缺省时按主题 Token 推导），返回值可直接写入 `:root` 的 CSS 变量。
 */
export function deriveHeatmapRamp(
  tokens: ThemePaletteTokens,
  polarity: ThemePolarity,
  surfaceCard?: string
): HeatmapRamp | null {
  const surface = parseCssColor(tokens.bgSurface);
  const app = parseCssColor(tokens.bgApp);
  const card =
    (surfaceCard ? parseCssColor(surfaceCard) : null) ??
    (surface && app ? (polarity === 'light' ? surface : mixRgb(app, surface, 0.92)) : surface ?? app);
  const accentRgb = parseCssColor(tokens.accentPrimary);
  if (!card || !accentRgb) return null;
  const accent = rgbToOklch(accentRgb);
  const neutral = accent.c < HEATMAP_RAMP_LIMITS.neutralChroma;
  const lightMode = polarity === 'light';
  const preferredSign: 1 | -1 = lightMode ? -1 : 1;

  let result: { levels: Rgb[]; border: Rgb } | null = null;
  let usedSign: 1 | -1 = preferredSign;
  for (const sign of [preferredSign, (preferredSign * -1) as 1 | -1]) {
    for (let push = 0; push < 8; push += 1) {
      const candidate = buildRamp(card, accent, neutral, sign, lightMode, push);
      if (!candidate) break;
      result = candidate;
      usedSign = sign;
      if (rampSatisfies(card, candidate.levels, candidate.border, lightMode, sign)) break;
    }
    if (result && rampSatisfies(card, result.levels, result.border, lightMode, usedSign)) break;
  }
  if (!result) return null;

  const textPrimary = parseCssColor(tokens.textPrimary);
  const inkPrefs = (i: number): Rgb[] => {
    const towardCard = i <= 1;
    const list: Rgb[] = [];
    if (towardCard && textPrimary) list.push(textPrimary);
    list.push(towardCard ? (textPrimary ?? card) : card);
    if (!towardCard && textPrimary) list.push(textPrimary);
    return list;
  };
  const out = {} as HeatmapRamp;
  result.levels.forEach((rgb, i) => {
    out[`--hm-${i}` as HeatmapRampVar] = toHex(rgb);
    out[`--hm-ink-${i}` as HeatmapRampVar] = toHex(pickInk(rgb, inkPrefs(i)));
  });
  out['--hm-0-border'] = toHex(result.border);
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
    // v0.3.5：热力图 OKLCH 色阶（以当前卡片底色为基准），缺省时移除以回退到 tokens.css 的 color-mix 派生。
    const ramp = deriveHeatmapRamp(tokens, polarity, surfaceRamp?.card);
    for (const cssVar of HEATMAP_RAMP_CSS_VARS) {
      if (ramp?.[cssVar]) root.style.setProperty(cssVar, ramp[cssVar]);
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
