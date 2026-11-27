import { describe, expect, it } from 'vitest';
import { THEME_PRESETS, type ThemePaletteTokens, type ThemePolarity } from '../src/shared/theme-i18n-contract';
import {
  HEATMAP_RAMP_CSS_VARS,
  HEATMAP_RAMP_LIMITS,
  PRESET_SURFACE_RAMPS,
  contrastRatio,
  deriveHeatmapRamp,
  parseCssColor,
  resolveSurfaceRamp,
  rgbToOklch,
  type HeatmapRamp,
} from '../src/renderer/styles/theme';

/**
 * v0.3.5 热力图 OKLCH 色阶守卫：6 套预设 + 200 组固定种子随机自定义主题，全部以最终 8-bit 十六进制色值实测。
 */

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => {
  const v = parseCssColor(hex);
  if (!v) throw new Error('unparseable ' + hex);
  return v;
};

function cardFor(tokens: ThemePaletteTokens, polarity: ThemePolarity, card?: string): Rgb {
  if (card && parseCssColor(card)) return rgb(card);
  const surface = rgb(tokens.bgSurface);
  const app = rgb(tokens.bgApp);
  if (polarity === 'light') return surface;
  return [0, 1, 2].map((i) => Math.round(app[i] + (surface[i] - app[i]) * 0.92)) as Rgb;
}

function assertRamp(label: string, ramp: HeatmapRamp | null, card: Rgb, polarity: ThemePolarity, accent: string): string[] {
  const errors: string[] = [];
  if (!ramp) return [`${label}: ramp is null`];
  for (const v of HEATMAP_RAMP_CSS_VARS) {
    if (!/^#[0-9a-f]{6}$/.test(ramp[v])) errors.push(`${label}: ${v}=${ramp[v]} is not #rrggbb`);
  }
  const levels = [0, 1, 2, 3, 4].map((i) => rgb(ramp[`--hm-${i}` as keyof HeatmapRamp]));
  const borderContrast = contrastRatio(rgb(ramp['--hm-0-border']), card);
  if (borderContrast < 1.35) errors.push(`${label}: --hm-0-border vs card ${borderContrast.toFixed(3)}`);
  const vsCard = levels.map((lv) => contrastRatio(lv, card));
  for (let i = 0; i < 4; i += 1) {
    if (!(vsCard[i + 1] > vsCard[i])) {
      errors.push(`${label}: non-monotonic vs card hm-${i}(${vsCard[i].toFixed(3)}) -> hm-${i + 1}(${vsCard[i + 1].toFixed(3)})`);
    }
  }
  const top = vsCard[4];
  if (top < HEATMAP_RAMP_LIMITS.topVsCard) errors.push(`${label}: hm-4 vs card ${top.toFixed(3)}`);
  const first = contrastRatio(levels[0], levels[1]);
  if (first < HEATMAP_RAMP_LIMITS.firstStep) errors.push(`${label}: hm-0→hm-1 ${first.toFixed(3)}`);
  for (let i = 1; i < 4; i += 1) {
    const step = contrastRatio(levels[i], levels[i + 1]);
    if (step < HEATMAP_RAMP_LIMITS.adjacentStep) errors.push(`${label}: hm-${i}→hm-${i + 1} ${step.toFixed(3)}`);
  }
  for (let i = 0; i < 5; i += 1) {
    const ink = rgb(ramp[`--hm-ink-${i}` as keyof HeatmapRamp]);
    const c = contrastRatio(ink, levels[i]);
    if (c < HEATMAP_RAMP_LIMITS.inkContrast) errors.push(`${label}: ink-${i} ${c.toFixed(3)}`);
  }
  // 浅色模式（且色阶向深处走时）L1 ≤ 0.86
  const goesDarker = contrastRatio(levels[4], [0, 0, 0]) < contrastRatio(card, [0, 0, 0]);
  if (polarity === 'light' && goesDarker) {
    const l1 = rgbToOklch(levels[1]).l;
    if (l1 > HEATMAP_RAMP_LIMITS.lightL1Max + 1e-9) errors.push(`${label}: light L1 ${l1.toFixed(4)}`);
  }
  // 中性灰 accent 退化为中性灰阶
  if (rgbToOklch(rgb(accent)).c < HEATMAP_RAMP_LIMITS.neutralChroma) {
    for (let i = 0; i < 5; i += 1) {
      const c = rgbToOklch(levels[i]).c;
      if (c > 0.012) errors.push(`${label}: neutral accent but hm-${i} chroma ${c.toFixed(4)}`);
    }
  }
  return errors;
}

/** mulberry32 固定种子 PRNG */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');

describe('v0.3.5 deriveHeatmapRamp · OKLCH 热力色阶', () => {
  it('6 套预设主题全部达标（hm-4 ≥ 4.5、首档 ≥ 1.38、相邻 ≥ 1.30、文字 AA、浅色 L1 ≤ 0.86）', () => {
    expect(THEME_PRESETS.length).toBe(6);
    const errors: string[] = [];
    for (const preset of THEME_PRESETS) {
      const card = resolveSurfaceRamp(preset.id, preset)?.card ?? PRESET_SURFACE_RAMPS[preset.id]?.card;
      const ramp = deriveHeatmapRamp(preset.tokens, preset.polarity, card);
      errors.push(...assertRamp(preset.id, ramp, cardFor(preset.tokens, preset.polarity, card), preset.polarity, preset.tokens.accentPrimary));
    }
    expect(errors).toEqual([]);
  });

  it('200 组固定种子随机自定义主题 100% 达标（含中灰卡片、中性灰 accent、无 surfaceRamp）', () => {
    const rand = prng(0x35_2026);
    const errors: string[] = [];
    let neutralCount = 0;
    for (let n = 0; n < 200; n += 1) {
      const polarity: ThemePolarity = rand() < 0.5 ? 'light' : 'dark';
      const base = THEME_PRESETS.find((p) => p.polarity === polarity)!;
      const surfLum = polarity === 'light' ? 150 + rand() * 105 : rand() * 120;
      const tint = () => (rand() - 0.5) * 30;
      const bgSurface = hex(surfLum + tint(), surfLum + tint(), surfLum + tint());
      const bgApp = hex(surfLum - 6 + tint(), surfLum - 6 + tint(), surfLum - 6 + tint());
      const neutralAccent = n % 10 === 0;
      if (neutralAccent) neutralCount += 1;
      const g = rand() * 255;
      const accentPrimary = neutralAccent ? hex(g, g, g) : hex(rand() * 255, rand() * 255, rand() * 255);
      const textPrimary = polarity === 'light' ? hex(rand() * 60, rand() * 60, rand() * 60) : hex(200 + rand() * 55, 200 + rand() * 55, 200 + rand() * 55);
      const tokens: ThemePaletteTokens = { ...base.tokens, bgSurface, bgApp, accentPrimary, textPrimary };
      const card = rand() < 0.3 ? hex(surfLum + tint(), surfLum + tint(), surfLum + tint()) : undefined;
      const ramp = deriveHeatmapRamp(tokens, polarity, card);
      errors.push(...assertRamp(`seed#${n}(${polarity},${accentPrimary},${card ?? bgSurface})`, ramp, cardFor(tokens, polarity, card), polarity, accentPrimary));
    }
    expect(neutralCount).toBe(20);
    expect(errors).toEqual([]);
  });

  it('极端中灰卡片（两向均仅能勉强达到 4.5:1）仍可生成合法色阶', () => {
    const base = THEME_PRESETS[0];
    for (const card of ['#767676', '#777777', '#808080', '#6b6b6b', '#8a8a8a']) {
      for (const polarity of ['light', 'dark'] as const) {
        const ramp = deriveHeatmapRamp({ ...base.tokens, accentPrimary: '#d97757' }, polarity, card);
        expect(assertRamp(`gray ${card} ${polarity}`, ramp, rgb(card), polarity, '#d97757')).toEqual([]);
      }
    }
  });

  it('中性灰 accent（C < 0.03）退化为中性灰阶，彩色 accent 保留色相', () => {
    const light = THEME_PRESETS.find((p) => p.id === 'claude-code-light')!;
    const gray = deriveHeatmapRamp({ ...light.tokens, accentPrimary: '#6b6b6b' }, 'light', '#ffffff')!;
    for (let i = 0; i < 5; i += 1) expect(rgbToOklch(rgb(gray[`--hm-${i}` as keyof HeatmapRamp])).c).toBeLessThan(0.012);
    const warm = deriveHeatmapRamp(light.tokens, 'light', '#ffffff')!;
    const accentHue = rgbToOklch(rgb(light.tokens.accentPrimary)).h;
    const hm3 = rgbToOklch(rgb(warm['--hm-3']));
    expect(hm3.c).toBeGreaterThan(0.05);
    expect(Math.abs(hm3.h - accentHue)).toBeLessThan(12);
  });
});
