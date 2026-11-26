import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  THEME_PRESETS,
  THEME_SURFACE_RAMP_KEYS,
  THEME_TOKEN_KEYS,
  isValidCssColorToken,
  sanitizeCustomThemeConfig,
  validateCustomThemeConfig,
  type CustomThemeConfig,
  type ThemePaletteTokens,
  type ThemePreset,
  type ThemeSurfaceRamp,
} from '@shared';
import {
  applyThemePreference,
  contrastRatio,
  deriveAccessibleTokens,
  parseCssColor,
} from '../src/renderer/styles/theme';
import { createFallbackDesktopBridge } from '../src/renderer/services/fallback-desktop-bridge';

const REPO_ROOT = path.resolve(__dirname, '..');
const STYLES_DIR = path.join(REPO_ROOT, 'src', 'renderer', 'styles');
const WCAG_AA = 4.5;

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

function parseColorWithAlpha(value: string): Rgba | null {
  const v = (value || '').trim().toLowerCase();
  const hexMatch = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
    }
    if (hex.length === 4) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        parseInt(hex.slice(6, 8), 16) / 255,
      ];
    }
    if (hex.length === 6) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
    }
    if (hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        parseInt(hex.slice(6, 8), 16) / 255,
      ];
    }
    return null;
  }
  const rgbMatch = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (rgbMatch) {
    let alpha = 1;
    if (rgbMatch[4] !== undefined) {
      alpha = rgbMatch[4].endsWith('%') ? Number(rgbMatch[4].slice(0, -1)) / 100 : Number(rgbMatch[4]);
    }
    return [
      Math.max(0, Math.min(255, Number(rgbMatch[1]))),
      Math.max(0, Math.min(255, Number(rgbMatch[2]))),
      Math.max(0, Math.min(255, Number(rgbMatch[3]))),
      Math.max(0, Math.min(1, alpha)),
    ];
  }
  return null;
}

function compositeOver(fg: Rgba, bg: Rgb): Rgb {
  const a = fg[3];
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function collectRendererCssBundle(): string {
  const indexCss = path.join(STYLES_DIR, 'index.css');
  if (fs.existsSync(indexCss)) {
    const seen = new Set<string>();
    const readWithImports = (filePath: string): string => {
      const resolved = path.resolve(filePath);
      if (seen.has(resolved) || !fs.existsSync(resolved)) return '';
      seen.add(resolved);
      const raw = fs.readFileSync(resolved, 'utf8');
      return raw.replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_m, rel) => {
        if (/^(?:https?:|\/\/)/i.test(rel)) return '';
        return readWithImports(path.resolve(path.dirname(resolved), rel));
      });
    };
    return readWithImports(indexCss);
  }
  const legacyOrder = ['global.css', 'design-system.css', 'claude-studio.css'];
  return legacyOrder
    .map((name) => path.join(STYLES_DIR, name))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');
}

interface ParsedRule {
  selectors: string[];
  declarations: Map<string, string>;
}

function parseTopLevelRules(css: string): ParsedRule[] {
  const clean = stripCssComments(css);
  const rules: ParsedRule[] = [];
  let i = 0;

  function parseBlock(endAtBrace: boolean): void {
    while (i < clean.length) {
      while (i < clean.length && /\s/.test(clean[i])) i += 1;
      if (i >= clean.length) break;
      if (clean[i] === '}') {
        if (endAtBrace) i += 1;
        break;
      }
      const start = i;
      while (i < clean.length && clean[i] !== '{' && clean[i] !== ';' && clean[i] !== '}') i += 1;
      if (i >= clean.length) break;
      if (clean[i] === ';') {
        i += 1;
        continue;
      }
      if (clean[i] === '}') {
        if (endAtBrace) i += 1;
        break;
      }
      const prelude = clean.slice(start, i).trim();
      i += 1; // skip '{'
      if (prelude.startsWith('@')) {
        if (/^@(?:media|supports|layer|container)\b/i.test(prelude)) {
          parseBlock(true);
        } else {
          // skip @keyframes / @font-face body
          let depth = 1;
          while (i < clean.length && depth > 0) {
            if (clean[i] === '{') depth += 1;
            else if (clean[i] === '}') depth -= 1;
            i += 1;
          }
        }
        continue;
      }
      const bodyStart = i;
      let depth = 1;
      while (i < clean.length && depth > 0) {
        if (clean[i] === '{') depth += 1;
        else if (clean[i] === '}') depth -= 1;
        i += 1;
      }
      const body = clean.slice(bodyStart, i - 1);
      const declarations = new Map<string, string>();
      for (const decl of body.split(';')) {
        const colon = decl.indexOf(':');
        if (colon === -1) continue;
        const prop = decl.slice(0, colon).trim().toLowerCase();
        const val = decl.slice(colon + 1).trim();
        if (prop && val) declarations.set(prop, val);
      }
      const selectors = prelude
        .split(',')
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      rules.push({ selectors, declarations });
    }
  }

  parseBlock(false);
  return rules;
}

function buildVarMap(preset: ThemePreset, derived: Record<string, string>, rootCssVars: Map<string, string>): Map<string, string> {
  const vars = new Map<string, string>(rootCssVars);
  const t = preset.tokens;
  const paletteEntries: Array<[string, string]> = [
    ['--bg-app', t.bgApp],
    ['--bg-sidebar', t.bgSidebar],
    ['--bg-surface', t.bgSurface],
    ['--bg-elevated', t.bgElevated],
    ['--bg-code', t.bgCode],
    ['--text-primary', t.textPrimary],
    ['--text-secondary', t.textSecondary],
    ['--text-muted', t.textMuted],
    ['--border-subtle', t.borderSubtle],
    ['--border-strong', t.borderStrong],
    ['--accent-primary', t.accentPrimary],
    ['--accent-soft', t.accentSoft],
    ['--status-success', t.statusSuccess],
    ['--status-warning', t.statusWarning],
    ['--status-danger', t.statusDanger],
    ['--diff-added-bg', t.diffAddedBg],
    ['--diff-added-text', t.diffAddedText],
    ['--diff-removed-bg', t.diffRemovedBg],
    ['--diff-removed-text', t.diffRemovedText],
    ['--syntax-keyword', t.syntaxKeyword],
    ['--syntax-string', t.syntaxString],
    ['--syntax-function', t.syntaxFunction],
    ['--syntax-comment', t.syntaxComment],
  ];
  for (const [k, v] of paletteEntries) vars.set(k, v);
  for (const [k, v] of Object.entries(derived)) vars.set(k, v);
  return vars;
}

function resolveCssValue(raw: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 8) return raw;
  const trimmed = raw.replace(/\s*!important\s*$/i, '').trim();
  const varMatch = /^var\(\s*(--[a-z0-9-]+)(?:\s*,\s*([\s\S]+))?\s*\)$/i.exec(trimmed);
  if (!varMatch) return trimmed;
  const resolved = vars.get(varMatch[1]);
  if (resolved) return resolveCssValue(resolved, vars, depth + 1);
  if (varMatch[2]) return resolveCssValue(varMatch[2], vars, depth + 1);
  return trimmed;
}

function resolveColorExpr(raw: string, vars: Map<string, string>, fallbackBg: Rgb): Rgb | null {
  const val = resolveCssValue(raw, vars);
  const direct = parseColorWithAlpha(val);
  if (direct) return compositeOver(direct, fallbackBg);

  // Support color-mix(in srgb, <colorA> <pct>%, <colorB>)
  const mixMatch = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/i.exec(val);
  if (mixMatch) {
    const leftRaw = mixMatch[1].trim();
    const pct = Number(mixMatch[2]) / 100;
    const rightRaw = mixMatch[3].trim();
    const leftRgba = leftRaw === 'transparent' ? ([...fallbackBg, 0] as Rgba) : parseColorWithAlpha(resolveCssValue(leftRaw, vars));
    const rightRgba = rightRaw === 'transparent' ? ([...fallbackBg, 0] as Rgba) : parseColorWithAlpha(resolveCssValue(rightRaw, vars));
    if (leftRgba && rightRgba) {
      const leftRgb = compositeOver(leftRgba, fallbackBg);
      const rightRgb = compositeOver(rightRgba, fallbackBg);
      return mixRgb(rightRgb, leftRgb, pct);
    }
  }
  return null;
}

function collectCssVarsForPreset(rules: ParsedRule[], preset: ThemePreset): Map<string, string> {
  const map = new Map<string, string>();
  const matchesRoot = (sel: string): boolean => {
    if (sel === ':root' || sel === 'html') return true;
    if (sel === `:root[data-polarity='${preset.polarity}']` || sel === `:root[data-polarity="${preset.polarity}"]`) return true;
    if (sel === `[data-polarity='${preset.polarity}']` || sel === `[data-polarity="${preset.polarity}"]`) return true;
    if (sel === `:root[data-theme='${preset.id}']` || sel === `:root[data-theme="${preset.id}"]`) return true;
    if (sel === `[data-theme='${preset.id}']` || sel === `[data-theme="${preset.id}"]`) return true;
    return false;
  };
  for (const rule of rules) {
    if (rule.selectors.some(matchesRoot)) {
      for (const [prop, val] of rule.declarations) {
        if (prop.startsWith('--')) map.set(prop, val);
      }
    }
  }
  return map;
}

function collectClassDeclsForPreset(rules: ParsedRule[], className: string, preset: ThemePreset): Map<string, string> {
  const out = new Map<string, string>();
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactRe = new RegExp(`^${escaped}$`);
  const polRe = new RegExp(`\\[data-polarity=['"]${preset.polarity}['"]\\]\\s+${escaped}$`);
  const themeRe = new RegExp(`\\[data-theme=['"]${preset.id}['"]\\]\\s+${escaped}$`);

  for (const rule of rules) {
    if (rule.selectors.some((sel) => exactRe.test(sel) || polRe.test(sel) || themeRe.test(sel))) {
      for (const [prop, val] of rule.declarations) {
        out.set(prop, val);
      }
    }
  }
  return out;
}

afterEach(() => {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-polarity');
    document.documentElement.removeAttribute('style');
  }
});

describe('Gravity v0.3.4 主题 WCAG AA 对比度与自定义主题一致性 (UT-01, UT-02)', () => {
  /* ------------------------------------------------------------------ UT-01 */
  it('UT-01 (F-03 / F-04)：6 套内置主题的全部文字 Token、派生 *-text、syntax on bgCode 与 .tab-alert-count 均满足 WCAG 2.1 AA >= 4.5:1（0 违规）', () => {
    expect(THEME_PRESETS).toHaveLength(6);

    const cssBundle = collectRendererCssBundle();
    expect(cssBundle.length).toBeGreaterThan(0);
    const rules = parseTopLevelRules(cssBundle);

    const violations: string[] = [];

    for (const preset of THEME_PRESETS) {
      const t = preset.tokens;
      const derived = deriveAccessibleTokens(t, preset.polarity);
      const applied = applyThemePreference(preset.id);
      expect(applied.id).toBe(preset.id);
      expect(applied.polarity).toBe(preset.polarity);

      const bgApp = parseCssColor(t.bgApp);
      const bgSidebar = parseCssColor(t.bgSidebar);
      const bgSurface = parseCssColor(t.bgSurface);
      const bgElevated = parseCssColor(t.bgElevated);
      const bgCode = parseCssColor(t.bgCode);
      expect(bgApp && bgSidebar && bgSurface && bgElevated && bgCode, `${preset.id} surface colors must parse`).toBeTruthy();

      const surfaces: Array<[string, Rgb]> = [
        ['bgApp', bgApp!],
        ['bgSidebar', bgSidebar!],
        ['bgSurface', bgSurface!],
        ['bgElevated', bgElevated!],
      ];

      // 1) 主文字与次级/弱化文字 Token 在各基础表面上 >= 4.5:1
      const baseTextKeys: Array<keyof ThemePaletteTokens> = ['textPrimary', 'textSecondary', 'textMuted'];
      for (const textKey of baseTextKeys) {
        const fg = parseCssColor(t[textKey]);
        expect(fg, `${preset.id}.${textKey} must parse`).toBeTruthy();
        for (const [bgName, bgRgb] of surfaces) {
          const ratio = contrastRatio(fg!, bgRgb);
          if (ratio < WCAG_AA) {
            violations.push(`${preset.id}: ${textKey}(${t[textKey]}) on ${bgName}(${t[bgName as keyof ThemePaletteTokens]}) = ${ratio.toFixed(2)}:1 < 4.5:1`);
          }
        }
      }

      // 2) 所有派生 *-text 变量在普通表面及 16% 语义柔底上均 >= 4.5:1
      const derivedCheckPairs: Array<[string, keyof ThemePaletteTokens]> = [
        ['--success-text', 'statusSuccess'],
        ['--warning-text', 'statusWarning'],
        ['--danger-text', 'statusDanger'],
        ['--accent-text', 'accentPrimary'],
        ['--muted-text', 'textMuted'],
        ['--secondary-text', 'textSecondary'],
      ];
      for (const [cssVar, sourceKey] of derivedCheckPairs) {
        const rawVal = derived[cssVar];
        expect(rawVal, `${preset.id}: deriveAccessibleTokens missing ${cssVar}`).toBeTruthy();
        const fg = parseCssColor(rawVal);
        const src = parseCssColor(t[sourceKey]);
        expect(fg && src).toBeTruthy();
        for (const [bgName, bgRgb] of surfaces) {
          const rPlain = contrastRatio(fg!, bgRgb);
          if (rPlain < WCAG_AA) {
            violations.push(`${preset.id}: ${cssVar}(${rawVal}) on ${bgName} = ${rPlain.toFixed(2)}:1 < 4.5:1`);
          }
          const tintedBg = mixRgb(bgRgb, src!, 0.16);
          const rTinted = contrastRatio(fg!, tintedBg);
          if (rTinted < WCAG_AA) {
            violations.push(`${preset.id}: ${cssVar}(${rawVal}) on 16%-tinted ${bgName} = ${rTinted.toFixed(2)}:1 < 4.5:1`);
          }
        }
      }

      // 3) --on-accent on --accent-solid >= 4.5:1
      const onAccent = parseCssColor(derived['--on-accent']);
      const accentSolid = parseCssColor(derived['--accent-solid']);
      expect(onAccent && accentSolid, `${preset.id}: --on-accent / --accent-solid required`).toBeTruthy();
      const accentBtnRatio = contrastRatio(onAccent!, accentSolid!);
      if (accentBtnRatio < WCAG_AA) {
        violations.push(`${preset.id}: --on-accent(${derived['--on-accent']}) on --accent-solid(${derived['--accent-solid']}) = ${accentBtnRatio.toFixed(2)}:1 < 4.5:1`);
      }

      // 4) Diff 文本在 diffAddedBg / diffRemovedBg（叠加在 bgApp/bgCode 上）>= 4.5:1
      const diffPairs: Array<[keyof ThemePaletteTokens, keyof ThemePaletteTokens]> = [
        ['diffAddedText', 'diffAddedBg'],
        ['diffRemovedText', 'diffRemovedBg'],
      ];
      for (const [fgKey, bgKey] of diffPairs) {
        const fg = parseCssColor(t[fgKey]);
        const bgRgba = parseColorWithAlpha(t[bgKey]);
        expect(fg && bgRgba).toBeTruthy();
        for (const [baseName, baseRgb] of [
          ['bgApp', bgApp!],
          ['bgCode', bgCode!],
        ] as const) {
          const compositedBg = compositeOver(bgRgba!, baseRgb);
          const ratio = contrastRatio(fg!, compositedBg);
          if (ratio < WCAG_AA) {
            violations.push(`${preset.id}: ${fgKey}(${t[fgKey]}) on ${bgKey}@${baseName} = ${ratio.toFixed(2)}:1 < 4.5:1`);
          }
        }
      }

      // 5) 全部 syntax* 高亮 Token 在 bgCode 上 >= 4.5:1（优先取 deriveAccessibleTokens 派生变量，回退取预设原值）
      const syntaxPairs: Array<[keyof ThemePaletteTokens, string]> = [
        ['syntaxKeyword', '--syntax-keyword'],
        ['syntaxString', '--syntax-string'],
        ['syntaxFunction', '--syntax-function'],
        ['syntaxComment', '--syntax-comment'],
      ];
      for (const [synKey, synVar] of syntaxPairs) {
        const effectiveVal = derived[synVar] ?? t[synKey];
        const fg = parseCssColor(effectiveVal);
        expect(fg, `${preset.id}.${synKey} (${effectiveVal}) must parse`).toBeTruthy();
        const ratio = contrastRatio(fg!, bgCode!);
        if (ratio < WCAG_AA) {
          violations.push(`${preset.id}: ${synKey}(${effectiveVal}) on bgCode(${t.bgCode}) = ${ratio.toFixed(2)}:1 < 4.5:1`);
        }
      }

      // 6) F-04：.tab-alert-count 在全部 6 套主题下的前景/背景对比度 >= 4.5:1
      const rootVars = collectCssVarsForPreset(rules, preset);
      const varMap = buildVarMap(preset, derived, rootVars);
      const alertDecls = collectClassDeclsForPreset(rules, '.tab-alert-count', preset);
      const alertBgRaw = alertDecls.get('background-color') ?? alertDecls.get('background') ?? '';
      const alertFgRaw = alertDecls.get('color') ?? '';
      expect(alertBgRaw, `.tab-alert-count background declaration missing in CSS`).toBeTruthy();
      expect(alertFgRaw, `.tab-alert-count color declaration missing in CSS`).toBeTruthy();

      const alertBg = resolveColorExpr(alertBgRaw, varMap, bgApp!);
      const alertFg = resolveColorExpr(alertFgRaw, varMap, alertBg ?? bgApp!);
      expect(alertBg, `${preset.id}: failed to resolve .tab-alert-count background "${alertBgRaw}"`).toBeTruthy();
      expect(alertFg, `${preset.id}: failed to resolve .tab-alert-count color "${alertFgRaw}"`).toBeTruthy();
      const alertRatio = contrastRatio(alertFg!, alertBg!);
      if (alertRatio < WCAG_AA) {
        violations.push(
          `${preset.id}: .tab-alert-count color(${alertFgRaw} -> rgb(${alertFg!.join(',')})) on bg(${alertBgRaw} -> rgb(${alertBg!.join(',')})) = ${alertRatio.toFixed(2)}:1 < 4.5:1`
        );
      }
    }

    expect(violations, `WCAG 2.1 AA contrast violations found:\n${violations.join('\n')}`).toEqual([]);
  });

  /* ------------------------------------------------------------------ UT-02 */
  it('UT-02 (F-15)：6 预设导出 → 导入 custom 主题保持 --studio-* surfaceRamp 一致、派生变量 >= 4.5:1，并拦截全部 CSS 注入载荷', async () => {
    // 1) CSS 注入载荷在 tokens 与 surfaceRamp 上均必须被 validateCustomThemeConfig 严格拦截
    const maliciousPayloads = [
      'url(https://evil.example/track.png)',
      'url("javascript:alert(1)")',
      '#112233; background: red',
      '#ffffff} body { display: none',
      'expression(alert(1))',
      'rgba(10, 20, 30, 0.5); --hack: 1',
      '<script>alert(1)</script>',
      '\\000075rl(http://evil.test)',
    ];

    const basePreset = THEME_PRESETS[0];
    for (const bad of maliciousPayloads) {
      expect(isValidCssColorToken(bad), `Payload "${bad}" must be rejected`).toBe(false);
      expect(() =>
        validateCustomThemeConfig({
          name: 'Evil Token Theme',
          polarity: 'dark',
          baseThemeId: basePreset.id,
          tokens: { ...basePreset.tokens, bgApp: bad },
        })
      ).toThrow();
      expect(() =>
        validateCustomThemeConfig({
          name: 'Evil SurfaceRamp Theme',
          polarity: 'dark',
          baseThemeId: basePreset.id,
          tokens: { ...basePreset.tokens },
          surfaceRamp: { canvas: bad },
        })
      ).toThrow();
    }

    // sanitizeCustomThemeConfig 必须丢弃非法 surfaceRamp 键值而保留合法键
    const sanitized = sanitizeCustomThemeConfig({
      name: 'Partial Safe Ramp',
      polarity: 'dark',
      baseThemeId: 'claude-code-dark',
      tokens: { ...basePreset.tokens, bgApp: 'url(http://evil.test)' },
      surfaceRamp: {
        canvas: '#1a1917',
        rail: 'url(http://evil.test)',
        composer: '#2a2825',
      },
    });
    expect(sanitized).toBeDefined();
    expect(sanitized!.tokens.bgApp).toBe(basePreset.tokens.bgApp);
    expect(sanitized!.surfaceRamp?.canvas).toBe('#1a1917');
    expect(sanitized!.surfaceRamp?.composer).toBe('#2a2825');
    expect(sanitized!.surfaceRamp?.rail).toBeUndefined();

    // 2) 对每个预设验证导出 -> 导入 custom 主题时，派生文字变量 >= 4.5:1 且 --studio-* 表面阶梯一致
    const rampByPreset: Record<string, Required<ThemeSurfaceRamp>> = {
      'claude-code-dark': {
        canvas: '#1a1917',
        rail: '#1d1c1a',
        drawer: '#21201d',
        card: '#21201d',
        composer: '#2a2825',
        hairline: 'rgba(242, 236, 228, 0.08)',
      },
      'claude-code-light': {
        canvas: '#f9f7f4',
        rail: '#f2efe9',
        drawer: '#f2efe9',
        card: '#ffffff',
        composer: '#ffffff',
        hairline: 'rgba(26, 22, 19, 0.08)',
      },
      'ubuntu-aubergine': {
        canvas: '#24071b',
        rail: '#2c001e',
        drawer: '#2c001e',
        card: '#370c29',
        composer: '#461435',
        hairline: 'rgba(247, 243, 246, 0.09)',
      },
      'macos-dark': {
        canvas: '#1b1c1f',
        rail: '#1f2023',
        drawer: '#232428',
        card: '#26282c',
        composer: '#2c2e33',
        hairline: 'rgba(245, 245, 247, 0.08)',
      },
      'macos-light': {
        canvas: '#f5f5f7',
        rail: '#ececf0',
        drawer: '#f0f0f4',
        card: '#ffffff',
        composer: '#ffffff',
        hairline: 'rgba(29, 29, 31, 0.09)',
      },
      'solarized-dark': {
        canvas: '#002b36',
        rail: '#073642',
        drawer: '#073642',
        card: '#093d4a',
        composer: '#0f4957',
        hairline: 'rgba(253, 246, 227, 0.09)',
      },
    };

    const surfaceCssVars: Array<[keyof ThemeSurfaceRamp, string[]]> = [
      ['canvas', ['--studio-canvas']],
      ['rail', ['--studio-rail']],
      ['drawer', ['--studio-drawer']],
      ['card', ['--studio-card']],
      ['composer', ['--studio-composer']],
      ['hairline', ['--hairline', '--studio-hairline']],
    ];

    const bridge = createFallbackDesktopBridge();
    const root = document.documentElement;

    for (const preset of THEME_PRESETS) {
      await bridge.updatePreferences({ theme: preset.id });
      const exportedJson = await bridge.exportCustomTheme();
      const parsedExport = JSON.parse(exportedJson) as CustomThemeConfig;
      const customCandidate: CustomThemeConfig = validateCustomThemeConfig({
        ...parsedExport,
        baseThemeId: preset.id,
        polarity: preset.polarity,
        surfaceRamp: parsedExport.surfaceRamp ?? preset.surfaceRamp ?? rampByPreset[preset.id],
      });

      // 通过桥接导入自定义主题
      const updatedPrefs = await bridge.importCustomTheme(JSON.stringify(customCandidate));
      expect(updatedPrefs.theme).toBe('custom');
      expect(updatedPrefs.customTheme?.surfaceRamp).toBeDefined();
      for (const rampKey of THEME_SURFACE_RAMP_KEYS) {
        expect(updatedPrefs.customTheme?.surfaceRamp?.[rampKey]).toBe(customCandidate.surfaceRamp?.[rampKey]);
      }

      // 应用 custom 主题并校验全部 23 调色板变量、派生 AA 变量与 --studio-* 表面阶梯
      applyThemePreference('custom', updatedPrefs.customTheme);
      expect(root.getAttribute('data-theme')).toBe('custom');
      expect(root.getAttribute('data-polarity')).toBe(preset.polarity);

      for (const tokenKey of THEME_TOKEN_KEYS) {
        const expectedVal = customCandidate.tokens[tokenKey];
        expect(expectedVal).toBeTruthy();
      }

      const derived = deriveAccessibleTokens(customCandidate.tokens, customCandidate.polarity);
      const bgApp = parseCssColor(customCandidate.tokens.bgApp)!;
      const bgSurface = parseCssColor(customCandidate.tokens.bgSurface)!;
      for (const cssVar of ['--success-text', '--warning-text', '--danger-text', '--accent-text', '--muted-text', '--secondary-text']) {
        const appliedVar = root.style.getPropertyValue(cssVar).trim();
        expect(appliedVar, `${preset.id} custom missing ${cssVar} on documentElement`).toBe(derived[cssVar]);
        const fg = parseCssColor(appliedVar)!;
        expect(contrastRatio(fg, bgApp)).toBeGreaterThanOrEqual(WCAG_AA);
        expect(contrastRatio(fg, bgSurface)).toBeGreaterThanOrEqual(WCAG_AA);
      }

      // F-15 核心契约：applyThemePreference('custom', ...) 必须把 surfaceRamp 写入 --studio-* 变量，
      // 确保导入的自定义主题与内置预设的 --studio-* 表面阶梯完全一致
      for (const [rampKey, cssVarCandidates] of surfaceCssVars) {
        const expectedRampVal = customCandidate.surfaceRamp![rampKey]!;
        const actualVal = cssVarCandidates
          .map((varName) => root.style.getPropertyValue(varName).trim())
          .find(Boolean);
        expect(
          actualVal,
          `F-15: applyThemePreference('custom') must write surfaceRamp.${rampKey} (${expectedRampVal}) to ${cssVarCandidates.join(' or ')}`
        ).toBe(expectedRampVal);
      }
    }
  });
});
