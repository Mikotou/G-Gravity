import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiagnosticBanner,
  DEFAULT_TRANSLATION_CONFIG,
  isToolCallFailure,
  type AccountQuota,
  type ApprovalAuditEntry,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientLocale,
  type GravityDesktopBridge,
  type ManagedSessionSummary,
  type PendingApprovalRequest,
  type SemanticToolCallCard,
  type SwarmTopologyState,
  type TelemetryDashboardSnapshot,
  type TranslationConfig,
} from '@shared';
import { App } from '../src/renderer/App';
import { AccountQuotaFooter } from '../src/renderer/components/AccountQuotaView';
import { Composer } from '../src/renderer/components/Composer';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { MediaGallery, type MediaPreviewItem } from '../src/renderer/components/MediaGallery';
import { ImageWorkspace, MessageImage } from '../src/renderer/components/MessageImage';
import { NewSessionModal } from '../src/renderer/components/NewSessionModal';
import { SessionPane, type SessionPaneProps } from '../src/renderer/components/SessionPane';
import { SettingsView } from '../src/renderer/components/SettingsView';
import { SwarmPanel } from '../src/renderer/components/SwarmPanel';
import { TitleOrganizerModal } from '../src/renderer/components/TitleOrganizerModal';
import { ToolActivityStream } from '../src/renderer/components/TurnActivity';
import { TurnDiagnosticCard } from '../src/renderer/components/TurnDiagnosticCard';
import { ApprovalsPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

const REPO_ROOT = path.resolve(__dirname, '..');

beforeEach(() => {
  delete window.gravityDesktop;
  document.body.className = '';
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

function wrap(child: React.ReactNode, locale: ClientLocale = 'zh-CN') {
  return (
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      {child}
    </I18nProvider>
  );
}

function makeSession(overrides: Partial<ManagedSessionSummary> = {}): ManagedSessionSummary {
  return {
    sessionId: 'sess-v032-1',
    cwd: 'C:\\Workspace\\DemoApp',
    rawCwd: 'C:\\Workspace\\DemoApp',
    title: 'v0.3.2 回归会话',
    pinned: false,
    isLegacyApprovalPollution: false,
    status: 'idle',
    modelId: 'gemini-4-neon',
    executionMode: 'default',
    reasoningEffort: 'medium',
    originKind: 'acp-live',
    readOnly: false,
    profileId: 'default',
    updatedAt: '2026-11-25T12:00:00.000Z',
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
    alignedHighRiskMaxScore: 80,
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

function makeEmptyTelemetry(overrides: Partial<TelemetryDashboardSnapshot> = {}): TelemetryDashboardSnapshot {
  const zero = {
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
  return {
    activeSessions: {},
    hourly24h: [],
    matrix7d: [],
    calendar30d: [],
    costByRange: { today: zero, '7d': zero, '30d': zero },
    modelBreakdownByRange: { today: [], '7d': [], '30d': [] },
    sessionModelBreakdowns: {},
    rateCards: [],
    pricingSource: 'reference-api-estimate',
    generatedAt: '2026-11-25T12:00:00.000Z',
    ...overrides,
  };
}

function makeSessionPaneProps(
  overrides: Partial<SessionPaneProps> = {}
): SessionPaneProps {
  const session = overrides.session !== undefined ? overrides.session : makeSession();
  return {
    slotIndex: 0,
    layoutMode: 'single',
    isFocused: true,
    session,
    availableSessions: session ? [session] : [],
    availableModels: [],
    messages: [],
    pendingApprovals: [],
    approvalConfig: makeApprovalConfig(),
    defaultThoughtTrack: 'zh',
    telemetryDashboard: makeEmptyTelemetry(),
    scrollMemoryRef: { current: {} as Record<string, number> },
    canTriggerDemoApproval: false,
    appIcon: 'gravity-claude-dark',
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

async function makeSettingsBaseProps() {
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

describe('v0.3.2 前端与自研插件 UI Bug 全量回归 (FE-01 ~ FE-15, Turbo, 静默停止)', () => {
  it('FE-01 (SettingsView)：外部翻译连接测试通过后顶部状态徽章立即显示已连接（无需先勾选启用）', async () => {
    const { fallback, props } = await makeSettingsBaseProps();
    const testSpy = vi.fn().mockResolvedValue({
      ok: true,
      latencyMs: 76,
      sampleTranslation: '模型连接验证成功',
      verifiedAt: '2026-11-25T12:00:00.000Z',
    });
    window.gravityDesktop = {
      ...fallback,
      testExternalTranslatorConnection: testSpy,
    };

    const config: TranslationConfig = {
      engine: 'local',
      externalTranslator: {
        ...DEFAULT_TRANSLATION_CONFIG.externalTranslator,
        enabled: false,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: 'sk-v032-valid-translator-key-1234',
        connectionStatus: 'untested',
      },
    };

    render(
      wrap(
        <SettingsView
          {...props}
          section="general"
          translationConfig={config}
          focusExternalTranslatorSeq={1}
        />
      )
    );

    const badgeBefore = screen.getByTestId('translator-connection-badge');
    expect(badgeBefore.textContent).toContain('未连接');

    fireEvent.click(screen.getByTestId('test-translator-connection-btn'));
    await waitFor(() => expect(testSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('translator-test-result').textContent).toContain('测试通过'));

    // 未勾选启用开关之前，顶部状态徽章也必须立即反映已连通，而不是停留在「未连接」
    const badgeAfter = screen.getByTestId('translator-connection-badge');
    expect(badgeAfter.textContent).toContain('已连接');
    expect(badgeAfter.textContent).not.toContain('未连接');
    expect(badgeAfter.className).toContain('badge-success');
  });

  it('FE-02 (MessageImage)：灯箱中打开所在文件夹失败提示渲染在 <dialog> 内，且关闭灯箱后清空旧错误', async () => {
    const proto = HTMLDialogElement.prototype;
    const origShowModalDesc = Object.getOwnPropertyDescriptor(proto, 'showModal');
    const origCloseDesc = Object.getOwnPropertyDescriptor(proto, 'close');
    Object.defineProperty(proto, 'showModal', {
      configurable: true,
      writable: true,
      value: function showModalStub(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(proto, 'close', {
      configurable: true,
      writable: true,
      value: function closeStub(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });

    try {
      const openSpy = vi.fn().mockRejectedValue(new Error('Target file was moved'));
      window.gravityDesktop = {
        ...getFallbackDesktopBridge(),
        openLinkOrFileTarget: openSpy,
      };

      render(
        wrap(
          <ImageWorkspace.Provider value="C:\\Workspace\\DemoApp">
            <MessageImage
              source="C:\\Workspace\\DemoApp\\preview.png"
              displayUrl="data:image/png;base64,iVBORw0KGgo="
              alt="Preview Shot"
            />
          </ImageWorkspace.Provider>
        )
      );

      // 打开大图灯箱
      fireEvent.click(screen.getByRole('button', { name: 'Preview Shot' }));
      const dialog = document.querySelector<HTMLDialogElement>('dialog.image-lightbox');
      expect(dialog).toBeTruthy();
      expect(dialog!.hasAttribute('open')).toBe(true);

      // 点击「在文件夹中显示」触发失败
      fireEvent.click(within(dialog!).getByTestId('lightbox-reveal-btn'));
      await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

      // 失败提示必须渲染在 <dialog> 内部（不被 Top-Layer 遮罩挡在后面），且外部无残留 alert
      const alertInDialog = await within(dialog!).findByRole('alert');
      expect(alertInDialog.textContent).toContain('Target file was moved');
      const allAlerts = screen.getAllByRole('alert');
      expect(allAlerts.every((el) => dialog!.contains(el))).toBe(true);

      // 关闭灯箱后错误立即清空；再次打开灯箱不残留旧错误
      const closeBtn = dialog!.querySelector<HTMLButtonElement>('.image-lightbox-close')
        ?? within(dialog!).getByRole('button', { name: /关闭|Close/i });
      fireEvent.click(closeBtn);
      await waitFor(() => expect(document.querySelector('dialog.image-lightbox')).toBeNull());
      expect(screen.queryByRole('alert')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Preview Shot' }));
      const reopened = document.querySelector<HTMLDialogElement>('dialog.image-lightbox');
      expect(reopened).toBeTruthy();
      expect(within(reopened!).queryByRole('alert')).toBeNull();
    } finally {
      if (origShowModalDesc) Object.defineProperty(proto, 'showModal', origShowModalDesc);
      else delete (proto as Partial<HTMLDialogElement>).showModal;
      if (origCloseDesc) Object.defineProperty(proto, 'close', origCloseDesc);
      else delete (proto as Partial<HTMLDialogElement>).close;
    }
  });

  it('FE-03 (AccountQuotaView)：固定额度浮层点击“刷新”后浮层不因按钮禁用失焦而关闭，且防止重复并发刷新', async () => {
    const profileId = `quota-fe03-${Date.now()}`;
    const quotaSnapshot: AccountQuota = {
      profileId,
      plan: 'Pro',
      checkedAt: '2026-11-25T12:00:00.000Z',
      buckets: [
        { id: 'gemini-weekly', remainingFraction: 0.78, resetAt: '2026-12-01T00:00:00.000Z' },
        { id: 'gemini-5h', remainingFraction: 0.92, resetAt: '2026-11-25T17:00:00.000Z' },
      ],
    };

    let resolveSecond!: (value: AccountQuota) => void;
    const getAccountQuota = vi
      .fn()
      .mockResolvedValueOnce(quotaSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise<AccountQuota>((resolve) => {
            resolveSecond = resolve;
          })
      );

    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getAccountQuota,
    };

    render(wrap(<AccountQuotaFooter profileId={profileId} />));

    // 点击固定浮层并等待首次读取完成
    fireEvent.click(screen.getByTestId('quota-weekly'));
    const details = await screen.findByTestId('quota-details');
    await waitFor(() => expect(getAccountQuota).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(details).getAllByTestId('quota-bucket').length).toBeGreaterThan(0));

    const refreshBtn = within(details).getByRole('button', { name: /刷新|Refresh/i }) as HTMLButtonElement;
    refreshBtn.focus();
    expect(document.activeElement).toBe(refreshBtn);

    // 点击刷新进入 loading 状态
    fireEvent.click(refreshBtn);
    await waitFor(() => expect(getAccountQuota).toHaveBeenCalledTimes(2));

    // 精确复现 Chromium 行为：若按钮仍持有焦点且被原生 disabled=true，浏览器立即向容器派发 relatedTarget=null 的 blur
    if (refreshBtn.disabled && document.activeElement === refreshBtn) {
      fireEvent.blur(refreshBtn, { relatedTarget: null });
    }

    // 浮层必须保持打开
    expect(screen.getByTestId('quota-details')).toBeTruthy();

    // loading 期间再次点击刷新不应触发第 3 次请求
    fireEvent.click(refreshBtn);
    expect(getAccountQuota).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond(quotaSnapshot);
      await Promise.resolve();
    });
    expect(screen.getByTestId('quota-details')).toBeTruthy();
  });

  it('FE-04 (App.tsx)：Shift+Tab 在外部复核状态变更后不读过期闭包，且绝不盲切进入 full-access (Turbo)', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();

    // 场景 A：存在聚焦活跃会话且当前为 plan 模式 -> Shift+Tab 仅在安全三档循环（回 default），绝不盲切 full-access
    const setSessionModeSpy = vi.fn().mockImplementation(async (sessionId: string, mode: ManagedSessionSummary['executionMode']) =>
      makeSession({ sessionId, executionMode: mode })
    );
    const planSession = makeSession({ sessionId: 'sess-plan', executionMode: 'plan' });

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        sessions: [planSession],
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: ['sess-plan'],
          activePrimarySessionId: 'sess-plan',
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
      }),
      getSessionMessagePage: async () => ({
        earlierCount: 0,
        earlierUserCount: 0,
        earlierVisibleCount: 0,
        precedingOriginId: null,
        messages: [],
      }),
      setSessionMode: setSessionModeSpy,
    };

    const viewA = render(<App />);
    await screen.findByTestId('composer-input-sess-plan');

    // 将焦点放在非交互画布上按 Shift+Tab（F-01：避免聚焦按钮时阻断反向 Tab 焦点导航）
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });

    await waitFor(() => expect(setSessionModeSpy).toHaveBeenCalledTimes(1));
    expect(setSessionModeSpy).toHaveBeenCalledWith('sess-plan', 'default');
    expect(setSessionModeSpy).not.toHaveBeenCalledWith('sess-plan', 'full-access');
    viewA.unmount();

    // 场景 B：无活跃会话时，APPROVAL_MODE_ORDER 为 ['hybrid', 'rules-only', 'manual']；
    // 从 mode='manual' 起步，外部复核由“未连接”变为“已连接”（含合法 apiKey）后按 Shift+Tab -> 立即识别可切入 hybrid
    let approvalListener: ((cfg: ApproveForMeConfig) => void) | undefined;
    const connectedExternalReviewer = {
      enabled: true,
      provider: 'openai-compatible' as const,
      endpoint: 'https://api.openai.com',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-valid',
      timeoutMs: 8000,
      maxOutputTokens: 4096,
      thinkingLevel: 'auto' as const,
      connectionStatus: 'connected' as const,
      verificationMethod: 'review-call' as const,
      lastVerifiedAt: '2026-11-25T12:00:00.000Z',
    };
    const setApprovalModeSpy = vi.fn().mockImplementation(async (mode: ApproveForMeConfig['mode']) =>
      makeApprovalConfig({
        mode,
        externalReviewer: connectedExternalReviewer,
      })
    );

    const disconnectedConfig = makeApprovalConfig({
      mode: 'manual',
      externalReviewer: {
        enabled: false,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test-valid',
        timeoutMs: 8000,
        maxOutputTokens: 4096,
        thinkingLevel: 'auto',
        connectionStatus: 'untested',
      },
    });

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        sessions: [],
        approvalConfig: disconnectedConfig,
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: [],
          activePrimarySessionId: null,
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
      }),
      onApprovalConfigUpdated: (listener) => {
        approvalListener = listener;
        return () => {
          approvalListener = undefined;
        };
      },
      setApprovalMode: setApprovalModeSpy,
    };

    render(<App />);
    await waitFor(() => expect(approvalListener).toBeTypeOf('function'));
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    // 推送外部复核已连接更新（mode 保持 manual 不变）
    act(() => {
      approvalListener!(
        makeApprovalConfig({
          mode: 'manual',
          externalReviewer: connectedExternalReviewer,
        })
      );
    });

    // F-01: 确保焦点不在交互按钮上再触发全局 Shift+Tab
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(setApprovalModeSpy).toHaveBeenCalledWith('hybrid'));

    // 源码级守卫：全局快捷键 useEffect 依赖数组显式包含 approvalConfig.externalReviewer（或完整 approvalConfig）
    const appSource = fs.readFileSync(path.join(REPO_ROOT, 'src/renderer/App.tsx'), 'utf8');
    const shiftTabBlock = appSource.slice(
      appSource.indexOf("e.shiftKey && e.key === 'Tab'"),
      appSource.indexOf('const recentCwds = useMemo')
    );
    expect(shiftTabBlock).toMatch(/approvalConfig\.externalReviewer|(?<![.\w])approvalConfig(?=[,\s\]])/);
  });

  it('FE-05 (WorkspacePanels / ApprovalsPanel)：启用外部复核时保留 cacheTtlHours 与 v0.3.2 高风险策略配置', async () => {
    const testSpy = vi.fn().mockResolvedValue({
      ok: true,
      latencyMs: 120,
      message: 'Review test passed',
      verifiedAt: '2026-11-25T12:00:00.000Z',
    });
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      testExternalReviewerConnection: testSpy,
    };

    const onUpdateConfig = vi.fn().mockResolvedValue(undefined);
    const initialConfig = makeApprovalConfig({
      mode: 'rules-only',
      cacheTtlHours: 24,
      allowAlignedHighRiskPass: false,
      alignedHighRiskMaxScore: 72,
      fastPassLowRiskDev: false,
      externalReviewer: {
        enabled: false,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: 'sk-v032-reviewer-key-1234567890',
        timeoutMs: 8000,
        maxOutputTokens: 4096,
        thinkingLevel: 'auto',
        connectionStatus: 'untested',
      },
    });

    render(
      wrap(
        <ApprovalsPanel
          config={initialConfig}
          auditEntries={[]}
          initialTab="reviewer"
          onUpdateConfig={onUpdateConfig}
        />
      )
    );

    // 1) 在复核页修改 cacheTtlHours 为 72，随后走“启用 -> 测试并启用”路径
    const ttlInput = screen.getByTestId('approval-cache-ttl-input') as HTMLInputElement;
    fireEvent.change(ttlInput, { target: { value: '72' } });
    expect(ttlInput.value).toBe('72');

    // 打开启用开关，拉出「测试并启用」按钮并点击
    const enableSwitch = document.getElementById('reviewer-enable-action') as HTMLInputElement;
    expect(enableSwitch).toBeTruthy();
    fireEvent.click(enableSwitch);

    const testAndEnableBtn = await screen.findByTestId('reviewer-test-and-enable');
    fireEvent.click(testAndEnableBtn);

    await waitFor(() => expect(testSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onUpdateConfig).toHaveBeenCalledTimes(1));

    const patch = onUpdateConfig.mock.calls[0][0] as Partial<ApproveForMeConfig>;
    // 关键回归断言：启用路径不得静默丢弃用户刚修改的 cacheTtlHours
    expect(patch.cacheTtlHours).toBe(72);

    // 关键回归断言：启用路径保留 v0.3.2 策略字段（绝不丢失或被默认值覆写）
    const merged: ApproveForMeConfig = { ...initialConfig, ...patch };
    expect(merged.allowAlignedHighRiskPass).toBe(false);
    expect(merged.alignedHighRiskMaxScore).toBe(72);
    expect(merged.fastPassLowRiskDev).toBe(false);

    // 契约级验证：WorkspacePanels 源码确实已接入 v0.3.2 三项策略配置字段
    const panelsSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/settings/WorkspacePanels.tsx'),
      'utf8'
    );
    expect(panelsSource).toContain('allowAlignedHighRiskPass');
    expect(panelsSource).toContain('alignedHighRiskMaxScore');
    expect(panelsSource).toContain('fastPassLowRiskDev');
  });

  it('FE-06 (MediaGallery)：图片 URL 变更时重置 broken 状态，且未解析卡片不泄露 entries[0] 格式徽标', () => {
    const validSvg: MediaPreviewItem = {
      key: 'img-svg-0',
      source: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      displayUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      label: 'diagram.svg',
      kind: 'image',
    };
    const brokenThenFixed: MediaPreviewItem = {
      key: 'img-changing-1',
      source: 'data:image/png;base64,BAD_URL_FIRST',
      displayUrl: 'data:image/png;base64,BAD_URL_FIRST',
      label: 'shot.png',
      kind: 'image',
    };
    const unresolvedNoExt: MediaPreviewItem = {
      key: 'img-unresolved-2',
      source: 'relative-unresolved-artifact',
      label: 'Mystery Preview',
      kind: 'image',
    };

    const view = render(
      wrap(
        <ImageWorkspace.Provider value="">
          <MediaGallery items={[validSvg, brokenThenFixed, unresolvedNoExt]} />
        </ImageWorkspace.Provider>
      )
    );

    const cards = screen.getAllByTestId('md-media-card');
    expect(cards).toHaveLength(3);

    // 1) 未解析条目（entryIndex === -1）绝不能回退复用 entries[0] 的 'SVG' 格式徽标
    expect(cards[0].getAttribute('data-media-format')).toBe('SVG');
    expect(cards[2].getAttribute('data-media-format')).not.toBe('SVG');
    expect(cards[2].querySelector('.md-media-format')?.textContent ?? '').not.toBe('SVG');

    // 2) 触发第 2 张卡片图片加载失败 -> 获得 is-broken
    const secondImg = cards[1].querySelector('img.md-img');
    expect(secondImg).toBeTruthy();
    fireEvent.error(secondImg!);
    expect(cards[1].className).toContain('is-broken');

    // 更新为新 URL（保持相同 key）后，broken 状态必须自动重置
    const refreshed: MediaPreviewItem = {
      ...brokenThenFixed,
      source: 'data:image/png;base64,GOOD_URL_SECOND',
      displayUrl: 'data:image/png;base64,GOOD_URL_SECOND',
    };
    view.rerender(
      wrap(
        <ImageWorkspace.Provider value="">
          <MediaGallery items={[validSvg, refreshed, unresolvedNoExt]} />
        </ImageWorkspace.Provider>
      )
    );

    const updatedCards = screen.getAllByTestId('md-media-card');
    expect(updatedCards[1].className).not.toContain('is-broken');
  });

  it('FE-07 (TurnDiagnosticCard)：已挂载卡片收到新的 cooldownUntil 时首秒倒计时立即准确（不被旧 now 拖大）', () => {
    vi.useFakeTimers();
    const t0 = Date.parse('2026-11-25T12:00:00.000Z');
    vi.setSystemTime(t0);

    // 初次挂载无冷却时间（useCooldownSeconds 记录了 t0）
    const initialBanner = buildDiagnosticBanner('rate_limited_429');
    const view = render(
      wrap(
        <TurnDiagnosticCard
          banner={initialBanner}
          handlers={{ retry_turn: vi.fn() }}
        />
      )
    );

    // 静默经过 45 秒（期间 interval 未运行，旧版 now 仍停在 t0）
    act(() => {
      vi.advanceTimersByTime(45_000);
    });

    // 此时收到一条距离当前时刻恰好 60 秒的新 cooldownUntil
    const newCooldownUntil = new Date(t0 + 45_000 + 60_000).toISOString();
    const updatedBanner = buildDiagnosticBanner('rate_limited_429', {
      cooldownUntil: newCooldownUntil,
    });

    view.rerender(
      wrap(
        <TurnDiagnosticCard
          banner={updatedBanner}
          handlers={{ retry_turn: vi.fn() }}
        />
      )
    );

    // 首秒（未推进 interval 前）必须立刻显示约 60 秒，而不是被旧 now 拖大成 105 秒
    const timerText = screen.getByTestId('diagnostic-cooldown-timer').textContent || '';
    const secMatch = timerText.match(/(\d+)\s*(?:秒|s\b)/i);
    expect(secMatch, `Expected seconds in cooldown timer text: "${timerText}"`).toBeTruthy();
    const displayedSec = Number(secMatch![1]);
    expect(displayedSec).toBeGreaterThanOrEqual(59);
    expect(displayedSec).toBeLessThanOrEqual(61);
  });

  it('FE-08 (TitleOrganizerModal)：重开时清空上次报错，且整理运行中禁用底部关闭按钮', async () => {
    const onClose = vi.fn();
    let resolvePending!: () => void;
    const onRunOrganize = vi
      .fn()
      .mockRejectedValueOnce(new Error('Organizer rate limit exceeded'))
      .mockImplementationOnce(() => new Promise<void>((r) => { resolvePending = r; }));

    const result = { updatedCount: 1, hiddenPollutionCount: 0, suggestions: [] };

    const view = render(
      wrap(
        <TitleOrganizerModal
          open={true}
          result={result}
          onClose={onClose}
          onRunOrganize={onRunOrganize}
        />
      )
    );

    // 1) 首次触发报错
    fireEvent.click(screen.getByRole('button', { name: /重新整理|Re-organize/i }));
    const errAlert = await screen.findByRole('alert');
    expect(errAlert.textContent).toContain('Organizer rate limit exceeded');

    // 关闭再重开（组件保持挂载）-> 旧错误必须清空
    view.rerender(
      wrap(
        <TitleOrganizerModal
          open={false}
          result={result}
          onClose={onClose}
          onRunOrganize={onRunOrganize}
        />
      )
    );
    view.rerender(
      wrap(
        <TitleOrganizerModal
          open={true}
          result={result}
          onClose={onClose}
          onRunOrganize={onRunOrganize}
        />
      )
    );
    expect(screen.queryByRole('alert')).toBeNull();

    // 2) 再次运行并挂起 -> 右上角 X 与底部关闭按钮必须全部禁用，点击不得触发 onClose
    fireEvent.click(screen.getByRole('button', { name: /重新整理|Re-organize/i }));
    expect(onRunOrganize).toHaveBeenCalledTimes(2);

    const closeButtons = screen.getAllByRole('button', { name: /关闭|Close/i }) as HTMLButtonElement[];
    expect(closeButtons.length).toBeGreaterThanOrEqual(2);
    for (const btn of closeButtons) {
      expect(btn.disabled).toBe(true);
      fireEvent.click(btn);
    }
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolvePending();
      await Promise.resolve();
    });
  });

  it('FE-09 (NewSessionModal)：会话创建中锁定遮罩、右上角 X 与底部取消关闭出口', async () => {
    const onClose = vi.fn();
    let resolveCreate!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((r) => { resolveCreate = r; }));

    render(
      wrap(
        <NewSessionModal
          open={true}
          defaultCwd="C:\\Workspace\\DemoApp"
          onClose={onClose}
          onCreate={onCreate}
          onOpenProjectsSettings={vi.fn()}
        />
      )
    );

    // 提交创建，进入 creating === true
    fireEvent.click(screen.getByTestId('confirm-create-session-btn'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    // 创建中点击遮罩、右上角 X、取消按钮以及按 Esc 均不得关闭弹窗
    fireEvent.mouseDown(screen.getByTestId('new-session-backdrop'));
    const xBtn = screen.getByRole('button', { name: /关闭|Close/i }) as HTMLButtonElement;
    const cancelBtn = screen.getByRole('button', { name: /取消|Cancel/i }) as HTMLButtonElement;
    expect(xBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);
    fireEvent.click(xBtn);
    fireEvent.click(cancelBtn);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();

    // 创建完成后正常关闭
    await act(async () => {
      resolveCreate();
      await Promise.resolve();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('FE-10 (WorkspacePanels 审计 & SwarmPanel)：使用本地时区格式化时间而非原始 UTC 截取', () => {
    const isoTs = '2026-11-25T00:05:09.000Z';
    const localDate = new Date(isoTs);
    const localHour = localDate.getHours();
    const localMin = String(localDate.getMinutes()).padStart(2, '0');
    const localHmRe = new RegExp(`(?:0?${localHour}):${localMin}`);
    const isNonUtc = localDate.getTimezoneOffset() !== 0;

    // 1) ApprovalsPanel 审计日志
    const auditEntries: ApprovalAuditEntry[] = [
      {
        id: 'aud-tz-1',
        sessionId: 'sess-1',
        cwd: 'C:\\Workspace\\DemoApp',
        toolName: 'run_command',
        commandOrSummary: 'npm test',
        modeAtDecision: 'rules-only',
        verdict: 'auto_approved',
        decisionSource: 'local-rule',
        riskLevel: 'low',
        latencyMs: 12,
        reason: 'Safe workspace test command',
        timestamp: isoTs,
      },
    ];
    const auditView = render(
      wrap(
        <ApprovalsPanel
          config={makeApprovalConfig()}
          auditEntries={auditEntries}
          initialTab="audit"
          onUpdateConfig={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );
    const auditRow = screen.getByTestId('audit-row-aud-tz-1');
    expect(auditRow.textContent).toMatch(localHmRe);
    if (isNonUtc) {
      expect(auditRow.textContent).not.toContain('00:05');
    }
    auditView.unmount();

    // 2) SwarmPanel 时间线 + 折叠的相似公告与相似事件
    const topology: SwarmTopologyState = {
      sessionId: 'sess-swarm-tz',
      isActive: true,
      swarmTitle: 'TZ Verification Swarm',
      channels: ['main'],
      workers: [],
      boardMessages: [
        {
          seq: 1,
          channel: 'main',
          sender: 'worker-1',
          mentions: ['coordinator'],
          content: 'Running regression checks for v0.3.2 frontend suite',
          timestamp: isoTs,
          isDoneReport: false,
          isStallAlert: false,
        },
        {
          seq: 2,
          channel: 'main',
          sender: 'worker-1',
          mentions: ['coordinator'],
          content: 'Running regression checks for v0.3.2 frontend suite',
          timestamp: isoTs,
          isDoneReport: false,
          isStallAlert: false,
        },
      ],
      actionTimeline: [
        {
          id: 'evt-1',
          sessionId: 'sess-swarm-tz',
          eventType: 'board_posted',
          actorName: 'worker-1',
          targetName: 'coordinator',
          summaryZh: '执行 v0.3.2 前端回归验证',
          summaryEn: 'Running v0.3.2 frontend regression check',
          timestamp: isoTs,
        },
        {
          id: 'evt-2',
          sessionId: 'sess-swarm-tz',
          eventType: 'board_posted',
          actorName: 'worker-1',
          targetName: 'coordinator',
          summaryZh: '执行 v0.3.2 前端回归验证',
          summaryEn: 'Running v0.3.2 frontend regression check',
          timestamp: isoTs,
        },
      ],
      stats: { total: 0, working: 0, waiting: 0, completed: 0, killed: 0 },
      updatedAt: isoTs,
    };

    const swarmView = render(wrap(<SwarmPanel sessionId="sess-swarm-tz" topology={topology} />));

    // 展开重复公告与重复时间线项以验证全部 3 处时间渲染
    const dupBoardToggle = screen.queryByTestId('toggle-similar-board-2') ?? screen.queryByTestId('toggle-similar-board-1');
    if (dupBoardToggle) fireEvent.click(dupBoardToggle);
    const dupTimelineToggle = screen.queryByTestId('toggle-similar-timeline-evt-2') ?? screen.queryByTestId('toggle-similar-timeline-evt-1');
    if (dupTimelineToggle) fireEvent.click(dupTimelineToggle);

    const swarmText = swarmView.container.textContent || '';
    expect(swarmText).toMatch(localHmRe);
    if (isNonUtc) {
      expect(swarmText).not.toContain('00:05');
    }

    // 跨时区（含 UTC CI）兜底守卫：禁止直接用 .timestamp...slice(...) 截取原始 UTC 字符串
    const workspacePanelsSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/settings/WorkspacePanels.tsx'),
      'utf8'
    );
    const swarmPanelSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/SwarmPanel.tsx'),
      'utf8'
    );
    expect(workspacePanelsSrc).not.toMatch(/\.timestamp(?:\.replace\([^)]*\))?\.slice\(\s*(?:5|11)\s*,/);
    expect(swarmPanelSrc).not.toMatch(/\.timestamp(?:\.replace\([^)]*\))?\.slice\(\s*11\s*,/);
  });

  it('FE-11 (Composer)：删除 @ 引用时按 (kind, value) 精准区分文件与会话，不误删同名另一类型引用', async () => {
    const sharedValue = 'shared-alpha';
    const currentSession = makeSession({ sessionId: 'sess-current', title: '当前会话' });
    const otherSession = makeSession({ sessionId: sharedValue, title: 'Shared Alpha Thread' });

    const view = render(
      wrap(
        <Composer
          session={currentSession}
          availableSessions={[currentSession, otherSession]}
          availableModels={[]}
          approvalConfig={makeApprovalConfig()}
          canTriggerDemoApproval={false}
          onSendPrompt={vi.fn().mockResolvedValue(undefined)}
          onCancelPrompt={vi.fn().mockResolvedValue(undefined)}
          onCompactContext={vi.fn().mockResolvedValue(undefined)}
          onSetSessionMode={vi.fn().mockResolvedValue(undefined)}
          onSetSessionEffort={vi.fn().mockResolvedValue(undefined)}
          onSetSessionModel={vi.fn().mockResolvedValue(undefined)}
          onQueryWorkspaceFiles={vi.fn().mockResolvedValue([sharedValue])}
          onCycleApprovalMode={vi.fn().mockResolvedValue(undefined)}
          onOpenApprovalSettings={vi.fn()}
          onOpenContextInspector={vi.fn()}
          onTriggerDemoApproval={vi.fn()}
        />
      )
    );

    const input = screen.getByTestId('composer-input-sess-current');

    // 添加 File 引用（kind: 'file', value: 'shared-alpha'）
    fireEvent.change(input, { target: { value: '@shared' } });
    const menu1 = await screen.findByTestId('mention-menu-sess-current');
    const fileOpt = Array.from(menu1.querySelectorAll('button.menu-item')).find((b) =>
      (b.textContent || '').includes('File')
    );
    expect(fileOpt).toBeTruthy();
    fireEvent.click(fileOpt!);

    // 添加 Session 引用（kind: 'session', value: 'shared-alpha', label: 'Shared Alpha Thread'）
    fireEvent.change(input, { target: { value: '@shared' } });
    const menu2 = await screen.findByTestId('mention-menu-sess-current');
    const threadOpt = Array.from(menu2.querySelectorAll('button.menu-item')).find((b) =>
      (b.textContent || '').includes('Thread')
    );
    expect(threadOpt).toBeTruthy();
    fireEvent.click(threadOpt!);

    const chipsContainer = view.container.querySelector('.composer-chips');
    expect(chipsContainer).toBeTruthy();
    const chipsBefore = Array.from(chipsContainer!.querySelectorAll<HTMLElement>('.chip'));
    expect(chipsBefore).toHaveLength(2);

    // 仅删除 File 引用芯片
    const fileChip = chipsBefore.find((el) => (el.textContent || '').includes(sharedValue));
    expect(fileChip).toBeTruthy();
    fireEvent.click(within(fileChip!).getByRole('button'));

    // Session 引用芯片必须完好保留
    const chipsAfter = Array.from(view.container.querySelectorAll<HTMLElement>('.composer-chips .chip'));
    expect(chipsAfter).toHaveLength(1);
    expect(chipsAfter[0].textContent).toContain('Shared Alpha Thread');
  });

  it('FE-12 (SettingsView)：工作区/本地路径占位符仅使用中性通用路径，不含个人硬编码盘符路径', async () => {
    const { props } = await makeSettingsBaseProps();

    for (const locale of ['zh-CN', 'en-US'] as const) {
      for (const section of ['projects', 'plugins'] as const) {
        const view = render(wrap(<SettingsView {...props} section={section} />, locale));
        const inputs = Array.from(view.container.querySelectorAll<HTMLInputElement>('input[placeholder]'));
        for (const input of inputs) {
          expect(input.placeholder).not.toMatch(/[D-Z]:\\[^\s]*[\u4e00-\u9fff]/);
          expect(input.placeholder).not.toMatch(/\bF:[\\/]/i);
        }
        view.unmount();
      }
    }
  });

  it('FE-13 (ContextCostInspectorView)：中文界面下 30 天热力图悬停提示不硬编码英文 "threads"', async () => {
    const dayEntry = {
      date: '2026-11-24',
      inputTokens: 10000,
      cachedInputTokens: 500,
      outputTokens: 1500,
      thinkingTokens: 500,
      totalTokens: 12500,
      costUsd: 0.42,
      sessionCount: 3,
      intensity: 3 as const,
    };
    const zero = {
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
    const zeroWithCalls = { ...zero, callCount: 0 };

    const dashboard = makeEmptyTelemetry({
      calendar30d: [dayEntry],
      externalReviewer: {
        hourly24h: [],
        matrix7d: [],
        calendar30d: [dayEntry],
        costByRange: { today: zeroWithCalls, '7d': zeroWithCalls, '30d': zeroWithCalls },
        providerBreakdownByRange: { today: [], '7d': [], '30d': [] },
        cumulativeAllTime: {
          ...zeroWithCalls,
          approvedCount: 0,
          askCount: 0,
          denyCount: 0,
          errorCount: 0,
          providerCount: 0,
        },
        cumulativeProviders: [],
        bySession: {},
        updatedAt: '2026-11-25T12:00:00.000Z',
      },
      externalTranslator: {
        hourly24h: [],
        matrix7d: [],
        calendar30d: [dayEntry],
        costByRange: { today: zeroWithCalls, '7d': zeroWithCalls, '30d': zeroWithCalls },
        providerBreakdownByRange: { today: [], '7d': [], '30d': [] },
        cumulativeAllTime: {
          ...zeroWithCalls,
          successCount: 0,
          fallbackCount: 0,
          errorCount: 0,
          providerCount: 0,
        },
        cumulativeProviders: [],
        bySession: {},
        updatedAt: '2026-11-25T12:00:00.000Z',
      },
    });

    const cases = [
      {
        viewMode: 'context' as const,
        rangeBtnTestId: 'heatmap-range-30d',
        calendarTestId: 'heatmap-30d-calendar',
      },
      {
        viewMode: 'reviewer' as const,
        rangeBtnTestId: 'reviewer-heatmap-range-30d',
        calendarTestId: 'reviewer-heatmap-30d-calendar',
      },
      {
        viewMode: 'translator' as const,
        rangeBtnTestId: 'translator-heatmap-range-30d',
        calendarTestId: 'translator-heatmap-30d-calendar',
      },
    ];

    for (const item of cases) {
      const view = render(
        wrap(
          <ContextCostInspectorView
            sessionId={null}
            viewMode={item.viewMode}
            dashboard={dashboard}
            onOpenRateCardsSettings={vi.fn()}
          />,
          'zh-CN'
        )
      );

      const rangeBtn = screen.queryByTestId(item.rangeBtnTestId)
        ?? screen.getByRole('button', { name: /30\s*[天d]/i });
      fireEvent.click(rangeBtn);

      const calendar = screen.getByTestId(item.calendarTestId);
      const cell = calendar.querySelector('.heatmap-cell');
      expect(cell).toBeTruthy();
      fireEvent.mouseEnter(cell!);

      const hoverEl = view.container.querySelector('.hm-hover');
      expect(hoverEl?.textContent).toContain('2026-11-24');
      expect(hoverEl?.textContent).not.toMatch(/\bthreads\b/i);
      view.unmount();
    }
  });

  it('FE-15 (InlineRequestView)：中文 IME 组合期（keyCode === 229）绝不误触发 1–4 数字审批快捷键', async () => {
    const onSubmitDecision = vi.fn().mockResolvedValue(undefined);
    const request: PendingApprovalRequest = {
      requestId: 'req-ime-1',
      sessionId: 'sess-ime',
      toolCallId: 'tc-ime-1',
      toolName: 'run_command',
      commandOrSummary: 'npm run build',
      cwd: 'C:\\Workspace\\DemoApp',
      createdAt: '2026-11-25T12:00:00.000Z',
      riskLevel: 'medium',
      commandPrefix: 'npm run',
      explanation: {
        meaning: 'Run build script',
        target: 'dist/',
        risk: 'Executes project build command',
      },
      screeningSource: 'manual-mode',
    };

    render(
      wrap(
        <InlineRequestView
          request={request}
          enableNumericShortcuts={true}
          onSubmitDecision={onSubmitDecision}
        />
      )
    );

    // 模拟中文输入法选词期间（isComposing 为 false 但 keyCode === 229）按下数字 1–4
    for (const digit of ['1', '2', '3', '4']) {
      const evt = new KeyboardEvent('keydown', {
        key: digit,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(evt, 'keyCode', { value: 229 });
      Object.defineProperty(evt, 'isComposing', { value: false });
      await act(async () => {
        window.dispatchEvent(evt);
        await Promise.resolve();
      });
    }
    expect(onSubmitDecision).not.toHaveBeenCalled();

    // 非 IME 组合期按数字 1 仍正常触发批准一次
    fireEvent.keyDown(window, { key: '1', keyCode: 49 });
    await waitFor(() =>
      expect(onSubmitDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-ime-1',
          decision: 'allow_once',
        })
      )
    );
  });

  it('Turbo 模式 UI (Composer)：模式菜单可选 Turbo (full-access) 且须经二次确认防误触，激活后正确呈现 Turbo 徽标', async () => {
    const onSetSessionMode = vi.fn().mockResolvedValue(undefined);
    const session = makeSession({ sessionId: 'sess-turbo', executionMode: 'default' });

    const view = render(
      wrap(
        <Composer
          session={session}
          availableSessions={[session]}
          availableModels={[]}
          approvalConfig={makeApprovalConfig()}
          canTriggerDemoApproval={false}
          onSendPrompt={vi.fn().mockResolvedValue(undefined)}
          onCancelPrompt={vi.fn().mockResolvedValue(undefined)}
          onCompactContext={vi.fn().mockResolvedValue(undefined)}
          onSetSessionMode={onSetSessionMode}
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

    // 1) 点击模式胶囊展开模式菜单（不能盲切模式）
    const modePill = screen.getByTestId('execution-mode-pill-sess-turbo');
    fireEvent.click(modePill);
    expect(onSetSessionMode).not.toHaveBeenCalled();

    // 2) 在弹出的模式菜单中找到并点击 Turbo (full-access) 选项
    const turboOption = Array.from(
      document.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="menuitemradio"], [role="option"]')
    ).find((el) => el !== modePill && /Turbo|full-access/i.test(el.textContent || ''));
    expect(turboOption, 'Expected a Turbo (full-access) option in the Composer mode menu').toBeTruthy();

    fireEvent.click(turboOption!);

    // 3) 首次切换 Turbo 必须存在防误触确认步骤，点击选项本身尚不得直接提交 full-access
    expect(onSetSessionMode).not.toHaveBeenCalledWith('sess-turbo', 'full-access');

    // 找到确认按钮并点击确认
    const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) =>
        btn !== modePill &&
        btn !== turboOption &&
        /确认|启用|开启|继续|Confirm|Enable/i.test(btn.textContent || '') &&
        !/取消|Cancel/i.test(btn.textContent || '')
    );
    expect(confirmBtn, 'Expected a confirmation button before activating Turbo (full-access)').toBeTruthy();

    fireEvent.click(confirmBtn!);
    await waitFor(() => expect(onSetSessionMode).toHaveBeenCalledWith('sess-turbo', 'full-access'));

    // 4) 会话进入 full-access 后，左下角胶囊醒目呈现 Turbo 与 mode-full-access 样式类
    view.rerender(
      wrap(
        <Composer
          session={makeSession({ sessionId: 'sess-turbo', executionMode: 'full-access' })}
          availableSessions={[session]}
          availableModels={[]}
          approvalConfig={makeApprovalConfig()}
          canTriggerDemoApproval={false}
          onSendPrompt={vi.fn().mockResolvedValue(undefined)}
          onCancelPrompt={vi.fn().mockResolvedValue(undefined)}
          onCompactContext={vi.fn().mockResolvedValue(undefined)}
          onSetSessionMode={onSetSessionMode}
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

    const activePill = screen.getByTestId('execution-mode-pill-sess-turbo');
    expect(activePill.className).toContain('mode-full-access');
    expect(activePill.textContent).toMatch(/Turbo/i);
  });

  it('静默停止 UI (TurnActivity & SessionPane)：isToolCallFailure 准确统计 exitCode=1 与 rejected，且 SessionPane 底部醒目渲染 TurnDiagnosticCard', async () => {
    const failedExitTool: SemanticToolCallCard = {
      toolCallId: 'tc-exit-1',
      rawToolName: 'run_command',
      canonicalToolName: 'Bash',
      compactTarget: 'python3 -c "bad syntax("',
      command: 'python3 -c "bad syntax("',
      status: 'completed',
      exitCode: 1,
      argsSummary: '{"command":"python3 -c \\"bad syntax(\\""}',
      outputPreview: 'SyntaxError: "(" was never closed',
      startedAt: '2026-11-25T12:00:01.000Z',
      completedAt: '2026-11-25T12:00:02.000Z',
    };
    const rejectedPolicyTool: SemanticToolCallCard = {
      toolCallId: 'tc-policy-rej',
      rawToolName: 'write_file',
      canonicalToolName: 'Write',
      compactTarget: '~/.gemini/antigravity/brain/sess/scratch/diag.py',
      status: 'rejected',
      argsSummary: '{"path":"~/.gemini/antigravity/brain/sess/scratch/diag.py"}',
      outputPreview: '[本地安全策略已拦截] 禁止写入官方配置目录 ~/.gemini',
      startedAt: '2026-11-25T12:00:03.000Z',
      completedAt: '2026-11-25T12:00:03.200Z',
    };

    // 共享契约自检：两者均属于失败工具
    expect(isToolCallFailure(failedExitTool)).toBe(true);
    expect(isToolCallFailure(rejectedPolicyTool)).toBe(true);

    // 1) TurnActivity / ToolActivityStream：中英文均必须统计为 2 项失败（含 exitCode=1 与 rejected）
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const v = render(
        wrap(<ToolActivityStream tools={[failedExitTool, rejectedPolicyTool]} onInspectDiff={vi.fn()} />, locale)
      );
      const group = screen.getByTestId('tool-group-tc-exit-1');
      expect(group.className).toContain('has-failure');
      expect(group.textContent).toContain(locale === 'zh-CN' ? '2 项失败' : '2 failed');
      v.unmount();
    }

    // 2) SessionPane：复现「前置正文 + exitCode=1 命令 + 策略拦截 + 工具后无新正文」场景
    for (const code of ['policy_blocked', 'tool_failure_stopped'] as const) {
      const onSendPrompt = vi.fn().mockResolvedValue(undefined);
      const stopBanner = buildDiagnosticBanner(
        code,
        code === 'policy_blocked'
          ? { blockedReasons: ['禁止写入 ~/.gemini'] }
          : { technicalDetail: 'python3 exited with code 1' }
      );
      const assistantMessage: ChatMessageItem = {
        id: `a-silent-${code}`,
        sessionId: 'sess-v032-1',
        role: 'assistant',
        content: '我马上连到服务器查看实时日志并做一次握手诊断。',
        toolCalls: [failedExitTool, rejectedPolicyTool],
        turnStop: stopBanner,
        createdAt: '2026-11-25T12:00:00.000Z',
        completedAt: '2026-11-25T12:00:04.000Z',
      };

      const paneProps = makeSessionPaneProps({
        messages: [
          {
            id: `u-silent-${code}`,
            sessionId: 'sess-v032-1',
            role: 'user',
            content: '请诊断服务器握手失败原因',
            createdAt: '2026-11-25T11:59:59.000Z',
          },
          assistantMessage,
        ],
        onSendPrompt,
      });

      const paneView = render(wrap(<SessionPane {...paneProps} />));

      // 工具分组明确显示 2 项失败
      const group = screen.getByTestId('tool-group-tc-exit-1');
      expect(group.textContent).toContain('2 项失败');

      // 诊断卡必须渲染在前置正文下方（消息最底部），提供一键继续恢复按钮
      const bodyEl = screen.getByTestId(`assistant-body-a-silent-${code}`);
      const diagCard = screen.getByTestId('turn-diagnostic-card');
      expect(diagCard.getAttribute('data-diagnostic-code')).toBe(code);
      expect(bodyEl.compareDocumentPosition(diagCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const continueBtn = within(diagCard).getByTestId('diagnostic-action-continue_turn');
      fireEvent.click(continueBtn);
      await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));

      paneView.unmount();
    }
  });
});
