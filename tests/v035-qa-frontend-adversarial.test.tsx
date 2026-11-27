// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_TRANSLATION_CONFIG,
  THEME_PRESETS,
  computeHeatLevel,
  type AcpConnectionStatus,
  type AccountQuota,
  type ApproveForMeConfig,
  type ClientLocale,
  type ClientPreferences,
  type DailyCalendarHeatmapCell,
  type GravityDesktopBridge,
  type HourlyTokenBarBucket,
  type PlanArtifactChangedEvent,
  type PlanArtifactSnapshot,
  type PluginsManagerSnapshot,
  type QuestionFollowupMetadata,
  type RightInspectorTab,
  type SessionInspectorData,
  type TelemetryDashboardSnapshot,
  type ThemePaletteTokens,
  type ThemePolarity,
  type UserQuestion,
} from '../src/shared';
import {
  HEATMAP_RAMP_CSS_VARS,
  HEATMAP_RAMP_LIMITS,
  PRESET_SURFACE_RAMPS,
  applyThemePreference,
  contrastRatio,
  deriveHeatmapRamp,
  parseCssColor,
  resolveSurfaceRamp,
  rgbToOklch,
  type HeatmapRamp,
} from '../src/renderer/styles/theme';
import { TokenHeatmapView } from '../src/renderer/components/context/TokenHeatmapView';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { QuestionBar } from '../src/renderer/components/QuestionBar';
import { QuestionFollowupStatus } from '../src/renderer/components/QuestionFollowupStatus';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { PlanArtifactPanel } from '../src/renderer/components/PlanArtifactPanel';
import { ApprovalsPanel, PluginsPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { IconsPanel } from '../src/renderer/components/settings/AppearancePanels';
import { SettingsView, type SettingsSection } from '../src/renderer/components/SettingsView';
import { AccountQuotaFooter } from '../src/renderer/components/AccountQuotaView';
import { AccountQuotaFeed, resetAccountQuotaFeeds } from '../src/renderer/lib/account-quota-feed';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

/**
 * Gravity v0.3.5 Neon-FE QA 阶段 C 增补对抗测试套件
 * 覆盖获批全部 10 项前端对抗用例（HM-T1b, HM-T4b, Q-T2b, Q-T3b, Q-T4b, P-T2b, MO-T1b, FE-P1b, FE-P2b, FE-P3b）
 * 以及跨端 D-01 与阶段 A 全部前端边界缺陷 FE-BUG-03..09 回归锁定。
 */

function wrap(child: React.ReactNode, locale: ClientLocale = 'zh-CN') {
  return (
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      {child}
    </I18nProvider>
  );
}

type Rgb = [number, number, number];
const mustRgb = (hex: string): Rgb => {
  const v = parseCssColor(hex);
  if (!v) throw new Error('unparseable color: ' + hex);
  return v;
};

function resolveCardRgb(tokens: ThemePaletteTokens, polarity: ThemePolarity, card?: string): Rgb {
  if (card && parseCssColor(card)) return mustRgb(card);
  const surface = mustRgb(tokens.bgSurface);
  const app = mustRgb(tokens.bgApp);
  if (polarity === 'light') return surface;
  return [0, 1, 2].map((i) => Math.round(app[i] + (surface[i] - app[i]) * 0.92)) as Rgb;
}

function makeSeededPrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');

function makePreferences(overrides: Partial<ClientPreferences> = {}): ClientPreferences {
  return {
    theme: 'claude-code-dark',
    locale: 'zh-CN',
    uiScale: 1,
    appIcon: 'auto',
    defaultThoughtTrack: 'zh',
    translationEngine: 'local',
    processPerSession: false,
    activeProfileId: 'default',
    ...overrides,
  };
}

function makeConnection(overrides: Partial<AcpConnectionStatus> = {}): AcpConnectionStatus {
  return {
    connected: true,
    agyBinaryPath: '/usr/local/bin/agy',
    agyVersion: '1.0.0',
    activeSessionCount: 1,
    maxParallelSessions: 4,
    activeProfileId: 'default',
    availableModels: [{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
    ...overrides,
  };
}

function makePluginsSnapshot(): PluginsManagerSnapshot {
  return {
    builtins: [
      {
        id: 'builtin-approve-for-me',
        name: 'Approve for me',
        badge: 'Built-in',
        descriptionZh: '内置审批',
        descriptionEn: 'Built-in approval',
        enabled: true,
      },
    ],
    plugins: [],
    mcpServers: [],
    skills: [],
    refreshedAt: '2026-11-27T01:00:00.000Z',
  };
}

const ZERO_COST = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  totalTokens: 0,
  inputCostUsd: 0,
  cachedInputCostUsd: 0,
  outputCostUsd: 0,
  thinkingCostUsd: 0,
  totalCostUsd: 0,
};

function makeSharedHeatmapData() {
  const hourly24h: HourlyTokenBarBucket[] = [
    {
      hourKey: '2026-11-01T01-edt',
      hourLabel: '01:00',
      startIso: '2026-11-01T01:00:00-04:00',
      inputTokens: 1_500,
      cachedInputTokens: 0,
      outputTokens: 300,
      thinkingTokens: 0,
      totalTokens: 1_800,
      costUsd: 0.012,
      intensity: 1,
    },
    {
      hourKey: '2026-11-01T01-est',
      hourLabel: '01:00',
      startIso: '2026-11-01T01:00:00-05:00',
      inputTokens: 28_000,
      cachedInputTokens: 2_000,
      outputTokens: 4_000,
      thinkingTokens: 1_000,
      totalTokens: 35_000,
      costUsd: 0.21,
      intensity: 4,
    },
    {
      hourKey: '2026-11-01T06-np',
      hourLabel: '06:00',
      startIso: '2026-11-01T06:00:00+05:45',
      inputTokens: 6_000,
      cachedInputTokens: 0,
      outputTokens: 1_200,
      thinkingTokens: 0,
      totalTokens: 7_200,
      costUsd: 0.045,
      intensity: 2,
    },
    {
      hourKey: '2026-11-01T09-utc',
      hourLabel: '09:00',
      startIso: '2026-11-01T09:00:00Z',
      inputTokens: 14_000,
      cachedInputTokens: 0,
      outputTokens: 2_000,
      thinkingTokens: 0,
      totalTokens: 16_000,
      costUsd: 0.09,
      intensity: 3,
    },
    {
      // 旧快照缺失 startIso -> 回退 hourLabel
      hourKey: '2026-11-01T12-legacy',
      hourLabel: '12:00',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      intensity: 0,
    },
  ];

  const intensities: Array<0 | 1 | 2 | 3 | 4> = [0, 1, 2, 3, 4, 2, 3];
  const daily7d: DailyCalendarHeatmapCell[] = intensities.map((level, i) => ({
    date: `2026-11-${String(21 + i).padStart(2, '0')}`,
    inputTokens: level * 15_000,
    cachedInputTokens: level * 3_000,
    outputTokens: level * 4_000,
    thinkingTokens: level * 1_000,
    totalTokens: level * 23_000,
    costUsd: level * 0.11,
    sessionCount: level > 0 ? level : 0,
    intensity: level,
  }));

  const calendar30d: DailyCalendarHeatmapCell[] = Array.from({ length: 30 }, (_, i) => {
    const dt = new Date(2026, 9, 29 + i);
    const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const level = (i % 5) as 0 | 1 | 2 | 3 | 4;
    return {
      date,
      inputTokens: level * 10_000,
      cachedInputTokens: 0,
      outputTokens: level * 2_000,
      thinkingTokens: 0,
      totalTokens: level * 12_000,
      costUsd: level * 0.08,
      sessionCount: level > 0 ? 1 : 0,
      intensity: level,
    };
  });

  return { hourly24h, daily7d, calendar30d };
}

function makeDashboardWithSharedHeatmap(): TelemetryDashboardSnapshot {
  const { hourly24h, daily7d, calendar30d } = makeSharedHeatmapData();
  const baseExt = {
    cumulativeProviders: [],
    bySession: {},
    hourly24h,
    daily7d,
    matrix7d: [],
    calendar30d,
    costByRange: {
      today: { ...ZERO_COST, callCount: 5 },
      '7d': { ...ZERO_COST, callCount: 12 },
      '30d': { ...ZERO_COST, callCount: 30 },
    },
    providerBreakdownByRange: { today: [], '7d': [], '30d': [] },
    updatedAt: '2026-11-27T01:00:00.000Z',
  };
  return {
    generatedAt: '2026-11-27T01:00:00.000Z',
    pricingSource: 'reference-api-estimate',
    activeSessions: {},
    rateCards: [],
    hourly24h,
    daily7d,
    matrix7d: [],
    calendar30d,
    costByRange: { today: ZERO_COST, '7d': ZERO_COST, '30d': ZERO_COST },
    modelBreakdownByRange: { today: [], '7d': [], '30d': [] },
    sessionModelBreakdowns: {},
    externalReviewer: {
      ...baseExt,
      cumulativeAllTime: {
        ...ZERO_COST,
        callCount: 10,
        approvedCount: 8,
        askCount: 1,
        denyCount: 1,
        errorCount: 0,
        providerCount: 1,
      },
    },
    externalTranslator: {
      ...baseExt,
      cumulativeAllTime: {
        ...ZERO_COST,
        callCount: 14,
        successCount: 13,
        fallbackCount: 1,
        errorCount: 0,
        providerCount: 1,
      },
    },
  };
}

function mockMatchMedia(reducedMotion: boolean) {
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce') ? reducedMotion : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

beforeEach(() => {
  delete window.gravityDesktop;
  resetFallbackDesktopBridge();
  resetAccountQuotaFeeds();
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  resetAccountQuotaFeeds();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-polarity');
  document.documentElement.removeAttribute('style');
});

/* =========================================================================
 * HM-T1b：6 套真实预设 + 3 样例 + 200 种子 OKLCH 色阶、--hm-0-border、单调性与 OKLab ΔL
 * ======================================================================= */
describe('HM-T1b：热力图 OKLCH 色阶全量严格守卫（6 预设 + 3 样例 + 200 种子）', () => {
  function auditRampStrict(label: string, ramp: HeatmapRamp | null, card: Rgb, polarity: ThemePolarity, accent: string): string[] {
    const errors: string[] = [];
    if (!ramp) return [`${label}: ramp is null`];
    for (const cssVar of HEATMAP_RAMP_CSS_VARS) {
      if (!/^#[0-9a-f]{6}$/.test(ramp[cssVar])) errors.push(`${label}: invalid hex ${cssVar}=${ramp[cssVar]}`);
    }
    const levels = [0, 1, 2, 3, 4].map((i) => mustRgb(ramp[`--hm-${i}` as keyof HeatmapRamp]));
    const borderRgb = mustRgb(ramp['--hm-0-border']);
    const borderVsCard = contrastRatio(borderRgb, card);
    if (borderVsCard < 1.35) errors.push(`${label}: --hm-0-border vs card ${borderVsCard.toFixed(3)} < 1.35`);

    const vsCard = levels.map((lv) => contrastRatio(lv, card));
    for (let i = 0; i < 4; i += 1) {
      if (!(vsCard[i + 1] > vsCard[i])) {
        errors.push(`${label}: contrast vs card not strictly increasing hm-${i}(${vsCard[i].toFixed(3)}) -> hm-${i + 1}(${vsCard[i + 1].toFixed(3)})`);
      }
    }
    if (vsCard[4] < HEATMAP_RAMP_LIMITS.topVsCard) errors.push(`${label}: hm-4 vs card ${vsCard[4].toFixed(3)} < 4.5`);
    if (contrastRatio(levels[0], levels[1]) < HEATMAP_RAMP_LIMITS.firstStep) {
      errors.push(`${label}: hm-0 -> hm-1 ${contrastRatio(levels[0], levels[1]).toFixed(3)} < 1.38`);
    }
    for (let i = 1; i < 4; i += 1) {
      const adj = contrastRatio(levels[i], levels[i + 1]);
      if (adj < HEATMAP_RAMP_LIMITS.adjacentStep) {
        errors.push(`${label}: hm-${i} -> hm-${i + 1} ${adj.toFixed(3)} < 1.30`);
      }
    }

    // OKLab ΔL 感知阶梯守卫：每档亮度沿同一方向推进，且相邻档 ΔL 具备清晰肉眼分辨度（≥ 0.045）
    const lVals = levels.map((lv) => rgbToOklch(lv).l);
    const dir = lVals[4] > lVals[0] ? 1 : -1;
    for (let i = 0; i < 4; i += 1) {
      const signedDeltaL = (lVals[i + 1] - lVals[i]) * dir;
      if (signedDeltaL < 0.045) {
        errors.push(`${label}: OKLab ΔL hm-${i}→hm-${i + 1} = ${signedDeltaL.toFixed(4)} < 0.045`);
      }
    }

    // 每档文字对比度 >= 4.5 AA
    for (let i = 0; i < 5; i += 1) {
      const ink = mustRgb(ramp[`--hm-ink-${i}` as keyof HeatmapRamp]);
      const c = contrastRatio(ink, levels[i]);
      if (c < HEATMAP_RAMP_LIMITS.inkContrast) errors.push(`${label}: ink-${i} ${c.toFixed(3)} < 4.5`);
    }

    // 浅色主题向深处递增时 L1 <= 0.86
    const goesDarker = contrastRatio(levels[4], [0, 0, 0]) < contrastRatio(card, [0, 0, 0]);
    if (polarity === 'light' && goesDarker) {
      if (lVals[1] > HEATMAP_RAMP_LIMITS.lightL1Max + 1e-9) {
        errors.push(`${label}: light L1=${lVals[1].toFixed(4)} > 0.86`);
      }
    }

    // 中性灰 accent（C < 0.03）退化为纯中性灰阶不偏黄
    if (rgbToOklch(mustRgb(accent)).c < HEATMAP_RAMP_LIMITS.neutralChroma) {
      for (let i = 0; i < 5; i += 1) {
        const chroma = rgbToOklch(levels[i]).c;
        if (chroma > 0.012) errors.push(`${label}: neutral accent leaked chroma hm-${i}=${chroma.toFixed(4)}`);
      }
    }
    return errors;
  }

  it('锁定 6 套真实内置预设 ID + 写入 DOM CSS 变量 + 3 样例自定义主题（含 #777777 中性灰）+ 200 种子', () => {
    expect(THEME_PRESETS.map((p) => p.id)).toEqual([
      'claude-code-dark',
      'claude-code-light',
      'ubuntu-aubergine',
      'macos-dark',
      'macos-light',
      'solarized-dark',
    ]);

    const errors: string[] = [];
    for (const preset of THEME_PRESETS) {
      const card = resolveSurfaceRamp(preset.id, preset)?.card ?? PRESET_SURFACE_RAMPS[preset.id]?.card;
      const ramp = deriveHeatmapRamp(preset.tokens, preset.polarity, card);
      errors.push(...auditRampStrict(`preset:${preset.id}`, ramp, resolveCardRgb(preset.tokens, preset.polarity, card), preset.polarity, preset.tokens.accentPrimary));

      // applyThemePreference 必须将全部 11 个 --hm-* 变量写入 :root
      applyThemePreference(preset.id);
      for (const cssVar of HEATMAP_RAMP_CSS_VARS) {
        expect(document.documentElement.style.getPropertyValue(cssVar).trim()).toBe(ramp![cssVar]);
      }
    }

    // 3 套代表性自定义样例主题（高饱和暖暗、极浅高明度亮底、中性灰 #777777 accent）
    const samples: Array<{ name: string; polarity: ThemePolarity; tokens: ThemePaletteTokens; card: string }> = [
      {
        name: 'sample-crimson-obsidian',
        polarity: 'dark',
        tokens: { ...THEME_PRESETS[0].tokens, bgApp: '#121014', bgSurface: '#1c1820', accentPrimary: '#f43f5e' },
        card: '#1c1820',
      },
      {
        name: 'sample-mint-paper',
        polarity: 'light',
        tokens: { ...THEME_PRESETS[1].tokens, bgApp: '#f4fbf8', bgSurface: '#ffffff', accentPrimary: '#0d9488' },
        card: '#ffffff',
      },
      {
        name: 'sample-neutral-777-light',
        polarity: 'light',
        tokens: { ...THEME_PRESETS[4].tokens, bgApp: '#f5f5f5', bgSurface: '#ffffff', accentPrimary: '#777777' },
        card: '#ffffff',
      },
    ];
    for (const s of samples) {
      const ramp = deriveHeatmapRamp(s.tokens, s.polarity, s.card);
      errors.push(...auditRampStrict(s.name, ramp, mustRgb(s.card), s.polarity, s.tokens.accentPrimary));
    }

    // 独立 QA 种子 200 组随机自定义主题（含 20 组中性灰 #777777/#888888 accent 与深/浅随机卡片）
    const rand = makeSeededPrng(0x51a_2026);
    for (let n = 0; n < 200; n += 1) {
      const polarity: ThemePolarity = rand() < 0.5 ? 'light' : 'dark';
      const base = THEME_PRESETS.find((p) => p.polarity === polarity)!;
      const lum = polarity === 'light' ? 165 + rand() * 90 : rand() * 110;
      const jitter = () => (rand() - 0.5) * 24;
      const bgSurface = toHex(lum + jitter(), lum + jitter(), lum + jitter());
      const bgApp = toHex(lum - 5 + jitter(), lum - 5 + jitter(), lum - 5 + jitter());
      const isNeutral = n % 10 === 0;
      const accentPrimary = isNeutral ? '#777777' : toHex(rand() * 255, rand() * 255, rand() * 255);
      const textPrimary = polarity === 'light' ? '#1c1c1e' : '#f4f4f6';
      const tokens: ThemePaletteTokens = { ...base.tokens, bgApp, bgSurface, accentPrimary, textPrimary };
      const card = rand() < 0.4 ? bgSurface : undefined;
      const ramp = deriveHeatmapRamp(tokens, polarity, card);
      errors.push(...auditRampStrict(`qa-seed#${n}(${polarity},${accentPrimary})`, ramp, resolveCardRgb(tokens, polarity, card), polarity, accentPrimary));
    }

    expect(errors).toEqual([]);
  });
});

/* =========================================================================
 * HM-T4b：三视图一致 + 24h startIso DST/+05:45 偏移 + 24h 键盘漫游 + 空挂异步到达
 * ======================================================================= */
describe('HM-T4b：主 Context / 外部复核 / 外部翻译三视图热力图一致与无障碍播报', () => {
  it('三视图 24h/7d/30d 同格 intensity 完全一致，24h 精准展示 DST 双 01:00 与 +05:45，hover 不写 aria-live 而键盘聚焦播报', () => {
    const dashboard = makeDashboardWithSharedHeatmap();
    render(
      wrap(
        <ContextCostInspectorView
          sessionId={null}
          dashboard={dashboard}
          reviewerConnected={true}
          translatorConnected={true}
          onOpenRateCardsSettings={vi.fn()}
        />
      )
    );

    const viewDefs: Array<{ tabTestId: string; prefix: string }> = [
      { tabTestId: 'ctx-view-switch-context', prefix: '' },
      { tabTestId: 'ctx-view-switch-reviewer', prefix: 'reviewer-' },
      { tabTestId: 'ctx-view-switch-translator', prefix: 'translator-' },
    ];

    const levels24hByView: string[][] = [];
    const classes7dByView: string[][] = [];
    const classes30dByView: string[][] = [];

    for (const v of viewDefs) {
      fireEvent.click(screen.getByTestId(v.tabTestId));

      // 24h 视图校验
      fireEvent.click(screen.getByTestId(`${v.prefix}heatmap-range-24h`));
      const barsWrap = screen.getByTestId(`${v.prefix}heatmap-24h-bars`);
      const bars = Array.from(barsWrap.querySelectorAll<HTMLElement>('.hm-bar'));
      expect(bars).toHaveLength(5);
      levels24hByView.push(bars.map((b) => b.dataset.level ?? ''));

      expect(bars[0].getAttribute('title')).toContain('2026-11-01 01:00 (-04:00)');
      expect(bars[1].getAttribute('title')).toContain('2026-11-01 01:00 (-05:00)');
      expect(bars[2].getAttribute('title')).toContain('2026-11-01 06:00 (+05:45)');
      expect(bars[3].getAttribute('title')).toContain('2026-11-01 09:00 (+00:00)');
      expect(bars[4].getAttribute('title')).toContain('12:00');

      const live = screen.getByTestId(`${v.prefix}heatmap-live`);
      // Hover 仅更新可见读数，绝不写入 aria-live
      fireEvent.mouseEnter(bars[1]);
      expect(live.textContent).toBe('');

      // 键盘聚焦 + ArrowLeft/Home/End 漫游 -> 写入 aria-live
      act(() => {
        bars[4].focus();
      });
      expect(live.textContent).toContain('12:00');
      fireEvent.keyDown(bars[4], { key: 'Home' });
      expect(document.activeElement).toBe(bars[0]);
      expect(live.textContent).toContain('-04:00');
      fireEvent.keyDown(bars[0], { key: 'ArrowRight' });
      expect(document.activeElement).toBe(bars[1]);
      expect(live.textContent).toContain('-05:00');

      // 7d 视图校验
      fireEvent.click(screen.getByTestId(`${v.prefix}heatmap-range-7d`));
      const cards7 = Array.from(screen.getByTestId(`${v.prefix}heatmap-7d-matrix`).querySelectorAll<HTMLElement>('.heatmap-cell'));
      expect(cards7).toHaveLength(7);
      classes7dByView.push(cards7.map((c) => c.className.match(/i-(\d)/)?.[1] ?? ''));

      // 30d 视图校验
      fireEvent.click(screen.getByTestId(`${v.prefix}heatmap-range-30d`));
      const cells30 = Array.from(screen.getByTestId(`${v.prefix}heatmap-30d-calendar`).querySelectorAll<HTMLElement>('.heatmap-cell'));
      expect(cells30).toHaveLength(30);
      classes30dByView.push(cells30.map((c) => c.className.match(/i-(\d)/)?.[1] ?? ''));

      // 图例标注双轴强度含义（不含硬编码门槛数字）
      const hmCard = cells30[0].closest('.hm-card')!;
      expect(hmCard.textContent).toContain('绝对用量 × 窗口占比');
    }

    expect(levels24hByView[0]).toEqual(['1', '4', '2', '3', '0']);
    expect(levels24hByView[1]).toEqual(levels24hByView[0]);
    expect(levels24hByView[2]).toEqual(levels24hByView[0]);

    expect(classes7dByView[0]).toEqual(['0', '1', '2', '3', '4', '2', '3']);
    expect(classes7dByView[1]).toEqual(classes7dByView[0]);
    expect(classes7dByView[2]).toEqual(classes7dByView[0]);

    expect(classes30dByView[1]).toEqual(classes30dByView[0]);
    expect(classes30dByView[2]).toEqual(classes30dByView[0]);
  });

  it('FE-BUG-09：空挂载后异步数据到达自动聚焦最新格，且用户手动选格后不被后续刷新重置', () => {
    const { daily7d } = makeSharedHeatmapData();
    const { rerender } = render(
      wrap(<TokenHeatmapView testIdPrefix="" sectionTestId="hm" title="Token" hourly24h={[]} daily7d={[]} calendar30d={[]} />)
    );
    fireEvent.click(screen.getByTestId('heatmap-range-7d'));
    rerender(
      wrap(<TokenHeatmapView testIdPrefix="" sectionTestId="hm" title="Token" hourly24h={[]} daily7d={daily7d} calendar30d={daily7d} />)
    );
    expect(screen.getByTestId('heatmap-7d-day-2026-11-27').getAttribute('tabindex')).toBe('0');

    // 用户手动聚焦第 2 天后再更新数据 -> 保持用户所选，不跳回最新一天
    const secondDay = screen.getByTestId('heatmap-7d-day-2026-11-22');
    act(() => {
      secondDay.focus();
    });
    expect(secondDay.getAttribute('tabindex')).toBe('0');
    rerender(
      wrap(<TokenHeatmapView testIdPrefix="" sectionTestId="hm" title="Token" hourly24h={[]} daily7d={[...daily7d]} calendar30d={daily7d} />)
    );
    expect(screen.getByTestId('heatmap-7d-day-2026-11-22').getAttribute('tabindex')).toBe('0');
  });
});

/* =========================================================================
 * Q-T2b / Q-T3b / Q-T4b：QuestionBar v2 铅笔编辑 IME、maxItems、预览/重提/5态投影与数字输入
 * ======================================================================= */
const FOUR_Q: UserQuestion = {
  message: '开始前请确认 4 项细节：',
  state: 'open',
  submissionVersion: 2,
  fields: [
    {
      name: 'db',
      title: '1. 使用哪种数据库？',
      type: 'string',
      required: true,
      choices: [
        { value: 'pg', label: 'PostgreSQL' },
        { value: 'sqlite', label: 'SQLite' },
      ],
    },
    {
      name: 'modules',
      title: '2. 需要哪些模块？',
      type: 'array',
      required: true,
      maxItems: 2,
      choices: [
        { value: 'auth', label: '认证' },
        { value: 'billing', label: '计费' },
        { value: 'audit', label: '审计' },
      ],
    },
    {
      name: 'threshold',
      title: '3. 阈值系数',
      type: 'number',
      required: true,
      minimum: -10,
      maximum: 10,
    },
    {
      name: 'note',
      title: '4. 备注',
      type: 'string',
      required: false,
    },
  ],
};

describe('Q-T2b / Q-T3b / Q-T4b：Plan 提问卡 v2 对抗与边界验证', () => {
  it('Q-T2b：铅笔编辑聚焦并全选；IME 组合态 Enter/Esc/Ctrl+Enter 0 误触发；编辑中按 Ctrl+Enter 带入在编文案', async () => {
    const singleV2: UserQuestion = { ...FOUR_Q, fields: [FOUR_Q.fields[0]] };
    const submit = vi.fn().mockResolvedValue({ mode: 'followup', submissionId: 's-ime', followupState: 'queued' });
    render(wrap(<QuestionBar question={singleV2} draftKey="qa-qt2b" native={true} submit={submit} />));
    const bar = within(screen.getByTestId('question-bar'));

    // 点击铅笔：自动选中该项、聚焦且全选
    fireEvent.click(bar.getByRole('button', { name: '编辑选项「SQLite」' }));
    const editInput = bar.getByRole('textbox', { name: '修改选项 SQLite' }) as HTMLInputElement;
    expect(document.activeElement).toBe(editInput);
    expect(editInput.selectionStart).toBe(0);
    expect(editInput.selectionEnd).toBe('SQLite'.length);

    fireEvent.change(editInput, { target: { value: 'SQLite 开启 WAL 与外键' } });

    // IME 组合态（isComposing: true 以及 keyCode: 229）：Enter / Escape / Ctrl+Enter 均不触发确认、取消或提交
    fireEvent.keyDown(editInput, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(editInput, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(editInput, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(editInput, { key: 'Escape', keyCode: 229 });
    fireEvent.keyDown(editInput, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(editInput, { key: 'Enter', ctrlKey: true, keyCode: 229 });

    expect(bar.getByRole('textbox', { name: '修改选项 SQLite' })).toBe(editInput);
    expect(screen.queryByTestId('question-followup-preview')).toBeNull();
    expect(submit).not.toHaveBeenCalled();

    // 在编辑态直接按 Ctrl+Enter -> 自动并入在编文案并进入 v2 改写预览页
    await act(async () => {
      fireEvent.keyDown(editInput, { key: 'Enter', ctrlKey: true });
    });
    const preview = screen.getByTestId('question-followup-preview');
    expect(preview.textContent).toContain('SQLite 开启 WAL 与外键');
    expect(preview.textContent).toContain('原选项：SQLite');
    expect(submit).not.toHaveBeenCalled();

    // 预览态按 Ctrl+Enter 直接投递 preview
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('question-bar'), { key: 'Enter', ctrlKey: true });
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      delivery: 'followup',
      optionEdits: { db: { sqlite: 'SQLite 开启 WAL 与外键' } },
    });
  });

  it('Q-T3b：多选题 maxItems=2 展示上限并阻断第 3 项勾选与铅笔；取消勾选已编辑项保留草稿，重选恢复', () => {
    const multiOnly: UserQuestion = { ...FOUR_Q, fields: [FOUR_Q.fields[1]] };
    render(wrap(<QuestionBar question={multiOnly} draftKey="qa-qt3b" native={true} submit={vi.fn().mockResolvedValue(undefined)} />));
    const bar = within(screen.getByTestId('question-bar'));

    expect(screen.getByTestId('question-max-items-modules').textContent).toContain('2');

    // 先对「认证」进行铅笔编辑
    fireEvent.click(bar.getByRole('button', { name: '编辑选项「认证」' }));
    const editAuth = bar.getByRole('textbox', { name: '修改选项 认证' });
    fireEvent.change(editAuth, { target: { value: '认证（OAuth2 + PKCE）' } });
    fireEvent.keyDown(editAuth, { key: 'Enter' });
    expect(bar.getByRole('checkbox', { name: /认证（OAuth2 \+ PKCE）/ }).getAttribute('aria-checked')).toBe('true');

    // 勾选第 2 项「计费」-> 达到 maxItems=2，第 3 项「审计」的 checkbox 与铅笔均禁用
    fireEvent.click(bar.getByRole('checkbox', { name: '计费' }));
    const thirdCb = bar.getByRole('checkbox', { name: '审计' }) as HTMLButtonElement;
    const thirdPencil = bar.getByRole('button', { name: '编辑选项「审计」' }) as HTMLButtonElement;
    expect(thirdCb.disabled).toBe(true);
    expect(thirdPencil.disabled).toBe(true);
    fireEvent.click(thirdCb);
    fireEvent.click(thirdPencil);
    expect(thirdCb.getAttribute('aria-checked')).toBe('false');
    expect(bar.queryByRole('textbox', { name: '修改选项 审计' })).toBeNull();

    // 取消勾选已编辑的「认证」-> 草稿保留、第 3 项解锁；重新勾选「认证」恢复改写文案
    fireEvent.click(bar.getByRole('checkbox', { name: /认证（OAuth2 \+ PKCE）/ }));
    expect(bar.getByRole('checkbox', { name: /认证（OAuth2 \+ PKCE）/ }).getAttribute('aria-checked')).toBe('false');
    expect((bar.getByRole('checkbox', { name: '审计' }) as HTMLButtonElement).disabled).toBe(false);
    expect(bar.getByText('已编辑')).toBeTruthy();

    fireEvent.click(bar.getByRole('checkbox', { name: /认证（OAuth2 \+ PKCE）/ }));
    expect(bar.getByRole('checkbox', { name: /认证（OAuth2 \+ PKCE）/ }).getAttribute('aria-checked')).toBe('true');
    expect(bar.getByText('认证（OAuth2 + PKCE）')).toBeTruthy();
  });

  it('Q-T4b：预览态隐藏步进器并忽略左右方向键、返回修改生成新 submissionId、直发清空草稿无回写、数字中间态与 5 态投影全覆盖', async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('临时断连'))
      .mockResolvedValue({ mode: 'followup', submissionId: 'ok', followupState: 'queued' });
    render(wrap(<QuestionBar question={FOUR_Q} draftKey="qa-qt4b" native={true} submit={submit} />));
    const bar = within(screen.getByTestId('question-bar'));

    // 第 1 题改写 SQLite
    fireEvent.click(bar.getByRole('button', { name: '编辑选项「SQLite」' }));
    fireEvent.change(bar.getByRole('textbox', { name: '修改选项 SQLite' }), { target: { value: 'SQLite v1' } });
    fireEvent.keyDown(bar.getByRole('textbox', { name: '修改选项 SQLite' }), { key: 'Enter' });

    // 第 2 题选认证
    fireEvent.click(screen.getByTestId('question-next'));
    fireEvent.click(bar.getByRole('checkbox', { name: '认证' }));

    // 第 3 题输入数字中间态 '-' -> '-3.5'
    fireEvent.click(screen.getByTestId('question-next'));
    const numInput = bar.getByRole('textbox', { name: '3. 阈值系数' }) as HTMLInputElement;
    fireEvent.change(numInput, { target: { value: '-' } });
    expect(numInput.value).toBe('-');
    fireEvent.change(numInput, { target: { value: '-3.5' } });
    expect(numInput.value).toBe('-3.5');

    // 进入预览态：隐藏步进器，ArrowLeft / ArrowRight 均被忽略
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(screen.getByTestId('question-followup-preview')).toBeTruthy();
    expect(screen.queryByTestId('question-stepper')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('question-bar'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByTestId('question-bar'), { key: 'ArrowRight' });
    expect(screen.getByTestId('question-followup-preview')).toBeTruthy();

    // 首次确认触发失败 -> 记下 submissionId
    await act(async () => fireEvent.click(screen.getByTestId('question-followup-confirm')));
    expect(submit).toHaveBeenCalledTimes(1);
    const firstSubId = submit.mock.calls[0][0].submissionId;
    expect(bar.getByRole('alert').textContent).toContain('临时断连');

    // 返回修改回答（第 3 题改为 2.5）-> 重新生成新 submissionId
    fireEvent.click(screen.getByTestId('question-followup-back'));
    expect(screen.getByTestId('question-stepper')).toBeTruthy();
    fireEvent.click(screen.getByTestId('question-pill-3'));
    fireEvent.change(bar.getByRole('textbox', { name: '3. 阈值系数' }), { target: { value: '2.5' } });
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    await act(async () => fireEvent.click(screen.getByTestId('question-followup-confirm')));
    expect(submit).toHaveBeenCalledTimes(2);
    const secondSubId = submit.mock.calls[1][0].submissionId;
    expect(secondSubId).not.toBe(firstSubId);
    expect(submit.mock.calls[1][0].values.threshold).toBe(2.5);
    expect(sessionStorage.getItem('gravity.question.qa-qt4b')).toBeNull();

    cleanup();

    // 直发 form 提交成功后 sessionStorage 严格清空且无二次回写
    const submitDirect = vi.fn().mockResolvedValue({ mode: 'form', submissionId: 'direct' });
    const directQ: UserQuestion = { ...FOUR_Q, fields: [FOUR_Q.fields[0]] };
    render(wrap(<QuestionBar question={directQ} draftKey="qa-qt4b-direct" native={true} submit={submitDirect} />));
    fireEvent.click(screen.getByRole('radio', { name: 'PostgreSQL' }));
    expect(sessionStorage.getItem('gravity.question.qa-qt4b-direct')).not.toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(submitDirect).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('gravity.question.qa-qt4b-direct')).toBeNull();

    cleanup();

    // QuestionFollowupStatus 5 态全覆盖
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    window.gravityDesktop = { ...getFallbackDesktopBridge(), answerQuestion } as GravityDesktopBridge;
    const states: Array<QuestionFollowupMetadata['state']> = ['queued', 'sending', 'sent', 'failed-unsent', 'unknown'];
    for (const st of states) {
      const { unmount } = render(
        wrap(
          <QuestionFollowupStatus
            sessionId="s-5state"
            followup={{ questionMessageId: `m-${st}`, submissionId: `sub-${st}`, state: st, detail: `detail-${st}` }}
          />
        )
      );
      const node = screen.getByTestId(`question-followup-m-${st}`);
      expect(node.dataset.state).toBe(st);
      expect(node.textContent).toContain(`detail-${st}`);
      if (st === 'failed-unsent') {
        expect(screen.getAllByRole('button')).toHaveLength(1);
        await act(async () => fireEvent.click(screen.getByTestId(`question-followup-retry-m-${st}`)));
        expect(answerQuestion).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 's-5state',
            messageId: 'm-failed-unsent',
            submissionId: 'sub-failed-unsent',
            delivery: 'followup',
            retryUnsentFollowup: true,
          })
        );
      } else {
        expect(screen.queryByRole('button')).toBeNull();
      }
      unmount();
    }
    expect(answerQuestion).toHaveBeenCalledTimes(1);
  });
});

/* =========================================================================
 * P-T2b & D-01：PlanArtifactPanel 缓存复用、unchanged 收口、跨账号/会话隔离、锚点与 owner 边界
 * ======================================================================= */
describe('P-T2b & D-01：PlanArtifactPanel 增量读取、异常收口、切换清理与安全链接边界', () => {
  it('真命中 unchanged 复用缓存；snapshot=null 收 unchanged 重拉仍无则收口空态；切换会话丢弃在途旧响应；truncated 横幅与 #anchor 滚动；D-01 planArtifactOwner 严格隔离', async () => {
    let listener: ((e: PlanArtifactChangedEvent) => void) | undefined;
    const unsubSpy = vi.fn();
    const openLinkOrFileTarget = vi.fn().mockResolvedValue({ opened: true, modeUsed: 'browser', resolvedTarget: '' });
    const restoreMatchMedia = mockMatchMedia(true);

    const planPath = 'D:\\sandbox-home\\.gemini\\brain\\sess-a\\implementation_plan.md';
    let resolveSlowA!: (v: PlanArtifactSnapshot) => void;

    const getSessionPlanArtifact = vi
      .fn<(input: { profileId: string; sessionId: string; knownRevision?: number }) => Promise<PlanArtifactSnapshot>>()
      // 1) 首次正常 ready（含 truncated: true + 锚点 + 外链 + 工作区文件 + 本体链接）
      .mockResolvedValueOnce({
        status: 'ready',
        owner: { profileId: 'p1', sessionId: 'sess-a' },
        revision: 3,
        filePath: planPath,
        truncated: true,
        updatedAt: '2026-11-27T01:00:00Z',
        content: [
          '# 计划总览',
          '',
          '## 目标清单',
          '',
          '- [跳转目标](#目标清单)',
          '- [官网文档](https://example.com/spec)',
          '- [工作区设计](./docs/design.md)',
          '- [打开本体](file:///D:/sandbox-home/.gemini/brain/sess-a/implementation_plan.md)',
        ].join('\n'),
      })
      // 2) 事件通知 rev=3 时后端返回 unchanged -> 复用现有缓存并结束 loading
      .mockResolvedValueOnce({
        status: 'unchanged',
        owner: { profileId: 'p1', sessionId: 'sess-a' },
        revision: 3,
      })
      // 3) 触发一个在途的慢响应（用于随后切换会话丢弃验证）
      .mockImplementationOnce(
        () =>
          new Promise<PlanArtifactSnapshot>((resolve) => {
            resolveSlowA = resolve;
          })
      )
      // 4) 切换到 p2/sess-b 后，首次异常收到 unchanged -> 自动去掉 knownRevision 重拉一次
      .mockResolvedValueOnce({
        status: 'unchanged',
        owner: { profileId: 'p2', sessionId: 'sess-b' },
        revision: 0,
      })
      // 5) 重拉仍为 unchanged -> 按空态 missing 收口，不卡 Loading
      .mockResolvedValueOnce({
        status: 'unchanged',
        owner: { profileId: 'p2', sessionId: 'sess-b' },
        revision: 0,
      });

    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact,
      openLinkOrFileTarget,
      onPlanArtifactChanged: (fn) => {
        listener = fn;
        return () => {
          unsubSpy();
          listener = undefined;
        };
      },
    };

    const { rerender } = render(wrap(<PlanArtifactPanel profileId="p1" sessionId="sess-a" cwd={'F:\\repo'} />));
    const doc = await screen.findByTestId('plan-artifact-document');
    expect(doc.textContent).toContain('目标清单');
    // truncated 横幅
    expect(screen.getByTestId('plan-artifact-panel').textContent).toContain('文档较长，仅显示前一部分');

    // 同 revision 事件客户端去重（0 冗余 IPC）；新 revision 后端返回 unchanged 时携带 knownRevision: 3，复用缓存并退出 loading
    await act(async () => listener?.({ profileId: 'p1', sessionId: 'sess-a', revision: 3 }));
    expect(getSessionPlanArtifact).toHaveBeenCalledTimes(1);

    await act(async () => listener?.({ profileId: 'p1', sessionId: 'sess-a', revision: 4 }));
    expect(getSessionPlanArtifact).toHaveBeenNthCalledWith(2, { profileId: 'p1', sessionId: 'sess-a', knownRevision: 3 });
    expect(screen.getByTestId('plan-artifact-document').textContent).toContain('目标清单');

    // #anchor 页内滚动（遵循 reduced-motion -> behavior: 'auto'），0 次 IPC
    const heading = doc.querySelector<HTMLElement>('[data-anchor="目标清单"]')!;
    const scrollSpy = vi.fn();
    heading.scrollIntoView = scrollSpy;
    fireEvent.click(screen.getByRole('button', { name: '跳转目标' }));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    expect(openLinkOrFileTarget).not.toHaveBeenCalled();

    // D-01：外链与工作区文件不传 planArtifactOwner，但传 cwd & sessionId
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '官网文档' })));
    expect(openLinkOrFileTarget).toHaveBeenLastCalledWith({
      target: 'https://example.com/spec',
      action: 'browser',
      cwd: 'F:\\repo',
      sessionId: 'sess-a',
    });
    expect(openLinkOrFileTarget.mock.calls.at(-1)?.[0]).not.toHaveProperty('planArtifactOwner');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '工作区设计' })));
    expect(openLinkOrFileTarget).toHaveBeenLastCalledWith({
      target: './docs/design.md',
      action: 'default-app',
      cwd: 'F:\\repo',
      sessionId: 'sess-a',
    });
    expect(openLinkOrFileTarget.mock.calls.at(-1)?.[0]).not.toHaveProperty('planArtifactOwner');

    // D-01：头部打开按钮与本体 file:// 链接精确携带 planArtifactOwner
    await act(async () => fireEvent.click(screen.getByTestId('plan-artifact-open-file')));
    expect(openLinkOrFileTarget).toHaveBeenLastCalledWith({
      target: planPath,
      action: 'default-app',
      cwd: 'F:\\repo',
      sessionId: 'sess-a',
      planArtifactOwner: { profileId: 'p1', sessionId: 'sess-a', revision: 3 },
    });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '打开本体' })));
    expect(openLinkOrFileTarget).toHaveBeenLastCalledWith({
      target: 'file:///D:/sandbox-home/.gemini/brain/sess-a/implementation_plan.md',
      action: 'default-app',
      cwd: 'F:\\repo',
      sessionId: 'sess-a',
      planArtifactOwner: { profileId: 'p1', sessionId: 'sess-a', revision: 3 },
    });

    // 发起第 3 次（慢请求）后立即切换 profileId/sessionId
    fireEvent.click(screen.getByTestId('plan-artifact-refresh'));
    rerender(wrap(<PlanArtifactPanel profileId="p2" sessionId="sess-b" cwd={'F:\\repo2'} />));
    expect(unsubSpy).toHaveBeenCalledTimes(1);

    // 旧会话迟到结果返回 -> 必须被 ownerRef 丢弃，绝不污染 p2/sess-b
    await act(async () => {
      resolveSlowA({
        status: 'ready',
        owner: { profileId: 'p1', sessionId: 'sess-a' },
        revision: 99,
        content: '# LEAKED OLD SESSION',
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      const panelText = screen.getByTestId('plan-artifact-panel').textContent || '';
      expect(panelText).toContain('暂无 implementation_plan.md');
      expect(panelText).not.toContain('LEAKED OLD SESSION');
      expect(panelText).not.toContain('正在读取');
    });

    restoreMatchMedia();
  });
});

/* =========================================================================
 * MO-T1b：reduced-motion 尊重 scrollBehavior('auto') 与 Cost 卡片折叠按钮位置
 * ======================================================================= */
describe('MO-T1b：动效减敏下 ContextCostInspectorView jumpTo 使用 auto 滚动并持久化展开态', () => {
  it('prefers-reduced-motion: reduce 下 jumpTo 调用 behavior: auto，非减敏调用 smooth，且 Cost Toggle 位于分段按钮右侧', () => {
    const dashboard = makeDashboardWithSharedHeatmap();
    localStorage.setItem('gravity.context.collapsed', JSON.stringify({ usage: false, heatmap: false, cost: true }));

    const rafCbs: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });

    // 1) reduced-motion: reduce -> behavior: 'auto'
    let restoreMedia = mockMatchMedia(true);
    const { unmount } = render(
      wrap(<ContextCostInspectorView sessionId={null} dashboard={dashboard} onOpenRateCardsSettings={vi.fn()} />)
    );

    const costHead = screen.getByTestId('cost-breakdown-section').querySelector('.card-head')!;
    expect(costHead.lastElementChild).toBe(screen.getByTestId('context-section-toggle-cost'));

    const costSection = document.getElementById('ctx-section-cost')!;
    const scrollSpyReduced = vi.fn();
    costSection.scrollIntoView = scrollSpyReduced;
    fireEvent.click(screen.getByTestId('context-anchor-cost'));
    expect(JSON.parse(localStorage.getItem('gravity.context.collapsed') || '{}').cost).toBe(false);
    act(() => {
      while (rafCbs.length) rafCbs.shift()!(0);
    });
    expect(scrollSpyReduced).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
    restoreMedia();
    unmount();

    // 2) no-preference -> behavior: 'smooth'
    restoreMedia = mockMatchMedia(false);
    render(wrap(<ContextCostInspectorView sessionId={null} dashboard={dashboard} onOpenRateCardsSettings={vi.fn()} />));
    const costSection2 = document.getElementById('ctx-section-cost')!;
    const scrollSpySmooth = vi.fn();
    costSection2.scrollIntoView = scrollSpySmooth;
    fireEvent.click(screen.getByTestId('context-anchor-cost'));
    act(() => {
      while (rafCbs.length) rafCbs.shift()!(0);
    });
    expect(scrollSpySmooth).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    restoreMedia();
  });
});

/* =========================================================================
 * FE-P1b：ApprovalsPanel 精确区分 '' 与 '   ' 旧空白规则并分别安全删除
 * ======================================================================= */
describe('FE-P1b：ApprovalsPanel 区分旧空串与旧纯空白规则语义并支持按索引安全删除', () => {
  it('空串标停用警告徽章、非空纯空白标危险徽章（按字面空白匹配），均可按索引逐条删除', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const config: ApproveForMeConfig = {
      ...DEFAULT_APPROVAL_CONFIG,
      allowPatterns: ['', '   ', '^git status$'],
    };

    const { rerender } = render(
      wrap(<ApprovalsPanel config={config} auditEntries={[]} initialTab="rules" onUpdateConfig={onUpdate} />)
    );

    const emptyBadge = screen.getByTestId('pattern-legacy-blank-allowPatterns-0');
    const wsBadge = screen.getByTestId('pattern-legacy-whitespace-allowPatterns-1');
    expect(emptyBadge.className).toContain('badge-warning');
    expect(emptyBadge.textContent).toContain('已停用不会生效');
    expect(wsBadge.className).toContain('badge-danger');
    expect(wsBadge.textContent).toContain('仍按字面空白匹配');

    // 先删非空纯空白（索引 1）
    fireEvent.click(screen.getByTestId('delete-pattern-allowPatterns-1'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ allowPatterns: ['', '^git status$'] }));

    // 模拟更新后状态再删空串（索引 0）
    onUpdate.mockClear();
    rerender(
      wrap(
        <ApprovalsPanel
          config={{ ...config, allowPatterns: ['', '^git status$'] }}
          auditEntries={[]}
          initialTab="rules"
          onUpdateConfig={onUpdate}
        />
      )
    );
    fireEvent.click(screen.getByTestId('delete-pattern-allowPatterns-0'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ allowPatterns: ['^git status$'] }));
  });
});

/* =========================================================================
 * FE-P2b：AQ-1 429(60s) 与 403(300s) 冷却期 0 探测、每秒倒计时递减、到期解锁恢复
 * ======================================================================= */
describe('FE-P2b：429(60s) 与 403(300s) 冷却期禁用刷新、动态倒计时与到期恢复', () => {
  it.each([
    { kind: 'rate_limit_429' as const, code: '429', seconds: 60 },
    { kind: 'permission_403' as const, code: '403', seconds: 300 },
  ])('$code ($seconds s) 冷却期内禁止点击刷新并逐秒倒计时，归零后解锁手动恢复', async ({ kind, code, seconds }) => {
    vi.useFakeTimers();
    const t0 = new Date('2026-11-27T03:00:00.000Z');
    vi.setSystemTime(t0);

    const quotaOk: AccountQuota = {
      profileId: 'default',
      checkedAt: t0.toISOString(),
      buckets: [{ id: 'gemini-weekly', remainingFraction: 0.77 }],
    };
    const getAccountQuota = vi.fn(async () => quotaOk);
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getAccountQuota,
    };

    const conn = makeConnection({
      cooldownKind: kind,
      cooldownUntil: new Date(t0.getTime() + seconds * 1000).toISOString(),
    });

    render(wrap(<AccountQuotaFooter profileId="default" connection={conn} />));

    // 挂载即处于活跃冷却期：0 次自动探测
    await act(async () => {
      await Promise.resolve();
    });
    expect(getAccountQuota).not.toHaveBeenCalled();

    // 打开弹层：按钮 aria-disabled="true"，倒计时展示完整秒数与状态码
    fireEvent.click(screen.getByTestId('quota-weekly'));
    const btn = screen.getByTestId('quota-refresh-btn');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('quota-cooldown-note').textContent).toContain(code);
    expect(screen.getByTestId('quota-cooldown-note').textContent).toContain(`${seconds} 秒`);

    // 活跃冷却期点击刷新 -> 0 次 IPC
    fireEvent.click(btn);
    expect(getAccountQuota).not.toHaveBeenCalled();

    // 推进 1 秒 -> 倒计时递减 1 秒仍保持禁用
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('quota-cooldown-note').textContent).toContain(`${seconds - 1} 秒`);
    expect(screen.getByTestId('quota-refresh-btn').getAttribute('aria-disabled')).toBe('true');

    // 推进剩余秒数归零 -> 仍不自动探测，但按钮解锁，手动点击调用 getAccountQuota(true)
    act(() => {
      vi.advanceTimersByTime((seconds - 1) * 1000);
    });
    window.dispatchEvent(new Event('focus'));
    expect(getAccountQuota).not.toHaveBeenCalled();
    expect(screen.getByTestId('quota-refresh-btn').getAttribute('aria-disabled')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('quota-refresh-btn'));
      await Promise.resolve();
    });
    expect(getAccountQuota).toHaveBeenCalledTimes(1);
    expect(getAccountQuota).toHaveBeenCalledWith(true);
  });

  it('AccountQuotaFeed 在 403 300s 活跃冷却期阻断 manual()，到期后 manual() 才恢复', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-11-27T04:00:00.000Z');
    vi.setSystemTime(t0);
    let connCb: ((s: AcpConnectionStatus) => void) | undefined;
    const read = vi.fn(async () => ({
      profileId: 'default',
      checkedAt: t0.toISOString(),
      buckets: [{ id: 'gemini-weekly', remainingFraction: 0.6 }],
    }));
    const feed = new AccountQuotaFeed('default', read, (cb) => {
      connCb = cb;
      return () => {
        connCb = undefined;
      };
    });
    const unsub = feed.subscribe(vi.fn());
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);

    connCb?.(makeConnection({ cooldownKind: 'permission_403', cooldownUntil: new Date(t0.getTime() + 300_000).toISOString() }));
    await vi.advanceTimersByTimeAsync(150_000);
    await feed.manual();
    expect(read).toHaveBeenCalledTimes(1);
    expect(feed.snapshot().pausedByCooldown).toBe(true);

    await vi.advanceTimersByTimeAsync(151_000);
    await feed.manual();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(true);
    expect(feed.snapshot().pausedByCooldown).toBeUndefined();
    unsub();
  });
});

/* =========================================================================
 * FE-P3b：设置 8 项导航 + 外观 3 二级页签深链 + 无 Orchestrator + 错误捕获 + 全 tablist 键盘漫游
 * ======================================================================= */
describe('FE-P3b：设置中心 8 项导航、外观深链、保存失败提示与全站 tablist 键盘漫游', () => {
  function makeSettingsBaseProps(overrides: Partial<React.ComponentProps<typeof SettingsView>> = {}) {
    return {
      section: 'themes' as SettingsSection,
      preferences: makePreferences(),
      connection: makeConnection(),
      accounts: {
        activeProfileId: 'default',
        profiles: [
          {
            profileId: 'default',
            name: 'Default',
            isDefault: true,
            createdAt: '2026-01-01T00:00:00Z',
            lastActivatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        acpIdentity: { connected: true, authMethods: [], supportsLogout: false },
      },
      approvalConfig: DEFAULT_APPROVAL_CONFIG,
      translationConfig: DEFAULT_TRANSLATION_CONFIG,
      auditEntries: [],
      plugins: makePluginsSnapshot(),
      rateCards: [],
      updateState: { status: 'idle' as const, currentVersion: '0.3.5', repoUrl: 'https://github.com/Mikotou/G-Gravity' },
      onSectionChange: vi.fn(),
      onClose: vi.fn(),
      onUpdatePreferences: vi.fn().mockResolvedValue(undefined),
      onCheckUpdates: vi.fn().mockResolvedValue(undefined),
      onDownloadUpdate: vi.fn().mockResolvedValue(undefined),
      onInstallUpdate: vi.fn().mockResolvedValue(undefined),
      onSetAppIcon: vi.fn().mockResolvedValue(undefined),
      onImportCustomTheme: vi.fn().mockResolvedValue(undefined),
      onExportCustomTheme: vi.fn().mockResolvedValue('{}'),
      onUpdateRateCards: vi.fn().mockResolvedValue(undefined),
      onCreateProfile: vi.fn().mockResolvedValue(undefined),
      onSwitchProfile: vi.fn().mockResolvedValue(undefined),
      onDeleteProfile: vi.fn().mockResolvedValue(undefined),
      onLaunchLogin: vi.fn().mockResolvedValue(undefined),
      onLogout: vi.fn().mockResolvedValue(undefined),
      onUpdateApprovalConfig: vi.fn().mockResolvedValue(undefined),
      onRefreshPlugins: vi.fn().mockResolvedValue(undefined),
      onRunPluginAction: vi.fn().mockResolvedValue(undefined),
      onRunMcpAction: vi.fn().mockResolvedValue(undefined),
      onToggleSkill: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('严格 8 项一级导航、外观 3 二级页签深链（themes/tokens/icons）、无 Orchestrator 项、reject 展示 role=alert 且 0 Unhandled Rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const onUpdatePreferences = vi.fn().mockRejectedValue(new Error('偏好写入失败'));
      const onSetAppIcon = vi.fn().mockRejectedValue(new Error('图标切换失败'));

      function SettingsHost({ initial }: { initial: SettingsSection }) {
        const [sec, setSec] = useState<SettingsSection>(initial);
        return (
          <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
            <SettingsView
              {...makeSettingsBaseProps({
                section: sec,
                onSectionChange: setSec,
                onUpdatePreferences,
                onSetAppIcon,
              })}
            />
          </I18nProvider>
        );
      }

      const { unmount } = render(<SettingsHost initial="tokens" />);

      // 左侧一级导航恰好 8 项
      const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-nav .settings-nav-item'));
      expect(navButtons.map((b) => b.dataset.testid)).toEqual([
        'settings-tab-general',
        'settings-tab-themes',
        'settings-tab-projects',
        'settings-tab-accounts',
        'settings-tab-approvals',
        'settings-tab-plugins',
        'settings-tab-rates',
        'settings-tab-about',
      ]);

      // 深链 section='tokens' 时「外观」高亮，且二级页签选中 tokens
      expect(screen.getByTestId('settings-tab-themes').getAttribute('aria-current')).toBe('page');
      const subnav = screen.getByTestId('settings-appearance-subnav');
      expect(subnav.getAttribute('role')).toBe('tablist');
      expect(screen.getByTestId('settings-tab-tokens').getAttribute('aria-selected')).toBe('true');

      // 深链切至 icons：IconsPanel onSetAppIcon reject 展示 role=alert 且 0 Unhandled Rejection
      fireEvent.click(screen.getByTestId('settings-tab-icons'));
      expect(screen.getByTestId('settings-tab-icons').getAttribute('aria-selected')).toBe('true');
      await act(async () => {
        fireEvent.click(screen.getByTestId('icon-variant-auto'));
      });
      expect(screen.getByTestId('settings-prefs-error').getAttribute('role')).toBe('alert');
      expect(screen.getByTestId('settings-prefs-error').textContent).toContain('图标切换失败');

      // 切至 themes：ThemesPanel onUpdatePreferences reject 展示 role=alert
      fireEvent.click(screen.getByTestId('settings-subtab-themes'));
      expect(screen.getByTestId('settings-subtab-themes').getAttribute('aria-selected')).toBe('true');
      await act(async () => {
        fireEvent.click(screen.getByTestId('theme-card-macos-dark'));
      });
      expect(screen.getByTestId('settings-prefs-error').getAttribute('role')).toBe('alert');
      expect(screen.getByTestId('settings-prefs-error').textContent).toContain('偏好写入失败');

      // 全 8 个分区遍历检查：零 Orchestrator（Planner/Executor）残留
      for (const navId of ['general', 'themes', 'projects', 'accounts', 'approvals', 'plugins', 'rates', 'about']) {
        fireEvent.click(screen.getByTestId(`settings-tab-${navId}`));
        const modalText = screen.getByTestId('theme-settings-modal').textContent || '';
        expect(modalText).not.toMatch(/orchestrator|规划执行双模型|Planner\s*\/\s*Executor/i);
      }

      unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('FE-P3b (FE-BUG-10 探测)：SettingsView 外观二级页签按方向键切换后焦点须留在目标 tab 上以支持连续漫游', () => {
    function SettingsHost() {
      const [sec, setSec] = useState<SettingsSection>('tokens');
      return (
        <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
          <SettingsView {...makeSettingsBaseProps({ section: sec, onSectionChange: setSec })} />
        </I18nProvider>
      );
    }

    render(<SettingsHost />);
    const subnav = screen.getByTestId('settings-appearance-subnav');
    screen.getByTestId('settings-tab-tokens').focus();
    fireEvent.keyDown(subnav, { key: 'ArrowRight' });
    expect(screen.getByTestId('settings-tab-icons').getAttribute('aria-selected')).toBe('true');
    // 连续键盘漫游前提：焦点不得因父节点 key={section} 重挂而跌落至 document.body
    expect(document.activeElement).toBe(screen.getByTestId('settings-tab-icons'));
    fireEvent.keyDown(screen.getByTestId('settings-appearance-subnav'), { key: 'Home' });
    expect(screen.getByTestId('settings-subtab-themes').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('settings-subtab-themes'));
  });

  it('RightInspector 一级 5 页签、ApprovalsPanel 与 PluginsPanel tablist 方向键/Home/End 连续漫游完整', async () => {
    const dashboard = makeDashboardWithSharedHeatmap();
    const inspectorData: SessionInspectorData = { sessionId: 's-tab', diffs: [], todos: [], terminals: [] };

    function InspectorHost() {
      const [tab, setTab] = useState<RightInspectorTab>('diff');
      return (
        <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
          <RightInspector
            collapsed={false}
            width={400}
            activeTab={tab}
            focusedDiffFile={null}
            sessionId="s-tab"
            inspectorData={inspectorData}
            sessionMessages={[]}
            telemetry={dashboard}
            onSelectTab={setTab}
            onFocusDiffFile={vi.fn()}
            onCommitWidth={vi.fn()}
            onOpenRateCardsSettings={vi.fn()}
          />
        </I18nProvider>
      );
    }

    render(<InspectorHost />);

    // 1) 一级 5 页签 tablist 连续漫游且焦点不丢
    const head = screen.getByTestId('right-inspector').querySelector<HTMLElement>('.inspector-head')!;
    expect(head.getAttribute('role')).toBe('tablist');
    const diffTab = screen.getByTestId('inspector-tab-diff');
    diffTab.focus();
    fireEvent.keyDown(head, { key: 'ArrowRight' });
    expect(screen.getByTestId('inspector-tab-plan').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('inspector-tab-plan'));
    fireEvent.keyDown(head, { key: 'End' });
    expect(screen.getByTestId('inspector-tab-swarm').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('inspector-tab-swarm'));
    fireEvent.keyDown(head, { key: 'Home' });
    expect(screen.getByTestId('inspector-tab-diff').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('inspector-tab-diff'));

    // 2) ApprovalsPanel & PluginsPanel .sub-tabs 方向键 + Home/End 连续漫游
    cleanup();
    render(wrap(<ApprovalsPanel config={DEFAULT_APPROVAL_CONFIG} auditEntries={[]} onUpdateConfig={vi.fn().mockResolvedValue(undefined)} />));
    const appSub = screen.getByTestId('approval-drawer').querySelector<HTMLElement>('.sub-tabs')!;
    screen.getByTestId('drawer-tab-rules').focus();
    fireEvent.keyDown(appSub, { key: 'End' });
    expect(screen.getByTestId('drawer-tab-reviewer').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('drawer-tab-reviewer'));
    fireEvent.keyDown(appSub, { key: 'Home' });
    expect(screen.getByTestId('drawer-tab-rules').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('drawer-tab-rules'));

    cleanup();
    const refreshPlugins = vi.fn().mockResolvedValue(undefined);
    render(
      wrap(
        <PluginsPanel
          snapshot={makePluginsSnapshot()}
          onRefresh={refreshPlugins}
          onRunPluginAction={vi.fn().mockResolvedValue(undefined)}
          onRunMcpAction={vi.fn().mockResolvedValue(undefined)}
          onToggleSkill={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );
    await waitFor(() => expect(refreshPlugins).toHaveBeenCalledTimes(1));
    const plugSub = screen.getByTestId('plugins-manager-modal').querySelector<HTMLElement>('.sub-tabs')!;
    screen.getByTestId('plugins-tab-builtins').focus();
    fireEvent.keyDown(plugSub, { key: 'End' });
    expect(screen.getByTestId('plugins-tab-skills').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('plugins-tab-skills'));
    fireEvent.keyDown(plugSub, { key: 'Home' });
    expect(screen.getByTestId('plugins-tab-builtins').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('plugins-tab-builtins'));
  });

  it('FE-P3b (FE-BUG-11 探测)：RightInspector Changes 与 Context 二级 tablist 按方向键切换后焦点须留在目标 tab 上', () => {
    const dashboard = makeDashboardWithSharedHeatmap();
    const inspectorData: SessionInspectorData = { sessionId: 's-tab', diffs: [], todos: [], terminals: [] };

    function InspectorHost() {
      const [tab, setTab] = useState<RightInspectorTab>('diff');
      return (
        <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
          <RightInspector
            collapsed={false}
            width={400}
            activeTab={tab}
            focusedDiffFile={null}
            sessionId="s-tab"
            inspectorData={inspectorData}
            sessionMessages={[]}
            telemetry={dashboard}
            onSelectTab={setTab}
            onFocusDiffFile={vi.fn()}
            onCommitWidth={vi.fn()}
            onOpenRateCardsSettings={vi.fn()}
          />
        </I18nProvider>
      );
    }

    render(<InspectorHost />);

    // Changes 二级 tablist（diff -> ArrowRight -> files -> ArrowLeft -> diff）
    const changesSubnav = screen.getByTestId('inspector-subtab-diff').closest<HTMLElement>('.inspector-subnav')!;
    screen.getByTestId('inspector-subtab-diff').focus();
    fireEvent.keyDown(changesSubnav, { key: 'ArrowRight' });
    expect(screen.getByTestId('inspector-tab-files').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('inspector-tab-files'));
    fireEvent.keyDown(changesSubnav, { key: 'ArrowLeft' });
    expect(screen.getByTestId('inspector-subtab-diff').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('inspector-subtab-diff'));

    // Context 二级 tablist（context -> ArrowRight -> tree -> ArrowLeft -> context）
    fireEvent.click(screen.getByTestId('inspector-tab-context'));
    const ctxSubnav = screen.getByTestId('right-inspector').querySelector<HTMLElement>('.inspector-subnav')!;
    screen.getByTestId('inspector-subtab-context').focus();
    fireEvent.keyDown(ctxSubnav, { key: 'ArrowRight' });
    expect(screen.getByTestId('inspector-tab-tree').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('inspector-tab-tree'));
    fireEvent.keyDown(screen.getByTestId('right-inspector').querySelector<HTMLElement>('.inspector-subnav')!, { key: 'ArrowLeft' });
    expect(screen.getByTestId('inspector-subtab-context').getAttribute('aria-selected')).toBe('true');
  });
});
