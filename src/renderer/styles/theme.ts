import {
  GRAVITY_ICON_VARIANTS,
  THEME_PRESETS,
  THEME_TOKEN_KEYS,
  validateCustomThemeConfig,
  type BuiltinThemeId,
  type CustomThemeConfig,
  type GravityIconId,
  type GravityIconVariant,
  type ThemePaletteTokens,
  type ThemePolarity,
  type ThemePreference,
  type ThemePreset,
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

export function applyThemePreference(
  preference: ThemePreference,
  customTheme?: CustomThemeConfig
): AppliedThemeResult {
  let activeId: BuiltinThemeId | 'custom';
  let polarity: ThemePolarity;
  let tokens: ThemePaletteTokens;

  if (preference === 'custom' && customTheme) {
    const safeCustom = validateCustomThemeConfig(customTheme);
    activeId = 'custom';
    polarity = safeCustom.polarity;
    tokens = safeCustom.tokens;
  } else {
    const preset = resolveThemePreset(preference);
    activeId = preset.id;
    polarity = preset.polarity;
    tokens = preset.tokens;
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
  }

  return { id: activeId, polarity, tokens };
}

export function resolveGravityIconVariant(iconId?: GravityIconId): GravityIconVariant {
  return (
    GRAVITY_ICON_VARIANTS.find((v) => v.id === iconId) ?? GRAVITY_ICON_VARIANTS[0]
  );
}

export function applyDocumentFavicon(iconId: GravityIconId): GravityIconVariant {
  const variant = resolveGravityIconVariant(iconId);
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
