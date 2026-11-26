import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiagnosticBanner,
  type AcpConnectionStatus,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientLocale,
  type DiagnosticCode,
  type GravityDesktopBridge,
  type ManagedSessionSummary,
  type TelemetryDashboardSnapshot,
} from '@shared';
import { App } from '../src/renderer/App';
import { SessionPane, type SessionPaneProps } from '../src/renderer/components/SessionPane';
import { PaneStatusChip, TurnOutcomeBar } from '../src/renderer/components/TurnActivity';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

beforeEach(() => {
  delete window.gravityDesktop;
  resetFallbackDesktopBridge();
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeBaseSession(overrides: Partial<ManagedSessionSummary> = {}): ManagedSessionSummary {
  return {
    sessionId: 'sess-diag-1',
    cwd: 'C:\\Workspace\\DemoApp',
    rawCwd: 'C:\\Workspace\\DemoApp',
    title: '诊断回归测试会话',
    pinned: false,
    isLegacyApprovalPollution: false,
    status: 'idle',
    modelId: 'gemini-4-neon',
    executionMode: 'default',
    reasoningEffort: 'medium',
    originKind: 'acp-live',
    readOnly: false,
    profileId: 'default',
    updatedAt: '2026-11-24T12:00:00.000Z',
    ...overrides,
  };
}

function makeBaseApprovalConfig(): ApproveForMeConfig {
  return {
    mode: 'manual',
    enableSafeDownloadAutoApprove: false,
    maxDownloadSizeMB: 50,
    cacheTtlHours: 24,
    allowPatterns: [],
    askPatterns: [],
    denyPatterns: [],
    externalReviewer: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
      timeoutMs: 8000,
      maxOutputTokens: 4096,
      thinkingLevel: 'auto',
    },
  };
}

function makeEmptyTelemetry(): TelemetryDashboardSnapshot {
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
    generatedAt: '2026-11-24T12:00:00.000Z',
  };
}

function renderSessionPane(
  overrides: Partial<SessionPaneProps> & { locale?: ClientLocale } = {}
) {
  const { locale = 'zh-CN', ...propOverrides } = overrides;
  const session = propOverrides.session !== undefined ? propOverrides.session : makeBaseSession();
  const scrollMemoryRef = { current: {} as Record<string, number> };
  const defaultProps: SessionPaneProps = {
    slotIndex: 0,
    layoutMode: 'single',
    isFocused: true,
    session,
    availableSessions: session ? [session] : [],
    availableModels: [],
    messages: [],
    pendingApprovals: [],
    approvalConfig: makeBaseApprovalConfig(),
    defaultThoughtTrack: 'zh',
    telemetryDashboard: makeEmptyTelemetry(),
    scrollMemoryRef,
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
    ...propOverrides,
  };

  return {
    props: defaultProps,
    ...render(
      <I18nProvider locale={locale} onChangeLocale={() => {}}>
        <SessionPane {...defaultProps} />
      </I18nProvider>
    ),
  };
}

describe('v0.3.1 对话暂停 / 错误停止结构化诊断与一键恢复 UX', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    '1) 全场景 TurnStopState 与 SessionDiagnosticBanner 在 %s 下准确渲染原因、建议与恢复按钮',
    (locale) => {
      const cases: Array<{
        code: DiagnosticCode;
        severity: 'paused' | 'warning' | 'error';
        expectedAction: string;
        mountOn: 'message' | 'session';
        extraOpts?: Parameters<typeof buildDiagnosticBanner>[1];
      }> = [
        { code: 'user_cancelled', severity: 'paused', expectedAction: 'continue_turn', mountOn: 'message' },
        { code: 'max_tokens', severity: 'paused', expectedAction: 'compact_context', mountOn: 'message' },
        { code: 'refusal', severity: 'warning', expectedAction: 'edit_last_message', mountOn: 'message' },
        { code: 'permission_denied_403', severity: 'error', expectedAction: 'open_accounts_settings', mountOn: 'session' },
        { code: 'auth_required_401', severity: 'error', expectedAction: 'launch_official_login', mountOn: 'session' },
        { code: 'context_overflow', severity: 'warning', expectedAction: 'compact_context', mountOn: 'session' },
        { code: 'acp_disconnected', severity: 'error', expectedAction: 'reconnect_session', mountOn: 'session', extraOpts: { exitCode: 137 } },
        { code: 'agy_binary_missing', severity: 'error', expectedAction: 'open_accounts_settings', mountOn: 'session' },
        { code: 'concurrency_limit_reached', severity: 'warning', expectedAction: 'dismiss', mountOn: 'session', extraOpts: { maxParallelSessions: 4 } },
        { code: 'policy_blocked', severity: 'warning', expectedAction: 'open_approval_settings', mountOn: 'message', extraOpts: { blockedReasons: ['禁止写入 ~/.gemini'] } },
        { code: 'resume_failed', severity: 'error', expectedAction: 'reconnect_session', mountOn: 'session', extraOpts: { technicalDetail: 'Session expired on remote' } },
      ];

      for (const tc of cases) {
        const banner = buildDiagnosticBanner(tc.code, tc.extraOpts);
        const session = makeBaseSession({
          status: tc.code === 'acp_disconnected' ? 'error' : 'idle',
          readOnly: tc.code === 'resume_failed',
          diagnostic: tc.mountOn === 'session' ? banner : undefined,
        });
        const messages: ChatMessageItem[] = [
          {
            id: `u-${tc.code}`,
            sessionId: session.sessionId,
            role: 'user',
            content: '请帮我继续处理当前任务',
            createdAt: '2026-11-24T12:00:00.000Z',
          },
          {
            id: `a-${tc.code}`,
            sessionId: session.sessionId,
            role: 'assistant',
            content: tc.code === 'refusal' ? '' : '已处理一部分内容。',
            turnStop: tc.mountOn === 'message' ? banner : undefined,
            createdAt: '2026-11-24T12:00:02.000Z',
            completedAt: '2026-11-24T12:00:08.000Z',
          },
        ];

        const view = renderSessionPane({ locale, session, messages });
        const cards = screen.getAllByTestId('turn-diagnostic-card');
        const matchedCard = cards.find((el) => el.getAttribute('data-diagnostic-code') === tc.code);
        expect(matchedCard, `Missing turn-diagnostic-card for ${tc.code} (${locale})`).toBeTruthy();
        expect(matchedCard!.getAttribute('data-diagnostic-severity')).toBe(tc.severity);

        const expectedTitle = locale === 'zh-CN' ? banner.titleZh : banner.titleEn;
        expect(matchedCard!.textContent).toContain(expectedTitle);
        expect(within(matchedCard!).getByTestId(`diagnostic-action-${tc.expectedAction}`)).toBeTruthy();
        view.unmount();
      }
    }
  );

  it('2) 空内容的 refusal 助手消息仍渲染诊断卡片（不被 hasBody 过滤隐藏），且 acp_disconnected 在 readOnly:false 时仍提供重连按钮', () => {
    const refusalBanner = buildDiagnosticBanner('refusal');
    const view1 = renderSessionPane({
      locale: 'zh-CN',
      session: makeBaseSession({ status: 'idle', readOnly: false }),
      messages: [
        {
          id: 'u-refusal',
          sessionId: 'sess-diag-1',
          role: 'user',
          content: '测试拒答场景',
          createdAt: '2026-11-24T12:00:00.000Z',
        },
        {
          id: 'a-refusal-empty',
          sessionId: 'sess-diag-1',
          role: 'assistant',
          content: '',
          turnStop: refusalBanner,
          createdAt: '2026-11-24T12:00:01.000Z',
          completedAt: '2026-11-24T12:00:02.000Z',
        },
      ],
    });

    const refusalCard = screen.getByTestId('turn-diagnostic-card');
    expect(refusalCard.getAttribute('data-diagnostic-code')).toBe('refusal');
    expect(refusalCard.getAttribute('data-diagnostic-severity')).toBe('warning');
    expect(within(refusalCard).getByTestId('diagnostic-action-edit_last_message')).toBeTruthy();
    view1.unmount();

    // ACP 断连场景：status='error', readOnly=false 仍展示 diagnostic-action-reconnect_session
    const onBindSlotSession = vi.fn();
    const acpBanner = buildDiagnosticBanner('acp_disconnected', { exitCode: 1 });
    renderSessionPane({
      locale: 'en-US',
      session: makeBaseSession({ status: 'error', readOnly: false, diagnostic: acpBanner }),
      onBindSlotSession,
    });

    const acpCard = screen.getByTestId('turn-diagnostic-card');
    expect(acpCard.getAttribute('data-diagnostic-code')).toBe('acp_disconnected');
    expect(acpCard.getAttribute('data-diagnostic-severity')).toBe('error');
    const reconnectBtn = within(acpCard).getByTestId('diagnostic-action-reconnect_session');
    expect(reconnectBtn).toBeTruthy();
    expect(acpCard.textContent).toContain('exit=1');
  });

  it('3) waiting_question：PaneStatusChip 显示等待回答态而非旋转的 Running，同时支持等待回答诊断卡', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const view = render(
        <I18nProvider locale={locale} onChangeLocale={() => {}}>
          <PaneStatusChip
            sessionId="sess-q"
            status="waiting_question"
            pendingApprovals={0}
            turnStartedAt="2026-11-24T12:00:00.000Z"
          />
        </I18nProvider>
      );
      const chip = screen.getByTestId('pane-status-chip-sess-q');
      expect(chip.className).toContain('is-waiting_question');
      expect(chip.querySelector('.spin')).toBeNull();
      if (locale === 'zh-CN') {
        expect(chip.textContent).not.toContain('运行中');
        expect(chip.textContent).toMatch(/等待|回答|提问/);
      } else {
        expect(chip.textContent).not.toContain('Running');
        expect(chip.textContent).toMatch(/Waiting|Answer|Question/i);
      }
      view.unmount();
    }

    // SessionPane 内带 waiting_question 诊断卡与 QuestionBar
    const qBanner = buildDiagnosticBanner('waiting_question');
    renderSessionPane({
      locale: 'zh-CN',
      session: makeBaseSession({ status: 'waiting_question', diagnostic: qBanner }),
      messages: [
        {
          id: 'm-q',
          sessionId: 'sess-diag-1',
          role: 'assistant',
          content: '',
          question: {
            message: '请选择发布渠道',
            state: 'open',
            fields: [
              {
                name: 'channel',
                title: '请选择发布渠道',
                type: 'string',
                required: true,
                choices: [
                  { value: 'stable', label: 'Stable' },
                  { value: 'beta', label: 'Beta' },
                ],
              },
            ],
          },
          createdAt: '2026-11-24T12:00:00.000Z',
        },
      ],
    });
    const chip = screen.getByTestId('pane-status-chip-sess-diag-1');
    expect(chip.querySelector('.spin')).toBeNull();
    expect(screen.getByTestId('question-bar')).toBeTruthy();
    const card = screen.getByTestId('turn-diagnostic-card');
    expect(card.getAttribute('data-diagnostic-code')).toBe('waiting_question');
    expect(within(card).getByTestId('diagnostic-action-focus_question_bar')).toBeTruthy();
  });

  it('4) rate_limited_429：实时冷却倒计时禁用重试按钮直至冷却结束，且全程零自动切号（严守防封号合规红线）', async () => {
    vi.useFakeTimers();
    const baseTime = new Date('2026-11-24T12:00:00.000Z').getTime();
    vi.setSystemTime(baseTime);

    const switchAccountSpy = vi.fn();
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    const banner429 = buildDiagnosticBanner('rate_limited_429', {
      cooldownUntil: new Date(baseTime + 62_000).toISOString(),
    });
    const session429 = makeBaseSession({
      sessionId: 'sess-primary',
      status: 'error',
      diagnostic: banner429,
    });

    const bridge: GravityDesktopBridge = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        preferences: { ...baseBoot.preferences, locale: 'zh-CN' },
        sessions: [session429],
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: ['sess-primary'],
          activePrimarySessionId: 'sess-primary',
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
      }),
      getSessionMessagePage: async () => ({
        earlierCount: 0,
        earlierUserCount: 0,
        earlierVisibleCount: 0,
        precedingOriginId: null,
        messages: [
          {
            id: 'u-429',
            sessionId: 'sess-primary',
            role: 'user',
            content: '执行构建',
            createdAt: new Date(baseTime - 5000).toISOString(),
          },
        ],
      }),
      switchAccountProfile: switchAccountSpy,
    };
    window.gravityDesktop = bridge;

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
    });

    const card = screen.getByTestId('turn-diagnostic-card');
    expect(card.getAttribute('data-diagnostic-code')).toBe('rate_limited_429');
    expect(card.getAttribute('data-diagnostic-severity')).toBe('warning');

    const timerEl = within(card).getByTestId('diagnostic-cooldown-timer');
    const initialTimerText = timerEl.textContent || '';
    expect(initialTimerText).toMatch(/6[0-2]|1:0[0-2]/);

    const retryBtn = within(card).getByTestId('diagnostic-action-retry_turn') as HTMLButtonElement;
    expect(retryBtn.disabled).toBe(true);
    expect(within(card).getByTestId('diagnostic-action-open_accounts_settings')).toBeTruthy();

    // 推进 10 秒：倒计时实时递减，按钮仍处于禁用态
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(timerEl.textContent).not.toBe(initialTimerText);
    expect(retryBtn.disabled).toBe(true);

    // 推进至冷却结束（再过 55 秒）：重试按钮解除禁用
    act(() => {
      vi.advanceTimersByTime(55_000);
    });
    expect(retryBtn.disabled).toBe(false);

    // 合规红线：429 冷却全过程严禁自动调用 switchAccountProfile
    expect(switchAccountSpy).not.toHaveBeenCalled();
  });

  it('5) App 集成：auth_required_401 按钮触发官方登录/打开账号设置，且监听 onConnectionUpdated 实时更新连接状态', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    const launchLoginSpy = vi.fn().mockResolvedValue({ launched: true, message: 'Official login terminal opened' });
    let connListener: ((status: AcpConnectionStatus) => void) | undefined;

    const session401 = makeBaseSession({
      sessionId: 'sess-primary',
      status: 'error',
      diagnostic: buildDiagnosticBanner('auth_required_401'),
    });

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        preferences: { ...baseBoot.preferences, locale: 'en-US' },
        sessions: [session401],
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: ['sess-primary'],
          activePrimarySessionId: 'sess-primary',
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
      }),
      launchOfficialLogin: launchLoginSpy,
      onConnectionUpdated: (listener) => {
        connListener = listener;
        return () => {
          connListener = undefined;
        };
      },
    };

    render(<App />);
    const card = await screen.findByTestId('turn-diagnostic-card');
    expect(card.getAttribute('data-diagnostic-code')).toBe('auth_required_401');

    fireEvent.click(within(card).getByTestId('diagnostic-action-launch_official_login'));
    await waitFor(() => expect(launchLoginSpy).toHaveBeenCalledTimes(1));

    // onConnectionUpdated 推送断连事件后 App 正常接管并无异常
    await waitFor(() => expect(connListener).toBeTypeOf('function'));
    act(() => {
      connListener!({
        ...baseBoot.connection,
        connected: false,
        lastErrorCode: 'acp_disconnected',
        lastExitCode: 137,
      });
    });

    // 点击「打开账号设置」直达 Settings -> Accounts
    fireEvent.click(within(card).getByTestId('diagnostic-action-open_accounts_settings'));
    await screen.findByTestId('settings-overlay');
  });

  it('6) TurnOutcomeBar 在 max_tokens / refusal / user_cancelled 时绝不渲染绿色 Done / 完成', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      // 对照组：正常完成的回合仍显示 完成 / Done
      const okView = render(
        <I18nProvider locale={locale} onChangeLocale={() => {}}>
          <TurnOutcomeBar
            message={{
              id: 'm-ok',
              sessionId: 's1',
              role: 'assistant',
              content: '完成。',
              createdAt: '2026-11-24T12:00:01.000Z',
              completedAt: '2026-11-24T12:00:06.000Z',
            }}
            turnStartedAt="2026-11-24T12:00:00.000Z"
            onInspectDiff={() => {}}
          />
        </I18nProvider>
      );
      expect(screen.getByTestId('turn-outcome-m-ok').textContent).toContain(locale === 'zh-CN' ? '完成' : 'Done');
      okView.unmount();

      // 非正常结束：绝不能显示绿色 tone-success 或 完成 / Done
      for (const code of ['max_tokens', 'refusal', 'user_cancelled'] as const) {
        const view = render(
          <I18nProvider locale={locale} onChangeLocale={() => {}}>
            <TurnOutcomeBar
              message={{
                id: `m-${code}`,
                sessionId: 's1',
                role: 'assistant',
                content: '部分输出内容',
                turnStop: buildDiagnosticBanner(code),
                createdAt: '2026-11-24T12:00:01.000Z',
                completedAt: '2026-11-24T12:00:07.000Z',
              }}
              turnStartedAt="2026-11-24T12:00:00.000Z"
              onInspectDiff={() => {}}
            />
          </I18nProvider>
        );
        const bar = screen.queryByTestId(`turn-outcome-m-${code}`);
        if (bar) {
          expect(bar.className).not.toContain('is-ok');
          expect(bar.querySelector('.outcome-state.tone-success')).toBeNull();
          expect(bar.textContent).not.toContain('Done');
          expect(bar.textContent).not.toContain('完成');
        }
        view.unmount();
      }
    }
  });

  it('7) 流式中断向后兼容：保留 stream-interrupted-<id> 与 stream-continue-btn-<id>，且遇到尾随 system 消息仍保留继续按钮', () => {
    renderSessionPane({
      locale: 'zh-CN',
      session: makeBaseSession({ status: 'idle' }),
      messages: [
        {
          id: 'u-1',
          sessionId: 'sess-diag-1',
          role: 'user',
          content: '帮我分析性能瓶颈',
          createdAt: '2026-11-24T12:00:00.000Z',
        },
        {
          id: 'a-interrupted',
          sessionId: 'sess-diag-1',
          role: 'assistant',
          content: '初步定位到热路径问题。\n\n⚠ The stream was interrupted. Please continue the task you were working on.',
          turnStop: buildDiagnosticBanner('stream_interrupted'),
          createdAt: '2026-11-24T12:00:01.000Z',
          completedAt: '2026-11-24T12:00:04.000Z',
        },
        {
          id: 'sys-tail',
          sessionId: 'sess-diag-1',
          role: 'system',
          content: '已保留中断前的输出上下文。',
          createdAt: '2026-11-24T12:00:05.000Z',
        },
      ],
    });

    expect(screen.getByTestId('stream-interrupted-a-interrupted')).toBeTruthy();
    expect(screen.getByTestId('stream-continue-btn-a-interrupted')).toBeTruthy();
  });

  it('8) 窗格级全局 Esc：焦点位于输入框之外时，在聚焦窗格按 Esc 仍可取消流式生成', async () => {
    const onCancelPrompt = vi.fn().mockResolvedValue(undefined);
    renderSessionPane({
      isFocused: true,
      session: makeBaseSession({ status: 'streaming' }),
      messages: [
        {
          id: 'a-stream',
          sessionId: 'sess-diag-1',
          role: 'assistant',
          content: '正在生成中……',
          isStreaming: true,
          createdAt: '2026-11-24T12:00:00.000Z',
        },
      ],
      onCancelPrompt,
    });

    // 显式将焦点移出 composer 输入框
    const composerInput = screen.getByTestId('composer-input-sess-diag-1') as HTMLTextAreaElement;
    composerInput.blur();
    document.body.focus();
    expect(document.activeElement).not.toBe(composerInput);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onCancelPrompt).toHaveBeenCalledExactlyOnceWith('sess-diag-1'));
  });

  it('9) 点击 diagnostic-action-continue_turn 失败时捕获并展示错误提示，绝不抛出未捕获 Promise 拒绝', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const onSendPrompt = vi.fn().mockRejectedValue(new Error('Continue failed: network offline'));
      renderSessionPane({
        locale: 'en-US',
        session: makeBaseSession({ status: 'idle' }),
        messages: [
          {
            id: 'u-stop',
            sessionId: 'sess-diag-1',
            role: 'user',
            content: 'Generate full report',
            createdAt: '2026-11-24T12:00:00.000Z',
          },
          {
            id: 'a-max',
            sessionId: 'sess-diag-1',
            role: 'assistant',
            content: 'Partial report output...',
            turnStop: buildDiagnosticBanner('max_tokens'),
            createdAt: '2026-11-24T12:00:01.000Z',
            completedAt: '2026-11-24T12:00:05.000Z',
          },
        ],
        onSendPrompt,
      });

      const continueBtn = screen.getByTestId('diagnostic-action-continue_turn');
      fireEvent.click(continueBtn);

      await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
      await waitFor(() => {
        const alerts = screen.getAllByRole('alert');
        expect(alerts.some((el) => (el.textContent || '').includes('Continue failed: network offline'))).toBe(true);
      });

      // 等待微任务排空，确认零 unhandledRejection
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
