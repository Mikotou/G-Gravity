import React, { Profiler } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COST_DISCLAIMER,
  DEFAULT_MODEL_RATE_CARDS,
  DEFAULT_TRANSLATION_CONFIG,
  GRAVITY_ICON_VARIANTS,
  THEME_PRESETS,
  resolveEffectiveGravityIconId,
  type ApprovalAuditEntry,
  type ApprovalReviewingEvent,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientLocale,
  type ClientPreferences,
  type ConversationTreeState,
  type DailyCalendarHeatmapCell,
  type DayHourHeatmapCell,
  type HourlyTokenBarBucket,
  type ManagedSessionSummary,
  type SessionInspectorData,
  type TelemetryDashboardSnapshot,
  type TranslationConfig,
  type WorkspaceProjectConfig,
} from '@shared';
import { App } from '../src/renderer/App';
import { ActivityRail } from '../src/renderer/components/ActivityRail';
import { Composer } from '../src/renderer/components/Composer';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { ContextStatusBar } from '../src/renderer/components/ContextStatusBar';
import { EditUserMessage } from '../src/renderer/components/EditUserMessage';
import { Markdown } from '../src/renderer/components/Markdown';
import { NewSessionModal } from '../src/renderer/components/NewSessionModal';
import { ProjectSidebar } from '../src/renderer/components/ProjectSidebar';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { SessionPane, type SessionPaneProps } from '../src/renderer/components/SessionPane';
import { SettingsView } from '../src/renderer/components/SettingsView';
import { TitleOrganizerModal } from '../src/renderer/components/TitleOrganizerModal';
import { TopBar } from '../src/renderer/components/TopBar';
import { IconsPanel } from '../src/renderer/components/settings/AppearancePanels';
import { ApprovalsPanel, RatesPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { useFluidStreamText } from '../src/renderer/hooks/useFluidStreamText';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

const REPO_ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(REPO_ROOT, 'src', 'renderer');
const ALLOWED_ICON_SIZES = new Set(['12', '14', '16', '18']);

function walkTsxFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsxFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function wrap(child: React.ReactNode, locale: ClientLocale = 'zh-CN') {
  return (
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      {child}
    </I18nProvider>
  );
}

function makeSession(overrides: Partial<ManagedSessionSummary> = {}): ManagedSessionSummary {
  return {
    sessionId: 'sess-v034-1',
    cwd: 'C:\\Workspace\\GravityV034',
    rawCwd: 'C:\\Workspace\\GravityV034',
    title: 'v0.3.4 前端验证会话',
    pinned: false,
    isLegacyApprovalPollution: false,
    status: 'idle',
    modelId: 'gemini-4-neon',
    executionMode: 'default',
    reasoningEffort: 'medium',
    originKind: 'acp-live',
    readOnly: false,
    profileId: 'default',
    updatedAt: '2026-11-26T12:00:00.000Z',
    ...overrides,
  };
}

function makeApprovalConfig(overrides: Partial<ApproveForMeConfig> = {}): ApproveForMeConfig {
  return {
    mode: 'rules-only',
    enableSafeDownloadAutoApprove: false,
    maxDownloadSizeMB: 50,
    cacheTtlHours: 24,
    allowPatterns: [],
    askPatterns: [],
    denyPatterns: [],
    allowAlignedHighRiskPass: true,
    alignedHighRiskMaxScore: 90,
    fastPassLowRiskDev: true,
    externalReviewer: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
      timeoutMs: 8000,
      maxOutputTokens: 4096,
      thinkingLevel: 'auto',
    },
    ...overrides,
  };
}

function buildHeatmapFixtures(): {
  hourly24h: HourlyTokenBarBucket[];
  matrix7d: DayHourHeatmapCell[];
  calendar30d: DailyCalendarHeatmapCell[];
} {
  const hourly24h: HourlyTokenBarBucket[] = Array.from({ length: 24 }, (_, h) => ({
    hourKey: `2026-11-26T${String(h).padStart(2, '0')}`,
    hourLabel: `${String(h).padStart(2, '0')}:00`,
    inputTokens: h === 14 ? 4000 : 200,
    cachedInputTokens: 100,
    outputTokens: h === 14 ? 1200 : 80,
    thinkingTokens: 50,
    totalTokens: h === 14 ? 5350 : 430,
    costUsd: h === 14 ? 0.042 : 0.002,
  }));

  const matrix7d: DayHourHeatmapCell[] = [];
  const start7d = new Date(2026, 10, 20); // 2026-11-20 .. 2026-11-26
  for (let d = 0; d < 7; d += 1) {
    const dt = new Date(start7d.getTime() + d * 86400_000);
    const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    for (let h = 0; h < 24; h += 1) {
      const peak = d === 5 && h === 14;
      const active = (d + h) % 5 === 0;
      const totalTokens = peak ? 64000 : active ? 4200 : 0;
      const costUsd = peak ? 0.32 : active ? 0.018 : 0;
      const intensity: 0 | 1 | 2 | 3 | 4 = peak ? 4 : active ? (((d + h) % 3) + 1 as 1 | 2 | 3) : 0;
      matrix7d.push({ date: dateStr, hour: h, totalTokens, costUsd, intensity });
    }
  }

  const calendar30d: DailyCalendarHeatmapCell[] = [];
  const start30d = new Date(2026, 9, 28); // 2026-10-28 .. 2026-11-26 (spans Oct -> Nov boundary!)
  for (let d = 0; d < 30; d += 1) {
    const dt = new Date(start30d.getTime() + d * 86400_000);
    const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const peak = d === 22;
    const active = d % 2 === 0;
    const totalTokens = peak ? 180000 : active ? 18500 : 0;
    const costUsd = peak ? 1.24 : active ? 0.085 : 0;
    const intensity: 0 | 1 | 2 | 3 | 4 = peak ? 4 : active ? (((d % 3) + 1) as 1 | 2 | 3) : 0;
    calendar30d.push({
      date: dateStr,
      inputTokens: Math.round(totalTokens * 0.6),
      cachedInputTokens: Math.round(totalTokens * 0.2),
      outputTokens: Math.round(totalTokens * 0.15),
      thinkingTokens: Math.round(totalTokens * 0.05),
      totalTokens,
      costUsd,
      sessionCount: active || peak ? (peak ? 4 : 2) : 0,
      intensity,
    });
  }

  return { hourly24h, matrix7d, calendar30d };
}

function makeRichTelemetry(sessionId = 'sess-v034-1'): TelemetryDashboardSnapshot {
  const { hourly24h, matrix7d, calendar30d } = buildHeatmapFixtures();
  const sampleCost = {
    inputTokens: 12000,
    cachedInputTokens: 4000,
    outputTokens: 3200,
    thinkingTokens: 800,
    totalTokens: 20000,
    inputCostUsd: 0.018,
    cachedInputCostUsd: 0.0015,
    outputCostUsd: 0.032,
    thinkingCostUsd: 0.008,
    totalCostUsd: 0.0595,
  };
  return {
    activeSessions: {
      [sessionId]: {
        sessionId,
        modelId: 'gemini-4-neon',
        maxContextTokens: 512000,
        usedContextTokens: 64000,
        usageRatio: 0.125,
        pressureLevel: 'healthy',
        breakdown: {
          systemAndRulesTokens: 8000,
          userMessagesTokens: 12000,
          agentMessagesTokens: 28000,
          thoughtTokens: 8000,
          toolCallsTokens: 6000,
          attachmentsTokens: 2000,
        },
        attachments: [],
        compactions: [],
        currentTokensPerSecond: 48.2,
        averageTokensPerSecond: 42.5,
        peakTokensPerSecond: 72.0,
        averageCacheHitRate: 0.45,
        costSummary: sampleCost,
        usageSource: 'acp-reported',
        pricingSource: 'reference-api-estimate',
        updatedAt: '2026-11-26T12:00:00.000Z',
      },
    },
    hourly24h,
    matrix7d,
    calendar30d,
    costByRange: { today: sampleCost, '7d': sampleCost, '30d': sampleCost },
    modelBreakdownByRange: { today: [], '7d': [], '30d': [] },
    sessionModelBreakdowns: {},
    externalReviewer: {
      cumulativeAllTime: {
        ...sampleCost,
        callCount: 12,
        approvedCount: 8,
        askCount: 3,
        denyCount: 1,
        errorCount: 0,
        providerCount: 1,
      },
      cumulativeProviders: [
        {
          ...sampleCost,
          key: 'openai-compatible:api.openai.com:gpt-4o-mini',
          provider: 'openai-compatible',
          endpointHost: 'api.openai.com',
          modelId: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          callCount: 12,
          approvedCount: 8,
          askCount: 3,
          denyCount: 1,
          errorCount: 0,
          shareRatio: 1,
        },
      ],
      bySession: {},
      hourly24h,
      matrix7d,
      calendar30d,
      costByRange: {
        today: { ...sampleCost, callCount: 4 },
        '7d': { ...sampleCost, callCount: 8 },
        '30d': { ...sampleCost, callCount: 12 },
      },
      providerBreakdownByRange: { today: [], '7d': [], '30d': [] },
      updatedAt: '2026-11-26T12:00:00.000Z',
    },
    externalTranslator: {
      cumulativeAllTime: {
        ...sampleCost,
        callCount: 10,
        successCount: 9,
        fallbackCount: 1,
        errorCount: 0,
        providerCount: 1,
      },
      cumulativeProviders: [
        {
          ...sampleCost,
          key: 'openai-compatible:api.openai.com:gpt-4o-mini',
          provider: 'openai-compatible',
          endpointHost: 'api.openai.com',
          modelId: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          callCount: 10,
          successCount: 9,
          fallbackCount: 1,
          errorCount: 0,
          shareRatio: 1,
        },
      ],
      bySession: {},
      hourly24h,
      matrix7d,
      calendar30d,
      costByRange: {
        today: { ...sampleCost, callCount: 3 },
        '7d': { ...sampleCost, callCount: 6 },
        '30d': { ...sampleCost, callCount: 10 },
      },
      providerBreakdownByRange: { today: [], '7d': [], '30d': [] },
      updatedAt: '2026-11-26T12:00:00.000Z',
    },
    rateCards: DEFAULT_MODEL_RATE_CARDS.map((c) => ({ ...c })),
    pricingSource: 'reference-api-estimate',
    generatedAt: '2026-11-26T12:00:00.000Z',
  };
}

function makeSessionPaneProps(overrides: Partial<SessionPaneProps> = {}): SessionPaneProps {
  const session = overrides.session !== undefined ? overrides.session : makeSession();
  return {
    slotIndex: 0,
    layoutMode: 'single',
    isFocused: true,
    session,
    availableSessions: session ? [session] : [],
    availableModels: [
      { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { modelId: 'claude-opus-5.5', name: 'Claude Opus 5.5' },
    ],
    messages: [],
    pendingApprovals: [],
    approvalConfig: makeApprovalConfig(),
    defaultThoughtTrack: 'zh',
    telemetryDashboard: makeRichTelemetry(session?.sessionId ?? 'sess-v034-1'),
    scrollMemoryRef: { current: {} as Record<string, number> },
    canTriggerDemoApproval: false,
    appIcon: 'auto',
    onFocusPane: vi.fn(),
    onBindSlotSession: vi.fn(),
    onOpenNewSession: vi.fn(),
    onReviseMessage: vi.fn().mockResolvedValue(undefined),
    onSendPrompt: vi.fn().mockResolvedValue(undefined),
    onCancelPrompt: vi.fn().mockResolvedValue(undefined),
    onCompactContext: vi.fn().mockResolvedValue(undefined),
    onSetSessionMode: vi.fn().mockResolvedValue(undefined),
    onSetSessionEffort: vi.fn().mockResolvedValue(undefined),
    onSetSessionModel: vi.fn().mockResolvedValue(undefined),
    onQueryWorkspaceFiles: vi.fn().mockResolvedValue([]),
    onSubmitApproval: vi.fn().mockResolvedValue(undefined),
    onCycleApprovalMode: vi.fn().mockResolvedValue(undefined),
    onOpenApprovalSettings: vi.fn(),
    onOpenAccountSettings: vi.fn(),
    onLaunchOfficialLogin: vi.fn(),
    onOpenSwarmInspector: vi.fn(),
    onOpenContextInspector: vi.fn(),
    onInspectDiffFile: vi.fn(),
    onTriggerDemoApproval: vi.fn(),
    ...overrides,
  };
}

async function makeSettingsProps() {
  const fallback = getFallbackDesktopBridge();
  const boot = await fallback.getBootstrap();
  return {
    fallback,
    boot,
    props: {
      section: 'general' as const,
      preferences: boot.preferences,
      connection: boot.connection,
      accounts: boot.accounts,
      approvalConfig: boot.approvalConfig,
      auditEntries: [] as ApprovalAuditEntry[],
      plugins: boot.plugins,
      rateCards: boot.telemetry.rateCards,
      updateState: boot.updateState!,
      onSectionChange: vi.fn(),
      onClose: vi.fn(),
      onUpdatePreferences: vi.fn().mockResolvedValue(undefined),
      onUpdateTranslationConfig: vi.fn().mockResolvedValue(DEFAULT_TRANSLATION_CONFIG),
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
    },
  };
}

function emptyPage(messages: ChatMessageItem[] = []) {
  return {
    earlierCount: 0,
    earlierUserCount: 0,
    earlierVisibleCount: 0,
    precedingOriginId: null,
    messages,
  };
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute('hidden') && !el.closest('[hidden]'));
}

beforeEach(() => {
  delete window.gravityDesktop;
  document.body.className = '';
  document.head.innerHTML = '';
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetFallbackDesktopBridge();
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  document.body.className = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Gravity v0.3.4 前端功能、图标主题动效、缺陷清零与用户专项 TDD 回归 (UT-03 ~ UT-18)', () => {
  /* ------------------------------------------------------------------ UT-03 */
  it('UT-03 (D2)：appIcon="auto" 切换 6 套预设精准映射 recommendedIconId 并联动 Rail/Favicon；手动锁定图标不随主题切换', async () => {
    // 1) 共享层纯函数精准映射
    for (const preset of THEME_PRESETS) {
      expect(resolveEffectiveGravityIconId('auto', preset.id)).toBe(preset.recommendedIconId);
      expect(resolveEffectiveGravityIconId('gravity-ubuntu', preset.id)).toBe('gravity-ubuntu');
    }
    expect(resolveEffectiveGravityIconId('auto', 'system', undefined, true)).toBe('gravity-claude-light');
    expect(resolveEffectiveGravityIconId('auto', 'system', undefined, false)).toBe('gravity-claude-dark');
    expect(
      resolveEffectiveGravityIconId('auto', 'custom', { baseThemeId: 'solarized-dark', polarity: 'dark' })
    ).toBe('gravity-solarized');

    // 2) IconsPanel 首位增加 icon-variant-auto（跟随主题）
    const onSetAppIcon = vi.fn().mockResolvedValue(undefined);
    const iconPrefs: ClientPreferences = {
      locale: 'zh-CN',
      theme: 'macos-light',
      appIcon: 'auto',
      defaultThoughtTrack: 'zh',
      processPerSession: false,
      activeProfileId: 'default',
    };
    const iconsView = render(wrap(<IconsPanel preferences={iconPrefs} onSetAppIcon={onSetAppIcon} />));
    const grid = screen.getByTestId('app-icons-grid');
    const autoBtn = screen.getByTestId('icon-variant-auto');
    expect(grid.firstElementChild).toBe(autoBtn);
    expect(autoBtn.className).toContain('is-selected');
    fireEvent.click(autoBtn);
    expect(onSetAppIcon).toHaveBeenCalledWith('auto');
    iconsView.unmount();

    // 3) 完整 <App /> 联动测试：appIcon='auto' 切主题时 ActivityRail 徽标与 document favicon 必须同步切换
    const fallback = getFallbackDesktopBridge();
    await fallback.updatePreferences({ theme: 'claude-code-dark', appIcon: 'auto' });
    render(<App />);
    await screen.findByTestId('agy-app-root');

    const getRailSrc = () => screen.getByTestId('topbar-app-icon').getAttribute('src') || '';
    const getFaviconHref = () => document.querySelector<HTMLLinkElement>("link[rel='icon']")?.getAttribute('href') || '';

    expect(getRailSrc()).toContain('gravity-claude-dark.svg');
    expect(getFaviconHref()).toContain('gravity-claude-dark.svg');

    // 打开设置切换至 solarized-dark -> auto 图标必须自动切换为 gravity-solarized.svg
    fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
    fireEvent.click(await screen.findByTestId('settings-tab-themes'));
    fireEvent.click(screen.getByTestId('theme-card-solarized-dark'));
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('solarized-dark');
      expect(getRailSrc()).toContain('gravity-solarized.svg');
      expect(getFaviconHref()).toContain('gravity-solarized.svg');
    });

    // 手动锁定 gravity-ubuntu 后再切换至 macos-light -> 图标必须维持 gravity-ubuntu.svg 不跟随
    fireEvent.click(screen.getByTestId('settings-tab-icons'));
    fireEvent.click(await screen.findByTestId('icon-variant-gravity-ubuntu'));
    await waitFor(() => expect(getRailSrc()).toContain('gravity-ubuntu.svg'));

    fireEvent.click(screen.getByTestId('settings-tab-themes'));
    fireEvent.click(screen.getByTestId('theme-card-macos-light'));
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('macos-light'));
    expect(getRailSrc()).toContain('gravity-ubuntu.svg');
    expect(getFaviconHref()).toContain('gravity-ubuntu.svg');
  });

  /* ------------------------------------------------------------------ UT-04 */
  it('UT-04 (U-03 / ui/Icon)：统一 ui/Icon 4 档尺寸与 aria-hidden、Composer 0 原始 ⏵⏵/⏸ Unicode、编辑与纯图标按钮具备规范矢量图标与 aria-label', async () => {
    // 1) 验证 ui/Icon.tsx 存在且定义 4 档尺寸枚举 {12,14,16,18} + absoluteStrokeWidth + aria-hidden
    const iconFile = path.join(RENDERER_DIR, 'components', 'ui', 'Icon.tsx');
    expect(fs.existsSync(iconFile), 'src/renderer/components/ui/Icon.tsx must exist').toBe(true);
    const iconSrc = fs.readFileSync(iconFile, 'utf8');
    expect(iconSrc).toContain('absoluteStrokeWidth');
    expect(iconSrc).toContain('aria-hidden');
    for (const px of ['12', '14', '16', '18']) {
      expect(iconSrc).toContain(px);
    }

    // 2) U-03：Composer 全部 4 种执行模式药丸与菜单项不得出现原始 ⏵⏵ / ⏸ / › Unicode 字符，均使用矢量 SVG
    const modes = ['default', 'accept-edits', 'plan', 'full-access'] as const;
    for (const mode of modes) {
      const sess = makeSession({ sessionId: `sess-u03-${mode}`, executionMode: mode });
      const view = render(
        wrap(
          <Composer
            session={sess}
            availableSessions={[sess]}
            availableModels={[]}
            approvalConfig={makeApprovalConfig()}
            canTriggerDemoApproval={false}
            onSendPrompt={vi.fn().mockResolvedValue(undefined)}
            onCancelPrompt={vi.fn().mockResolvedValue(undefined)}
            onCompactContext={vi.fn().mockResolvedValue(undefined)}
            onSetSessionMode={vi.fn().mockResolvedValue(undefined)}
            onSetSessionEffort={vi.fn().mockResolvedValue(undefined)}
            onSetSessionModel={vi.fn().mockResolvedValue(undefined)}
            onQueryWorkspaceFiles={vi.fn().mockResolvedValue([])}
            onCycleApprovalMode={vi.fn().mockResolvedValue(undefined)}
            onOpenApprovalSettings={vi.fn()}
            onOpenContextInspector={vi.fn()}
            onTriggerDemoApproval={vi.fn()}
          />
        )
      );

      const pill = screen.getByTestId(`execution-mode-pill-${sess.sessionId}`);
      expect(pill.textContent).not.toMatch(/[⏵⏸›]/);
      const pillSvg = pill.querySelector('svg');
      expect(pillSvg, `Mode pill (${mode}) must render a vector icon SVG`).toBeTruthy();
      expect(pillSvg!.getAttribute('aria-hidden')).toBe('true');

      if (mode === 'accept-edits') {
        fireEvent.click(pill);
        const menu = screen.getByTestId(`execution-mode-menu-${sess.sessionId}`);
        expect(menu.textContent).not.toMatch(/[⏵⏸›]/);
        for (const optMode of modes) {
          const item = screen.getByTestId(`execution-mode-option-${optMode}-${sess.sessionId}`);
          const glyphSvg = item.querySelector('.mode-menu-glyph svg, svg.lucide');
          expect(glyphSvg, `Mode menu item (${optMode}) must render a vector SVG`).toBeTruthy();
          expect(glyphSvg!.getAttribute('aria-hidden')).toBe('true');
        }
      }
      view.unmount();
    }

    // 3) 全站编辑按钮（EditUserMessage + ProjectSidebar）与关键纯图标按钮均使用合法 4 档尺寸 + aria-label
    const editMsg: ChatMessageItem = {
      id: 'u-u03',
      sessionId: 'sess-u03',
      role: 'user',
      content: '检查编辑图标',
      createdAt: '2026-11-26T12:00:00.000Z',
    };
    const editView = render(
      wrap(
        <EditUserMessage message={editMsg} busy={false} submit={vi.fn().mockResolvedValue(undefined)}>
          <span>检查编辑图标</span>
        </EditUserMessage>
      )
    );
    const editBtn = screen.getByTestId('edit-msg-u-u03');
    expect(editBtn.getAttribute('aria-label')).toBeTruthy();
    const editSvg = editBtn.querySelector('svg');
    expect(editSvg).toBeTruthy();
    expect(ALLOWED_ICON_SIZES.has(editSvg!.getAttribute('width') || '')).toBe(true);
    expect(editSvg!.getAttribute('aria-hidden')).toBe('true');
    editView.unmount();

    // 4) 核验核心工作台纯图标按钮（含 ProjectSidebar quick-new-in-group-* 等 7+ 处）全部具备 aria-label
    const sidebarSess = makeSession({ sessionId: 'sess-aria-1' });
    const sidebarProj: WorkspaceProjectConfig = { id: 'p1', name: 'DemoProj', path: sidebarSess.cwd };
    const sideView = render(
      wrap(
        <ProjectSidebar
          collapsed={false}
          width={264}
          sessions={[sidebarSess]}
          openTabSessionIds={[sidebarSess.sessionId]}
          selectedSessionId={sidebarSess.sessionId}
          hideLegacyPollutionSessions={true}
          organizingTitles={false}
          projects={[sidebarProj]}
          onToggleCollapse={vi.fn()}
          onSelectSession={vi.fn()}
          onOpenNewSession={vi.fn()}
          onCreateSessionInProject={vi.fn()}
          onOrganizeTitles={vi.fn().mockResolvedValue(undefined)}
          onTogglePollutionVisibility={vi.fn().mockResolvedValue(undefined)}
          onRenameSession={vi.fn().mockResolvedValue(undefined)}
          onTogglePinSession={vi.fn().mockResolvedValue(undefined)}
          onManageSession={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );
    const iconOnlyButtons = Array.from(sideView.container.querySelectorAll<HTMLButtonElement>('button')).filter(
      (btn) => (btn.textContent || '').trim() === ''
    );
    expect(iconOnlyButtons.length).toBeGreaterThanOrEqual(7);
    for (const btn of iconOnlyButtons) {
      expect(
        Boolean(btn.getAttribute('aria-label')?.trim()),
        `Icon-only button missing aria-label: ${btn.outerHTML.slice(0, 140)}`
      ).toBe(true);
      const svg = btn.querySelector('svg');
      if (svg) {
        expect(
          ALLOWED_ICON_SIZES.has(svg.getAttribute('width') || ''),
          `Icon SVG width "${svg.getAttribute('width')}" outside {12,14,16,18} on ${btn.getAttribute('data-testid') || btn.className}`
        ).toBe(true);
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      }
    }
    sideView.unmount();
  });

  /* ------------------------------------------------------------------ UT-05 */
  it('UT-05 (F-08)：React.Profiler 流式重渲染预算 — 向会话 A 推 50 分片，窗格 B 与 Sidebar commit = 0，Inspector 受合批控制', async () => {
    const sessA = makeSession({ sessionId: 'sess-prof-a', status: 'streaming', title: 'Session A' });
    const sessB = makeSession({ sessionId: 'sess-prof-b', status: 'idle', title: 'Session B' });
    const telemetry = makeRichTelemetry('sess-prof-a');
    const approvalCfg = makeApprovalConfig();
    const scrollMemoryRef = { current: {} as Record<string, number> };
    const noop = vi.fn();
    const noopAsync = vi.fn().mockResolvedValue(undefined);
    const queryFiles = vi.fn().mockResolvedValue([]);
    const sessions = [sessA, sessB];
    const openTabs = [sessA.sessionId, sessB.sessionId];
    const emptyMsgsB: ChatMessageItem[] = [];
    const emptyPending: [] = [];
    const inspectorDataA: SessionInspectorData = {
      sessionId: sessA.sessionId,
      diffs: [],
      todos: [],
      terminals: [],
    };

    // Verify React.memo boundary exists on all three hot workbench regions (F-08)
    const REACT_MEMO_TYPE = Symbol.for('react.memo');
    const memoPane = SessionPane as unknown as { $$typeof?: symbol; type: (...args: unknown[]) => unknown };
    const memoSidebar = ProjectSidebar as unknown as { $$typeof?: symbol; type: (...args: unknown[]) => unknown };
    const memoInspector = RightInspector as unknown as { $$typeof?: symbol; type: (...args: unknown[]) => unknown };
    expect(memoPane.$$typeof, 'SessionPane must be wrapped in React.memo').toBe(REACT_MEMO_TYPE);
    expect(memoSidebar.$$typeof, 'ProjectSidebar must be wrapped in React.memo').toBe(REACT_MEMO_TYPE);
    expect(memoInspector.$$typeof, 'RightInspector must be wrapped in React.memo').toBe(REACT_MEMO_TYPE);

    let paneBRenders = 0;
    let sidebarRenders = 0;
    let inspectorRenders = 0;
    const origPaneType = memoPane.type;
    const origSidebarType = memoSidebar.type;
    const origInspectorType = memoInspector.type;
    memoPane.type = function trackedPane(props: unknown) {
      const p = props as { session?: { sessionId?: string } | null } | undefined;
      if (p?.session?.sessionId === sessB.sessionId) paneBRenders += 1;
      return origPaneType(props);
    };
    memoSidebar.type = function trackedSidebar(props: unknown) {
      sidebarRenders += 1;
      return origSidebarType(props);
    };
    memoInspector.type = function trackedInspector(props: unknown) {
      inspectorRenders += 1;
      return origInspectorType(props);
    };

    let pushChunk!: (chunkText: string) => void;

    function StreamingBench() {
      const [msgsA, setMsgsA] = React.useState<ChatMessageItem[]>([
        {
          id: 'a-stream-1',
          sessionId: sessA.sessionId,
          role: 'assistant',
          content: 'start',
          isStreaming: true,
          createdAt: '2026-11-26T12:00:00.000Z',
        },
      ]);
      pushChunk = (chunkText: string) => {
        setMsgsA((prev) => [{ ...prev[0], content: prev[0].content + chunkText }]);
      };

      return wrap(
        <div>
          <Profiler id="sidebar" onRender={() => {}}>
            <ProjectSidebar
              collapsed={false}
              width={264}
              sessions={sessions}
              openTabSessionIds={openTabs}
              selectedSessionId={sessA.sessionId}
              hideLegacyPollutionSessions={true}
              organizingTitles={false}
              onToggleCollapse={noop}
              onSelectSession={noop}
              onOpenNewSession={noop}
              onOrganizeTitles={noopAsync}
              onTogglePollutionVisibility={noopAsync}
              onRenameSession={noopAsync}
              onTogglePinSession={noopAsync}
            />
          </Profiler>
          <SessionPane
            slotIndex={0}
            layoutMode="split-2"
            isFocused={true}
            session={sessA}
            availableSessions={sessions}
            availableModels={[]}
            messages={msgsA}
            pendingApprovals={emptyPending}
            approvalConfig={approvalCfg}
            defaultThoughtTrack="zh"
            telemetryDashboard={telemetry}
            scrollMemoryRef={scrollMemoryRef}
            canTriggerDemoApproval={false}
            appIcon="auto"
            onFocusPane={noop}
            onBindSlotSession={noop}
            onOpenNewSession={noop}
            onSendPrompt={noopAsync}
            onCancelPrompt={noopAsync}
            onCompactContext={noopAsync}
            onSetSessionMode={noopAsync}
            onSetSessionEffort={noopAsync}
            onSetSessionModel={noopAsync}
            onQueryWorkspaceFiles={queryFiles}
            onSubmitApproval={noopAsync}
            onCycleApprovalMode={noopAsync}
            onOpenApprovalSettings={noop}
            onOpenSwarmInspector={noop}
            onOpenContextInspector={noop}
            onInspectDiffFile={noop}
            onTriggerDemoApproval={noop}
          />
          <Profiler id="pane-b" onRender={() => {}}>
            <SessionPane
              slotIndex={1}
              layoutMode="split-2"
              isFocused={false}
              session={sessB}
              availableSessions={sessions}
              availableModels={[]}
              messages={emptyMsgsB}
              pendingApprovals={emptyPending}
              approvalConfig={approvalCfg}
              defaultThoughtTrack="zh"
              telemetryDashboard={telemetry}
              scrollMemoryRef={scrollMemoryRef}
              canTriggerDemoApproval={false}
              appIcon="auto"
              onFocusPane={noop}
              onBindSlotSession={noop}
              onOpenNewSession={noop}
              onSendPrompt={noopAsync}
              onCancelPrompt={noopAsync}
              onCompactContext={noopAsync}
              onSetSessionMode={noopAsync}
              onSetSessionEffort={noopAsync}
              onSetSessionModel={noopAsync}
              onQueryWorkspaceFiles={queryFiles}
              onSubmitApproval={noopAsync}
              onCycleApprovalMode={noopAsync}
              onOpenApprovalSettings={noop}
              onOpenSwarmInspector={noop}
              onOpenContextInspector={noop}
              onInspectDiffFile={noop}
              onTriggerDemoApproval={noop}
            />
          </Profiler>
          <Profiler id="inspector" onRender={() => {}}>
            <RightInspector
              collapsed={false}
              width={380}
              activeTab="diff"
              focusedDiffFile={null}
              sessionId={sessA.sessionId}
              inspectorData={inspectorDataA}
              sessionMessages={emptyMsgsB}
              telemetry={telemetry}
              onSelectTab={noop}
              onFocusDiffFile={noop}
              onCommitWidth={noop}
              onOpenRateCardsSettings={noop}
            />
          </Profiler>
        </div>
      );
    }

    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getAccountQuota: vi.fn().mockResolvedValue({ unavailable: 'preview' }),
    };

    try {
      render(<StreamingBench />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      paneBRenders = 0;
      sidebarRenders = 0;
      inspectorRenders = 0;

      for (let i = 0; i < 50; i += 1) {
        act(() => {
          pushChunk(` token-${i}`);
        });
      }

      expect(paneBRenders, 'Pane B must not re-render while Session A streams').toBe(0);
      expect(sidebarRenders, 'ProjectSidebar must not re-render while Session A streams').toBe(0);
      expect(inspectorRenders, 'RightInspector must not commit on unrelated text-only streaming chunks').toBeLessThanOrEqual(4);
    } finally {
      memoPane.type = origPaneType;
      memoSidebar.type = origSidebarType;
      memoInspector.type = origInspectorType;
    }
  });

  /* ------------------------------------------------------------------ UT-06 */
  it('UT-06 (F-08)：10,000 字长回答流式追加时 Markdown 已闭合块不重复解析，增量追加耗时 < 基线 30%', () => {
    const sections = Array.from({ length: 40 }, (_, i) =>
      `## Section ${i + 1}\n\nParagraph ${i + 1}: ${'Gravity incremental markdown parser stability check. '.repeat(4)}\n\n\`\`\`ts\nexport const block_${i + 1} = ${i + 1};\n\`\`\``
    );
    const baseDoc = sections.join('\n\n') + '\n\n';
    expect(baseDoc.length).toBeGreaterThanOrEqual(10_000);

    // 验证源码层面具备闭合块缓存 / 增量解析（而非每次分片全量 parseDocument）
    const mdSource = fs.readFileSync(path.join(RENDERER_DIR, 'components', 'Markdown.tsx'), 'utf8');
    const mdDir = path.join(RENDERER_DIR, 'components', 'markdown');
    const extraMdSources = fs.existsSync(mdDir)
      ? fs
          .readdirSync(mdDir)
          .filter((f) => /\.tsx?$/.test(f))
          .map((f) => fs.readFileSync(path.join(mdDir, f), 'utf8'))
          .join('\n')
      : '';
    const combinedMdSrc = `${mdSource}\n${extraMdSources}`;
    expect(
      /React\.memo|memo\s*\(/.test(combinedMdSrc),
      'Markdown block renderer must memoize closed blocks to prevent re-rendering all preceding blocks per chunk'
    ).toBe(true);

    // 1) 基线：20 次冷启动全量解析渲染
    const steps = 20;
    const coldStart = performance.now();
    for (let i = 0; i < steps; i += 1) {
      const v = render(wrap(<Markdown text={baseDoc + 'Tail chunk '.repeat(i + 1)} streaming={true} />));
      v.unmount();
    }
    const coldMs = Math.max(1, performance.now() - coldStart);

    // 2) 增量流式追加：同一实例连续追加 20 个尾分片
    const view = render(wrap(<Markdown text={baseDoc + 'Tail chunk '} streaming={true} />));
    const firstHeadingNode = view.container.querySelector('h2');
    const firstCodeNode = view.container.querySelector('.code-block');
    expect(firstHeadingNode).toBeTruthy();
    expect(firstCodeNode).toBeTruthy();

    const incStart = performance.now();
    for (let i = 1; i < steps; i += 1) {
      view.rerender(wrap(<Markdown text={baseDoc + 'Tail chunk '.repeat(i + 1)} streaming={true} />));
    }
    const incMs = performance.now() - incStart;

    // 已闭合前缀块 DOM 节点身份保持稳定
    expect(view.container.querySelector('h2')).toBe(firstHeadingNode);
    expect(view.container.querySelector('.code-block')).toBe(firstCodeNode);
    expect(view.container.textContent).toContain('Tail chunk');
    expect(
      incMs / coldMs,
      `Incremental streaming render (${incMs.toFixed(1)}ms) must be < 30% of full parse baseline (${coldMs.toFixed(1)}ms)`
    ).toBeLessThan(0.3);
  });

  /* ------------------------------------------------------------------ UT-07 */
  it('UT-07 (F-09)：流式粘底跟随（ResizeObserver 监听尾分片与图片撑高自动跟底；用户上滑即解并显示 jump-latest）', () => {
    const callbacks: Array<ResizeObserverCallback> = [];
    const observedTargets: Element[] = [];

    class MockResizeObserver implements ResizeObserver {
      constructor(private cb: ResizeObserverCallback) {
        callbacks.push(cb);
      }
      observe(target: Element): void {
        observedTargets.push(target);
      }
      unobserve(): void {}
      disconnect(): void {}
    }

    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver;

    try {
      const sid = 'sess-stick-f09';
      const streamingSess = makeSession({ sessionId: sid, status: 'streaming' });
      const msg: ChatMessageItem = {
        id: 'a-f09',
        sessionId: sid,
        role: 'assistant',
        content: '流式输出首段内容',
        isStreaming: true,
        createdAt: '2026-11-26T12:00:00.000Z',
      };

      const view = render(wrap(<SessionPane {...makeSessionPaneProps({ session: streamingSess, messages: [msg] })} />));
      const stream = view.container.querySelector<HTMLDivElement>('.stream')!;
      const streamInner = view.container.querySelector<HTMLDivElement>('.stream-inner')!;
      expect(stream && streamInner).toBeTruthy();

      let currentScrollHeight = 1000;
      let currentScrollTop = 600;
      Object.defineProperty(stream, 'clientHeight', { configurable: true, get: () => 400 });
      Object.defineProperty(stream, 'scrollHeight', { configurable: true, get: () => currentScrollHeight });
      Object.defineProperty(stream, 'scrollTop', {
        configurable: true,
        get: () => currentScrollTop,
        set: (v: number) => {
          currentScrollTop = v;
        },
      });

      const observesStreamContent = observedTargets.some((el) => el === streamInner || el === stream);
      expect(observesStreamContent, 'F-09: SessionPane must attach ResizeObserver to stream content for stick-to-bottom').toBe(true);

      const fireResize = () => {
        act(() => {
          for (const cb of callbacks) {
            cb([] as ResizeObserverEntry[], {} as ResizeObserver);
          }
        });
      };

      // 模拟尾分片与图片加载将内容撑高（messages 引用未变），粘底必须自动跟到底部
      currentScrollHeight = 1520;
      fireResize();
      expect(currentScrollTop).toBeGreaterThanOrEqual(currentScrollHeight - 400);

      // 模拟用户手动上滑阅读历史
      currentScrollTop = 120;
      fireEvent.scroll(stream);
      expect(screen.getByTestId(`jump-latest-${sid}`)).toBeTruthy();

      // 再次撑高：用户已脱离底部，绝不可强行拉回底部
      currentScrollHeight = 2100;
      fireResize();
      expect(currentScrollTop).toBe(120);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  /* ------------------------------------------------------------------ UT-08 */
  it('UT-08 (F-17)：prefers-reduced-motion=reduce 时打字机直显全文（0 rAF），滚动均为 behavior:"auto"', () => {
    const origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: /prefers-reduced-motion\s*:\s*reduce/i.test(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

    try {
      // 1) useFluidStreamText(forceAnimation=true) 在 reduced-motion 下必须零 rAF 直显全文
      const fullText = 'Reduced motion must immediately reveal the entire streamed answer without scheduling rAF frames.';
      let observedState: ReturnType<typeof useFluidStreamText> | null = null;
      function Probe() {
        observedState = useFluidStreamText(fullText, true, 'assistant', true);
        return <div data-testid="fluid-probe">{observedState.visibleText}</div>;
      }
      const probeView = render(<Probe />);
      expect(screen.getByTestId('fluid-probe').textContent).toBe(fullText);
      expect(observedState!.isCatchingUp).toBe(false);
      expect(rafSpy).toHaveBeenCalledTimes(0);
      probeView.unmount();

      // 2) SessionPane jumpToLatest 滚动行为必须为 'auto'（绝不使用 'smooth'）
      const sid = 'sess-rm-f17';
      const sess = makeSession({ sessionId: sid });
      const paneView = render(wrap(<SessionPane {...makeSessionPaneProps({ session: sess })} />));
      const stream = paneView.container.querySelector<HTMLDivElement>('.stream')!;
      const scrollToSpy = vi.fn();
      stream.scrollTo = scrollToSpy as unknown as typeof stream.scrollTo;
      Object.defineProperty(stream, 'clientHeight', { configurable: true, get: () => 400 });
      Object.defineProperty(stream, 'scrollHeight', { configurable: true, get: () => 2000 });
      Object.defineProperty(stream, 'scrollTop', { configurable: true, writable: true, value: 100 });

      fireEvent.scroll(stream);
      fireEvent.click(screen.getByTestId(`jump-latest-${sid}`));

      if (scrollToSpy.mock.calls.length > 0) {
        const arg = scrollToSpy.mock.calls[0][0] as ScrollToOptions;
        expect(arg?.behavior).toBe('auto');
      } else {
        expect(stream.scrollTop).toBe(2000);
      }
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });

  /* ------------------------------------------------------------------ UT-09 */
  it('UT-09 (F-01 / F-02 / F-10 / D3)：按钮焦点 Shift+Tab 不劫持导航、流式额度弹层 Esc 不中断回合、设置背景点击不误关、新建入口精简 5→3', async () => {
    // 1) F-01 + D3：在完整 <App /> 中测试按钮焦点 Shift+Tab 与新建入口 5→3
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    const sess = makeSession({ sessionId: 'sess-f01', executionMode: 'default' });
    const setSessionMode = vi.fn().mockImplementation(async (id: string, mode: ManagedSessionSummary['executionMode']) =>
      makeSession({ sessionId: id, executionMode: mode })
    );
    const setApprovalMode = vi.fn().mockResolvedValue(baseBoot.approvalConfig);

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        sessions: [sess],
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: [sess.sessionId],
          activePrimarySessionId: sess.sessionId,
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
      }),
      getSessionMessagePage: async () => emptyPage([]),
      setSessionMode,
      setApprovalMode,
    };

    const appView = render(<App />);
    await screen.findByTestId('composer-input-sess-f01');

    // D3：移除 TopBar `+` 与侧栏头重复 `+`，保留 ActivityRail `+`
    expect(screen.queryByTestId('topbar-new-session-btn')).toBeNull();
    const sidebarHead = document.querySelector('.sidebar-head') as HTMLElement;
    expect(sidebarHead).toBeTruthy();
    expect(within(sidebarHead).queryByRole('button', { name: /新建会话|New/i })).toBeNull();
    expect(screen.getByTestId('sidebar-new-session-btn')).toBeTruthy();

    // F-01：焦点位于按钮时按 Shift+Tab 不应劫持焦点后退，也不得切换执行模式或审批档位
    const focusBtn = screen.getByTestId('toggle-right-inspector-btn');
    focusBtn.focus();
    const keyEv = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      focusBtn.dispatchEvent(keyEv);
    });
    expect(keyEv.defaultPrevented, 'F-01: Shift+Tab on focused button must not call preventDefault()').toBe(false);
    expect(setSessionMode).not.toHaveBeenCalled();
    expect(setApprovalMode).not.toHaveBeenCalled();

    // 对照：焦点不在交互控件上（document.body）时，全局 Shift+Tab 仍正常循环执行模式
    focusBtn.blur();
    document.body.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(setSessionMode).toHaveBeenCalledWith('sess-f01', 'accept-edits'));
    appView.unmount();

    // 2) F-02：流式生成中打开 AccountQuota 弹层后按 Escape 只关闭弹层，绝不调用 onCancelPrompt
    const onCancelPrompt = vi.fn().mockResolvedValue(undefined);
    const streamingSess = makeSession({ sessionId: 'sess-f02', status: 'streaming' });
    const paneView = render(
      wrap(<SessionPane {...makeSessionPaneProps({ session: streamingSess, onCancelPrompt })} />)
    );
    fireEvent.click(screen.getByTestId('quota-weekly'));
    await screen.findByTestId('quota-details');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('quota-details')).toBeNull());
    expect(onCancelPrompt, 'F-02: Escape closing quota popover must NOT cancel streaming turn').not.toHaveBeenCalled();
    paneView.unmount();

    // 3) F-10 / D3：SettingsView 点击背景遮罩不关闭（防草稿误关），按 Esc 正常关闭
    const { props } = await makeSettingsProps();
    const onClose = vi.fn();
    render(wrap(<SettingsView {...props} onClose={onClose} />));
    const backdrop = screen.getByTestId('settings-overlay');
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose, 'F-10 / D3: Clicking SettingsView backdrop must NOT close settings').not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /* ------------------------------------------------------------------ UT-10 */
  it('UT-10 (F-12)：收起侧栏与检视器具备 inert 属性且不渲染内部可聚焦控件，焦点 0 落入', () => {
    const sess = makeSession({ sessionId: 'sess-f12' });
    const view = render(
      wrap(
        <div>
          <ProjectSidebar
            collapsed={true}
            width={264}
            sessions={[sess]}
            openTabSessionIds={[sess.sessionId]}
            selectedSessionId={sess.sessionId}
            hideLegacyPollutionSessions={true}
            organizingTitles={false}
            onToggleCollapse={vi.fn()}
            onSelectSession={vi.fn()}
            onOpenNewSession={vi.fn()}
            onOrganizeTitles={vi.fn().mockResolvedValue(undefined)}
            onTogglePollutionVisibility={vi.fn().mockResolvedValue(undefined)}
            onRenameSession={vi.fn().mockResolvedValue(undefined)}
            onTogglePinSession={vi.fn().mockResolvedValue(undefined)}
          />
          <RightInspector
            collapsed={true}
            width={380}
            activeTab="diff"
            focusedDiffFile={null}
            sessionId={sess.sessionId}
            sessionMessages={[]}
            telemetry={makeRichTelemetry(sess.sessionId)}
            onSelectTab={vi.fn()}
            onFocusDiffFile={vi.fn()}
            onCommitWidth={vi.fn()}
            onOpenRateCardsSettings={vi.fn()}
          />
        </div>
      )
    );

    for (const testId of ['project-sidebar', 'right-inspector']) {
      const aside = screen.getByTestId(testId) as HTMLElement & { inert?: boolean };
      expect(aside.getAttribute('aria-hidden')).toBe('true');
      expect(
        aside.hasAttribute('inert') || aside.inert === true,
        `F-12: Collapsed ${testId} must set inert attribute`
      ).toBe(true);
      expect(
        getFocusableElements(aside).length,
        `F-12: Collapsed ${testId} must not mount focusable inner controls`
      ).toBe(0);
    }
    view.unmount();
  });

  /* ------------------------------------------------------------------ UT-11 */
  it('UT-11 (F-13)：Settings / NewSession / TitleOrganizer 模态焦点陷阱（连续 Tab 30 次不越界）且关闭准确归还触发按钮', async () => {
    const { props: settingsBase } = await makeSettingsProps();

    async function assertModalFocusTrap(
      name: string,
      renderModal: (open: boolean, onClose: () => void) => React.ReactNode
    ) {
      function Harness() {
        const [open, setOpen] = React.useState(false);
        return wrap(
          <div>
            <button type="button" data-testid="outside-before">Before</button>
            <button type="button" data-testid="modal-trigger" onClick={() => setOpen(true)}>
              Open {name}
            </button>
            <button type="button" data-testid="outside-after">After</button>
            {renderModal(open, () => setOpen(false))}
          </div>
        );
      }

      const view = render(<Harness />);
      const trigger = screen.getByTestId('modal-trigger');
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      fireEvent.click(trigger);

      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

      const tabbables = getFocusableElements(dialog);
      expect(tabbables.length, `${name} dialog must have focusable elements`).toBeGreaterThanOrEqual(2);

      // 连续测试 30 次 Tab（含从末尾向后回绕与从首位 Shift+Tab 向前倒绕）
      for (let step = 0; step < 30; step += 1) {
        const current = document.activeElement as HTMLElement;
        const idx = tabbables.indexOf(current);
        const reverse = step >= 20;
        const atBoundary = reverse ? idx <= 0 : idx === tabbables.length - 1;
        const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: reverse, bubbles: true, cancelable: true });
        act(() => {
          current.dispatchEvent(ev);
        });
        if (atBoundary) {
          expect(
            ev.defaultPrevented,
            `F-13 (${name}): Focus trap must intercept Tab boundary wrap at step ${step}`
          ).toBe(true);
        } else if (!ev.defaultPrevented) {
          const nextIdx = reverse ? idx - 1 : idx + 1;
          tabbables[nextIdx]?.focus();
        }
        expect(
          dialog.contains(document.activeElement),
          `F-13 (${name}): Focus escaped modal at step ${step}`
        ).toBe(true);
      }

      // 关闭模态后焦点必须准确归还到触发按钮
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => {
        expect(document.activeElement, `F-13 (${name}): Closing modal must restore focus to trigger button`).toBe(trigger);
      });
      view.unmount();
    }

    await assertModalFocusTrap('SettingsView', (open, onClose) =>
      open ? <SettingsView {...settingsBase} onClose={onClose} /> : null
    );

    await assertModalFocusTrap('NewSessionModal', (open, onClose) => (
      <NewSessionModal
        open={open}
        defaultCwd="C:\\Workspace\\GravityV034"
        onClose={onClose}
        onCreate={vi.fn().mockResolvedValue(undefined)}
      />
    ));

    await assertModalFocusTrap('TitleOrganizerModal', (open, onClose) => (
      <TitleOrganizerModal
        open={open}
        result={{
          updatedCount: 1,
          hiddenPollutionCount: 0,
          suggestions: [
            { sessionId: 's1', previousTitle: 'Old', organizedTitle: 'New', categoryTag: 'feat' },
          ],
        }}
        onClose={onClose}
        onRunOrganize={vi.fn().mockResolvedValue(undefined)}
      />
    ));
  });

  /* ------------------------------------------------------------------ UT-12 */
  it('UT-12 (F-05)：Cost 免责声明在主 Cost、外部复核、外部翻译、单价表、状态行（zh/en）全覆盖且严格匹配 COST_DISCLAIMER[locale]', () => {
    const tele = makeRichTelemetry('sess-f05');
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const expectedText = COST_DISCLAIMER[locale];
      let visibleMatches = 0;

      // 1) 主 Cost 面板
      const mainView = render(
        wrap(
          <ContextCostInspectorView
            sessionId="sess-f05"
            dashboard={tele}
            viewMode="context"
            onOpenRateCardsSettings={vi.fn()}
          />,
          locale
        )
      );
      expect(mainView.container.textContent).toContain(expectedText);
      visibleMatches += 1;
      mainView.unmount();

      // 2) 外部复核花费区（F-05 重点修复点）
      const revView = render(
        wrap(
          <ContextCostInspectorView
            sessionId="sess-f05"
            dashboard={tele}
            viewMode="reviewer"
            onOpenRateCardsSettings={vi.fn()}
          />,
          locale
        )
      );
      expect(
        revView.container.textContent,
        `F-05 (${locale}): External Reviewer Cost view must display exact COST_DISCLAIMER[locale]`
      ).toContain(expectedText);
      visibleMatches += 1;
      revView.unmount();

      // 3) 外部翻译花费区
      const transView = render(
        wrap(
          <ContextCostInspectorView
            sessionId="sess-f05"
            dashboard={tele}
            viewMode="translator"
            onOpenRateCardsSettings={vi.fn()}
          />,
          locale
        )
      );
      expect(transView.container.textContent).toContain(expectedText);
      visibleMatches += 1;
      transView.unmount();

      // 4) 单价表设置页
      const ratesView = render(
        wrap(<RatesPanel rateCards={tele.rateCards} onUpdateRateCards={vi.fn().mockResolvedValue(undefined)} />, locale)
      );
      expect(ratesView.container.textContent).toContain(expectedText);
      visibleMatches += 1;
      ratesView.unmount();

      // 5) 底栏状态行 tooltip
      const barView = render(
        wrap(
          <ContextStatusBar
            sessionId="sess-f05"
            modelId="gemini-4-neon"
            sessionTelemetry={tele.activeSessions['sess-f05']}
            onCompactContext={vi.fn().mockResolvedValue(undefined)}
            onOpenContextInspector={vi.fn()}
          />,
          locale
        )
      );
      expect(screen.getByTestId('context-inspector-trigger-sess-f05').getAttribute('title')).toContain(expectedText);
      barView.unmount();

      expect(visibleMatches).toBeGreaterThanOrEqual(4);
    }
  });

  /* ------------------------------------------------------------------ UT-13 */
  it('UT-13 (F-07 / D1 / K4 / i18n 棘轮)：单标签加载失败仅窗格内降级重试、Inspector 5 一级页签 + Tree 进 Context 二级、内联双语三元 <= 40', async () => {
    // 1) F-07：单标签加载失败不得拖垮整个工作台启动
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    const sOk = makeSession({ sessionId: 'sess-f07-ok', title: '正常会话' });
    const sFail = makeSession({ sessionId: 'sess-f07-fail', title: '异常会话' });

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        sessions: [sOk, sFail],
        layout: {
          ...baseBoot.layout,
          layoutMode: 'split-2',
          openTabSessionIds: [sOk.sessionId, sFail.sessionId],
          activePrimarySessionId: sOk.sessionId,
          splitSecondarySessionId: sFail.sessionId,
        },
        pendingApprovals: [],
      }),
      getSessionMessagePage: async (id) => {
        if (id === sFail.sessionId) throw new Error('Simulated corrupted history page');
        return emptyPage([
          {
            id: 'm-ok-1',
            sessionId: sOk.sessionId,
            role: 'assistant',
            content: 'Healthy pane message loaded fine',
            createdAt: '2026-11-26T12:00:00.000Z',
          },
        ]);
      },
    };

    const appView = render(<App />);
    await screen.findByTestId('agy-app-root');
    expect(screen.queryByTestId('app-bootstrap-error')).toBeNull();
    expect(await screen.findByText('Healthy pane message loaded fine')).toBeTruthy();
    const failedPane = screen.getByTestId(`session-pane-${sFail.sessionId}`);
    expect(
      within(failedPane).queryByRole('alert') || failedPane.textContent?.match(/重试|Retry|加载失败|Failed/i),
      'F-07: Failed tab pane must surface an in-pane error/retry affordance'
    ).toBeTruthy();
    appView.unmount();

    // 2) D1：RightInspector 严格 5 个一级 tab（0 button），inspector-tab-tree 位于 Context 二级视图切换区
    const tree: ConversationTreeState = {
      rootSessionId: 'sess-d1',
      rootTitle: 'D1 主对话',
      activeBranchId: 'sess-d1',
      totalBranches: 2,
      nodes: [
        {
          branchId: 'sess-d1',
          rootSessionId: 'sess-d1',
          parentBranchId: null,
          forkAfterMessageId: null,
          forkUserTurnIndex: -1,
          forkPromptPreview: '主干对话',
          childrenIds: ['sess-d1-b2'],
          depth: 0,
          siblingIndex: 1,
          siblingCount: 2,
          isActiveBranch: true,
          isOnActivePath: true,
          userTurnCount: 1,
          ownMessageCount: 2,
          latestUserPreview: '主干对话',
          latestAssistantPreview: '主干回复',
          createdAt: '2026-11-26T12:00:00.000Z',
          updatedAt: '2026-11-26T12:00:00.000Z',
          status: 'idle',
          modelId: 'gemini-4-neon',
          usedContextTokens: 1200,
          maxContextTokens: 200000,
          usageRatio: 0.006,
          totalCostUsd: 0.01,
        },
        {
          branchId: 'sess-d1-b2',
          rootSessionId: 'sess-d1',
          parentBranchId: 'sess-d1',
          forkAfterMessageId: 'u1',
          forkUserTurnIndex: 0,
          forkPromptPreview: '修订分支',
          childrenIds: [],
          depth: 1,
          siblingIndex: 2,
          siblingCount: 2,
          isActiveBranch: false,
          isOnActivePath: false,
          userTurnCount: 1,
          ownMessageCount: 2,
          latestUserPreview: '修订分支',
          latestAssistantPreview: '分支回复',
          createdAt: '2026-11-26T12:01:00.000Z',
          updatedAt: '2026-11-26T12:01:00.000Z',
          status: 'closed',
          modelId: 'gemini-4-neon',
          usedContextTokens: 900,
          maxContextTokens: 200000,
          usageRatio: 0.0045,
          totalCostUsd: 0.008,
        },
      ],
      nodesById: {},
      updatedAt: '2026-11-26T12:01:00.000Z',
    };
    tree.nodesById = Object.fromEntries(tree.nodes.map((n) => [n.branchId, n]));

    const onSelectTab = vi.fn();
    const inspView = render(
      wrap(
        <RightInspector
          collapsed={false}
          width={380}
          activeTab="context"
          focusedDiffFile={null}
          sessionId="sess-d1"
          sessionMessages={[]}
          telemetry={makeRichTelemetry('sess-d1')}
          conversationTree={tree}
          onSelectTab={onSelectTab}
          onFocusDiffFile={vi.fn()}
          onCommitWidth={vi.fn()}
          onOpenRateCardsSettings={vi.fn()}
        />
      )
    );
    const inspHead = inspView.container.querySelector('.inspector-head') as HTMLElement;
    expect(within(inspHead).getAllByRole('tab')).toHaveLength(5);
    expect(within(inspHead).queryAllByRole('button')).toHaveLength(0);
    expect(within(inspHead).queryByTestId('inspector-tab-tree')).toBeNull();

    const treeSubBtn = screen.getByTestId('inspector-tab-tree');
    expect(inspHead.contains(treeSubBtn)).toBe(false);
    inspView.unmount();

    // 3) i18n 棘轮：组件与 App 中内联双语三元表达式总数 <= 40
    const tsxFiles = walkTsxFiles(RENDERER_DIR);
    let inlineBilingualCount = 0;
    const bilingualTernaryRe = /\b(?:locale\s*===\s*['"]zh-CN['"]|isZh|zh)\s*\?/g;
    for (const file of tsxFiles) {
      const src = fs.readFileSync(file, 'utf8');
      const matches = src.match(bilingualTernaryRe);
      if (matches) inlineBilingualCount += matches.length;
    }
    expect(
      inlineBilingualCount,
      `i18n ratchet exceeded: found ${inlineBilingualCount} inline bilingual ternaries (cap <= 40)`
    ).toBeLessThanOrEqual(40);

    // 4) K4：RightInspector 终端未读键优先使用 entry.revision 而非对输出逐字符哈希
    const inspSrc = fs.readFileSync(path.join(RENDERER_DIR, 'components', 'RightInspector.tsx'), 'utf8');
    expect(inspSrc).toContain('revision');
  });

  /* ------------------------------------------------------------------ UT-14 */
  it('UT-14：核心工作台集成冒烟（ActivityRail + TopBar + 5-tab RightInspector 协同无报错）', async () => {
    render(<App />);
    await screen.findByTestId('agy-app-root');

    const head = screen.getByTestId('right-inspector').querySelector('.inspector-head') as HTMLElement;
    expect(within(head).getAllByRole('tab')).toHaveLength(5);
    expect(screen.queryByTestId('topbar-new-session-btn')).toBeNull();
    expect(screen.getByTestId('sidebar-new-session-btn')).toBeTruthy();

    // 点击 ActivityRail 新建按钮可正常打开新建弹窗
    fireEvent.click(screen.getByTestId('sidebar-new-session-btn'));
    expect(await screen.findByTestId('new-session-modal')).toBeTruthy();
  });

  /* ------------------------------------------------------------------ UT-15 */
  it('UT-15 (U-01)：正文 text 与 ts 代码块复制在 navigator.clipboard 拒绝时走 bridge.copyText 成功，切 Check 反馈并卸载清理定时器', async () => {
    vi.useFakeTimers();
    const copyTextSpy = vi.fn().mockResolvedValue(undefined);
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      copyText: copyTextSpy,
    };

    const origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')),
      },
    });

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      const mdText = [
        '纯文本命令块：',
        '```text',
        'echo "hello gravity"',
        'line 2 payload',
        '```',
        '',
        'TypeScript 代码块：',
        '```ts',
        'export const version = "0.3.4";',
        '```',
      ].join('\n');

      const view = render(wrap(<Markdown text={mdText} />));
      const blocks = Array.from(view.container.querySelectorAll('.code-block'));
      expect(blocks).toHaveLength(2);

      // 1) 点击 text 代码块复制按钮
      const textCopyBtn = blocks[0].querySelector<HTMLButtonElement>('.code-block-head button')!;
      expect(textCopyBtn).toBeTruthy();
      await act(async () => {
        fireEvent.click(textCopyBtn);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(copyTextSpy).toHaveBeenCalledTimes(1);
      expect(copyTextSpy).toHaveBeenCalledWith('echo "hello gravity"\nline 2 payload');
      expect(textCopyBtn.getAttribute('title') || textCopyBtn.getAttribute('aria-label') || '').toMatch(/已复制|Copied/i);

      // 2) 点击 ts 代码块复制按钮
      const tsCopyBtn = blocks[1].querySelector<HTMLButtonElement>('.code-block-head button')!;
      await act(async () => {
        fireEvent.click(tsCopyBtn);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(copyTextSpy).toHaveBeenCalledTimes(2);
      expect(copyTextSpy).toHaveBeenLastCalledWith('export const version = "0.3.4";');

      // 3) 卸载后必须清理待重置的 copied timer
      const clearsBeforeUnmount = clearTimeoutSpy.mock.calls.length;
      view.unmount();
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearsBeforeUnmount);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
    } finally {
      if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  /* ------------------------------------------------------------------ UT-16 */
  it('UT-16 (U-02)：NewSessionModal 与 WelcomeQuickComposer 支持选择模型（含项目默认模型回显）并透传 bridge.createSession；空模型列表安全降级', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    const models = [
      { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { modelId: 'claude-opus-5.5', name: 'Claude Opus 5.5' },
      { modelId: 'gpt-6.2-astra', name: 'GPT 6.2 Astra' },
    ];
    const projects: WorkspaceProjectConfig[] = [
      {
        id: 'proj-u02',
        name: 'Opus Project',
        path: 'C:\\Workspace\\OpusProject',
        defaultMode: 'accept-edits',
        defaultModelId: 'claude-opus-5.5',
      },
    ];

    const createSessionSpy = vi.fn().mockImplementation(async (input) =>
      makeSession({
        sessionId: 'sess-u02-created-' + createSessionSpy.mock.calls.length,
        cwd: input.cwd,
        title: input.title || 'Created',
        modelId: input.modelId || 'gemini-4-neon',
        executionMode: input.executionMode || 'default',
        reasoningEffort: input.reasoningEffort || 'medium',
      })
    );
    const sendPromptSpy = vi.fn().mockResolvedValue(undefined);

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        preferences: {
          ...baseBoot.preferences,
          defaultWorkspaceCwd: 'C:\\Workspace\\GravityV034',
          projects,
        },
        connection: {
          ...baseBoot.connection,
          connected: true,
          availableModels: models,
          modelListSource: 'live',
        },
        sessions: [],
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: [],
          activePrimarySessionId: null,
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
      }),
      createSession: createSessionSpy,
      sendPrompt: sendPromptSpy,
      getSessionMessagePage: async () => emptyPage([]),
    };

    const view = render(<App />);
    await screen.findByTestId('empty-pane-0');

    // Part A：NewSessionModal 选项目默认模型回显 + 手动切换模型提交
    fireEvent.click(screen.getByTestId('sidebar-new-session-btn'));
    await screen.findByTestId('new-session-modal');

    const modelSelect = screen.getByTestId('new-session-model-select') as HTMLSelectElement;
    expect(modelSelect).toBeTruthy();

    // 点击带 defaultModelId 的项目 chip，模型选择应反映项目默认或保留选项
    fireEvent.click(screen.getByTestId('new-session-project-chip-proj-u02'));
    expect(modelSelect.textContent).toContain('Claude Opus 5.5');

    // 显式选择 gpt-6.2-astra 并提交
    fireEvent.change(modelSelect, { target: { value: 'gpt-6.2-astra' } });
    const effortSelect = screen.queryByTestId('new-session-effort-select') as HTMLSelectElement | null;
    if (effortSelect) {
      fireEvent.change(effortSelect, { target: { value: 'high' } });
    }
    fireEvent.click(screen.getByTestId('confirm-create-session-btn'));

    await waitFor(() => expect(createSessionSpy).toHaveBeenCalledTimes(1));
    expect(createSessionSpy.mock.calls[0][0]).toMatchObject({
      cwd: 'C:\\Workspace\\OpusProject',
      modelId: 'gpt-6.2-astra',
    });
    if (effortSelect) {
      expect(createSessionSpy.mock.calls[0][0].reasoningEffort).toBe('high');
    }
    view.unmount();

    // Part B：WelcomeQuickComposer 快捷选模型并发送首句
    createSessionSpy.mockClear();
    sendPromptSpy.mockClear();
    const view2 = render(<App />);
    await screen.findByTestId('welcome-quick-composer');

    const welcomeModelEl = screen.getByTestId('welcome-model-pill');
    if (welcomeModelEl.tagName === 'SELECT') {
      fireEvent.change(welcomeModelEl, { target: { value: 'claude-opus-5.5' } });
    } else {
      fireEvent.click(welcomeModelEl);
      const option = await screen.findByText(/Claude Opus 5\.5/i);
      fireEvent.click(option);
    }

    fireEvent.change(screen.getByTestId('welcome-quick-composer-input'), {
      target: { value: 'Use Opus for architecture review' },
    });
    fireEvent.click(screen.getByTestId('welcome-quick-send'));

    await waitFor(() => expect(createSessionSpy).toHaveBeenCalledTimes(1));
    expect(createSessionSpy.mock.calls[0][0]).toMatchObject({
      modelId: 'claude-opus-5.5',
    });
    view2.unmount();

    // Part C：availableModels 为空时安全降级不崩溃
    window.gravityDesktop = {
      ...window.gravityDesktop!,
      getBootstrap: async () => ({
        ...baseBoot,
        preferences: { ...baseBoot.preferences, defaultWorkspaceCwd: 'C:\\Workspace\\EmptyModels' },
        connection: { ...baseBoot.connection, availableModels: [], modelListSource: 'unknown' },
        sessions: [],
        layout: { ...baseBoot.layout, openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null },
        pendingApprovals: [],
      }),
    };
    const view3 = render(<App />);
    await screen.findByTestId('welcome-quick-composer');
    fireEvent.click(screen.getByTestId('sidebar-new-session-btn'));
    await screen.findByTestId('new-session-modal');
    const emptySelect = screen.getByTestId('new-session-model-select');
    expect(emptySelect).toBeTruthy();
    view3.unmount();
  });

  /* ------------------------------------------------------------------ UT-17 */
  it('UT-17 (U-04)：主 Context、外部复核与外部翻译的 7d/30d 面板升级（7d 小时标尺+星期日期、30d 去除 .hm-y-scale + Mon–Sun 列头 + 日期数字 + 悬停/聚焦/移出）', () => {
    const dashboard = makeRichTelemetry('sess-u04');

    const views: Array<{
      mode: 'context' | 'reviewer' | 'translator';
      range7dId: string;
      range30dId: string;
      matrix7dId: string;
      cal30dId: string;
    }> = [
      {
        mode: 'context',
        range7dId: 'heatmap-range-7d',
        range30dId: 'heatmap-range-30d',
        matrix7dId: 'heatmap-7d-matrix',
        cal30dId: 'heatmap-30d-calendar',
      },
      {
        mode: 'reviewer',
        range7dId: 'reviewer-heatmap-range-7d',
        range30dId: 'reviewer-heatmap-range-30d',
        matrix7dId: 'reviewer-heatmap-7d-matrix',
        cal30dId: 'reviewer-heatmap-30d-calendar',
      },
      {
        mode: 'translator',
        range7dId: 'translator-heatmap-range-7d',
        range30dId: 'translator-heatmap-range-30d',
        matrix7dId: 'translator-heatmap-7d-matrix',
        cal30dId: 'translator-heatmap-30d-calendar',
      },
    ];

    for (const cfg of views) {
      const view = render(
        wrap(
          <ContextCostInspectorView
            sessionId="sess-u04"
            dashboard={dashboard}
            viewMode={cfg.mode}
            onOpenRateCardsSettings={vi.fn()}
          />,
          'zh-CN'
        )
      );

      // 1) v0.3.5：7d 为 7 根按日柱状图（不再出现小时格）+ 同款左侧 Token 用量 Y 轴刻度 + 星期/日期轴 + 悬停/聚焦/移出复位
      fireEvent.click(screen.getByTestId(cfg.range7dId));
      const m7 = screen.getByTestId(cfg.matrix7dId);
      const cells7 = Array.from(m7.querySelectorAll<HTMLElement>('.heatmap-cell'));
      expect(cells7).toHaveLength(7);
      expect(cells7.every((c) => c.classList.contains('hm-7d-col') && Boolean(c.querySelector('.hm-bar-7d')))).toBe(true);

      const section7 = m7.closest('section')!;
      const yScale7 = section7.querySelector('.hm-y-scale') as HTMLElement;
      expect(yScale7, `U-04 (${cfg.mode} 7d): missing token Y-axis scale`).toBeTruthy();
      expect(yScale7.children).toHaveLength(3);
      const section7Text = section7.textContent || '';
      expect(section7.querySelector('.hm-7d-ruler'), `U-04 (${cfg.mode} 7d): hour ruler must be gone`).toBeNull();
      expect(section7Text, `U-04 (${cfg.mode} 7d): missing weekday labels on 7d axis`).toMatch(/[一二三四五六日]|Mon|Tue|Wed|Thu|Fri|Sat|Sun/);

      // 悬停非零格 -> 显示详情；移出 -> 复位
      const activeCell7 = cells7.find((c) => c.className.includes('i-4')) ?? cells7[0];
      fireEvent.mouseEnter(activeCell7);
      const hoverEl7 = section7.querySelector('.hm-hover') as HTMLElement;
      expect(hoverEl7?.textContent?.trim().length).toBeGreaterThan(0);

      fireEvent.mouseLeave(m7);
      fireEvent.mouseLeave(activeCell7);
      expect(hoverEl7?.textContent?.trim()).toBe('');

      // 键盘聚焦同样触发详情展示
      fireEvent.focus(activeCell7);
      expect(hoverEl7?.textContent?.trim().length).toBeGreaterThan(0);

      // 2) 30d 日历：30 个 .heatmap-cell + 无 .hm-y-scale 误导纵轴 + Mon-Sun 列头 + 格内日期数字
      fireEvent.click(screen.getByTestId(cfg.range30dId));
      const cal30 = screen.getByTestId(cfg.cal30dId);
      const section30 = cal30.closest('section')!;
      expect(section30.querySelector('.hm-y-scale'), `U-04 (${cfg.mode} 30d): misleading .hm-y-scale must be removed`).toBeNull();

      const cells30 = Array.from(cal30.querySelectorAll<HTMLElement>('.heatmap-cell'));
      expect(cells30).toHaveLength(30);

      const section30Text = section30.textContent || '';
      expect(section30Text, `U-04 (${cfg.mode} 30d): missing Mon-Sun weekday headers`).toMatch(/(?:Mon|一)[\s\S]*(?:Sun|日)/);

      // 每个 30d 格子内必须展示日期数字（例如 28..31, 1..26）
      const cellsWithDayNum = cells30.filter((c) => /\b(?:[1-9]|[12]\d|3[01])\b/.test(c.textContent || ''));
      expect(cellsWithDayNum.length, `U-04 (${cfg.mode} 30d): calendar cells must render day numbers`).toBe(30);

      // 30d 悬停与移出复位
      const activeCell30 = cells30.find((c) => c.className.includes('i-4')) ?? cells30[0];
      fireEvent.mouseEnter(activeCell30);
      const hoverEl30 = section30.querySelector('.hm-hover') as HTMLElement;
      expect(hoverEl30?.textContent?.trim().length).toBeGreaterThan(0);
      fireEvent.mouseLeave(cal30);
      fireEvent.mouseLeave(activeCell30);
      expect(hoverEl30?.textContent?.trim()).toBe('');

      view.unmount();
    }
  });

  /* ------------------------------------------------------------------ UT-18 */
  it('UT-18 (D4 密钥投影 UI + APR-01 activeReviews 首屏水合)：hasApiKey 零明文回显、留空保原/显式清除/换源重填；Bootstrap activeReviews 首屏渲染并支持接管', async () => {
    // 1) D4：ApprovalsPanel 外部复核仅接收 hasApiKey: true（无明文 apiKey）
    const onUpdateApproval = vi.fn().mockResolvedValue(undefined);
    const projectedCfg = makeApprovalConfig({
      mode: 'hybrid',
      externalReviewer: {
        enabled: true,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        hasApiKey: true,
        timeoutMs: 8000,
        maxOutputTokens: 4096,
        thinkingLevel: 'auto',
        connectionStatus: 'connected',
        verificationMethod: 'review-call',
        lastVerifiedAt: '2026-11-26T10:00:00.000Z',
      },
    });

    const revView = render(
      wrap(
        <ApprovalsPanel
          config={projectedCfg}
          auditEntries={[]}
          initialTab="reviewer"
          onUpdateConfig={onUpdateApproval}
        />
      )
    );

    const keyInput = screen.getByTestId('reviewer-apikey-input') as HTMLInputElement;
    // DOM 中绝无明文 Key 回显
    expect(keyInput.value).toBe('');
    // 应显示「已保存密钥」状态并允许直接测试连接（无需重填）
    expect(revView.container.textContent).toMatch(/已保存|Saved key|Key saved/i);
    expect((screen.getByTestId('test-reviewer-connection-btn') as HTMLButtonElement).disabled).toBe(false);

    // 留空直接点击保存 -> payload.externalReviewer 必须省略 apiKey（undefined，代表保留原 Key）
    fireEvent.click(screen.getByTestId('save-reviewer-config-btn'));
    await waitFor(() => expect(onUpdateApproval).toHaveBeenCalledTimes(1));
    expect(onUpdateApproval.mock.calls[0][0].externalReviewer?.apiKey).toBeUndefined();

    // 换源（修改 endpoint 到不同 origin）-> 已保存 Key 失效，需重填
    const endpointInput = revView.container.querySelector<HTMLInputElement>('input[type="text"]')!;
    fireEvent.change(endpointInput, { target: { value: 'https://api.other-provider.example' } });
    expect((screen.getByTestId('test-reviewer-connection-btn') as HTMLButtonElement).disabled).toBe(true);

    revView.unmount();

    // 清除密钥：重新渲染已保存 Key 状态，点击显式清除按钮并保存 -> 发送 apiKey: ''
    onUpdateApproval.mockClear();
    const revClearView = render(
      wrap(
        <ApprovalsPanel
          config={projectedCfg}
          auditEntries={[]}
          initialTab="reviewer"
          onUpdateConfig={onUpdateApproval}
        />
      )
    );
    const clearKeyBtn = screen.getByRole('button', { name: /清除密钥|移除密钥|Clear key|Remove key/i });
    fireEvent.click(clearKeyBtn);
    fireEvent.click(screen.getByTestId('save-reviewer-config-btn'));
    await waitFor(() => expect(onUpdateApproval).toHaveBeenCalledTimes(1));
    expect(onUpdateApproval.mock.calls[0][0].externalReviewer?.apiKey).toBe('');
    revClearView.unmount();

    // 2) D4：SettingsView General 外部翻译仅接收 hasApiKey: true（无明文 apiKey）
    const { props: settingsBase } = await makeSettingsProps();
    const onUpdateTrans = vi.fn().mockImplementation(async (patch) => ({
      ...DEFAULT_TRANSLATION_CONFIG,
      ...patch,
      externalTranslator: { ...DEFAULT_TRANSLATION_CONFIG.externalTranslator, ...patch.externalTranslator },
    }));
    const projectedTrans: TranslationConfig = {
      engine: 'external-api',
      externalTranslator: {
        enabled: true,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        hasApiKey: true,
        timeoutMs: 8000,
        maxOutputTokens: 2048,
        thinkingLevel: 'off',
        connectionStatus: 'connected',
        verifiedBy: 'translation-call',
        lastVerifiedAt: '2026-11-26T10:00:00.000Z',
      },
    };
    const transView = render(
      wrap(
        <SettingsView
          {...settingsBase}
          section="general"
          translationConfig={projectedTrans}
          onUpdateTranslationConfig={onUpdateTrans}
        />
      )
    );
    const transKeyInput = screen.getByTestId('translator-apikey-input') as HTMLInputElement;
    expect(transKeyInput.value).toBe('');
    expect(screen.getByTestId('external-translator-form').textContent).toMatch(/已保存|Saved key|Key saved/i);
    fireEvent.click(screen.getByTestId('save-translator-config-btn'));
    await waitFor(() => expect(onUpdateTrans).toHaveBeenCalledTimes(1));
    expect(onUpdateTrans.mock.calls[0][0].externalTranslator?.apiKey).toBeUndefined();
    transView.unmount();

    // 3) APR-01：Bootstrap 携带 activeReviews 时首屏直接水合渲染 GuardianReviewingCard 并支持接管
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    const reviewSess = makeSession({ sessionId: 'sess-apr01', status: 'waiting_approval' });
    const activeReview: ApprovalReviewingEvent = {
      requestId: 'req-apr01-hydrate',
      sessionId: reviewSess.sessionId,
      toolCallId: 'tc-apr01',
      toolName: 'run_command',
      commandPreview: 'npm run release:check',
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      status: 'reviewing',
      startedAt: '2026-11-26T12:00:00.000Z',
    };
    const cancelStage2Spy = vi.fn().mockResolvedValue({ cancelled: true });

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        sessions: [reviewSess],
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: [reviewSess.sessionId],
          activePrimarySessionId: reviewSess.sessionId,
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
        activeReviews: [activeReview],
      }),
      getSessionMessagePage: async () => emptyPage([]),
      cancelStage2ApprovalReview: cancelStage2Spy,
    };

    render(<App />);
    const reviewCard = await screen.findByTestId('approval-reviewing-card-req-apr01-hydrate');
    expect(reviewCard.textContent).toContain('npm run release:check');

    fireEvent.click(screen.getByTestId('btn-cancel-stage2-req-apr01-hydrate'));
    await waitFor(() => expect(cancelStage2Spy).toHaveBeenCalledWith('req-apr01-hydrate'));
    await waitFor(() => expect(screen.queryByTestId('approval-reviewing-card-req-apr01-hydrate')).toBeNull());
  });
});
