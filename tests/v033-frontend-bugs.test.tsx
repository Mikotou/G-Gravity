import React, { Profiler } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiagnosticBanner,
  DEFAULT_MODEL_RATE_CARDS,
  DEFAULT_TRANSLATION_CONFIG,
  THEME_PRESETS,
  type AccountQuota,
  type AccountsStateSnapshot,
  type AppUpdateState,
  type ApprovalAuditEntry,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientLocale,
  type ClientPreferences,
  type CustomThemeConfig,
  type InspectedLocalTarget,
  type ManagedSessionSummary,
  type PendingApprovalRequest,
  type SessionInspectorData,
  type SwarmTopologyState,
  type TelemetryDashboardSnapshot,
  type TranslationConfig,
  type WorkspaceLayoutState,
  type WorkspaceProjectConfig,
} from '@shared';
import { App } from '../src/renderer/App';
import { AccountQuotaFooter } from '../src/renderer/components/AccountQuotaView';
import { Composer } from '../src/renderer/components/Composer';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { EditUserMessage } from '../src/renderer/components/EditUserMessage';
import { Markdown } from '../src/renderer/components/Markdown';
import {
  clearLocalTargetInspectionCache,
  MediaGallery,
  TargetLink,
  useLocalTargetInspection,
  type MediaPreviewItem,
} from '../src/renderer/components/MediaGallery';
import { ImageSessionContext, ImageWorkspace, MessageImage } from '../src/renderer/components/MessageImage';
import { NewSessionModal } from '../src/renderer/components/NewSessionModal';
import { ProjectSidebar } from '../src/renderer/components/ProjectSidebar';
import { QuestionBar } from '../src/renderer/components/QuestionBar';
import { ResizeHandle } from '../src/renderer/components/ResizeHandle';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { TargetContextMenu } from '../src/renderer/components/SelectionAnnotationTools';
import { SessionPane, type SessionPaneProps } from '../src/renderer/components/SessionPane';
import { SettingsView } from '../src/renderer/components/SettingsView';
import { SwarmPanel } from '../src/renderer/components/SwarmPanel';
import { TokensPanel } from '../src/renderer/components/settings/AppearancePanels';
import { ApprovalsPanel, RatesPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import * as localesMod from '../src/renderer/i18n/locales';
import { AccountQuotaFeed } from '../src/renderer/lib/account-quota-feed';
import { clearAnnotationDraft } from '../src/renderer/lib/annotation-drafts';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

const REPO_ROOT = path.resolve(__dirname, '..');
const RAW_IPC_ERR = "Error invoking remote method 'gravity:test:action': Error: 目标访问被拒";
const RAW_IPC_ERR_NO_NESTED = "Error invoking remote method 'gravity:account:quota': 账户配额查询失败";

beforeEach(() => {
  delete window.gravityDesktop;
  document.body.className = '';
  window.sessionStorage.clear();
  window.localStorage.clear();
  clearLocalTargetInspectionCache();
  resetFallbackDesktopBridge();
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  document.body.className = '';
  clearLocalTargetInspectionCache();
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

function stubDialogPrototype() {
  const proto = HTMLDialogElement.prototype;
  const origShowModal = Object.getOwnPropertyDescriptor(proto, 'showModal');
  const origClose = Object.getOwnPropertyDescriptor(proto, 'close');
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
  return () => {
    if (origShowModal) Object.defineProperty(proto, 'showModal', origShowModal);
    else delete (proto as Partial<HTMLDialogElement>).showModal;
    if (origClose) Object.defineProperty(proto, 'close', origClose);
    else delete (proto as Partial<HTMLDialogElement>).close;
  };
}

function makeSession(overrides: Partial<ManagedSessionSummary> = {}): ManagedSessionSummary {
  return {
    sessionId: 'sess-v033-1',
    cwd: 'C:\\Workspace\\GravityDemo',
    rawCwd: 'C:\\Workspace\\GravityDemo',
    title: 'v0.3.3 前端回归会话',
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
    rateCards: DEFAULT_MODEL_RATE_CARDS.map((c) => ({ ...c })),
    pricingSource: 'reference-api-estimate',
    generatedAt: '2026-11-25T12:00:00.000Z',
    ...overrides,
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

function emptyPage(messages: ChatMessageItem[] = []) {
  return {
    earlierCount: 0,
    earlierUserCount: 0,
    earlierVisibleCount: 0,
    precedingOriginId: null,
    messages,
  };
}

function dispatchImeEscape(target: EventTarget, opts: { isComposing?: boolean; keyCode?: number }) {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (opts.isComposing !== undefined) {
    Object.defineProperty(ev, 'isComposing', { value: opts.isComposing });
  }
  if (opts.keyCode !== undefined) {
    Object.defineProperty(ev, 'keyCode', { value: opts.keyCode });
  }
  target.dispatchEvent(ev);
}

describe('Gravity v0.3.3 前端与自研插件 UI Bug 全量 TDD 回归 (FE-01 ~ FE-19)', () => {
  /* ------------------------------------------------------------------ FE-01 */
  it('FE-01：locales 导出 stripIpcErrorPrefix 且全部 8 处 UI 表面剥离原始 Electron IPC 错误前缀', async () => {
    const restoreDialog = stubDialogPrototype();
    try {
      // 0) 共享纯函数 stripIpcErrorPrefix 导出与行为校验
      const stripIpcErrorPrefix = (localesMod as Record<string, unknown>).stripIpcErrorPrefix as
        | ((raw: unknown) => string)
        | undefined;
      expect(typeof stripIpcErrorPrefix).toBe('function');
      expect(stripIpcErrorPrefix!(RAW_IPC_ERR)).toBe('目标访问被拒');
      expect(stripIpcErrorPrefix!(RAW_IPC_ERR_NO_NESTED)).toBe('账户配额查询失败');
      expect(stripIpcErrorPrefix!('普通错误文案')).toBe('普通错误文案');

      const rejectIpc = () => Promise.reject(new Error(RAW_IPC_ERR));
      window.gravityDesktop = {
        ...getFallbackDesktopBridge(),
        openLinkOrFileTarget: vi.fn(rejectIpc),
      };

      // 1) EditUserMessage
      const editMsg: ChatMessageItem = {
        id: 'u-fe01',
        sessionId: 'sess-fe01',
        role: 'user',
        content: '原始消息',
        createdAt: '2026-11-25T12:00:00.000Z',
      };
      const editView = render(
        wrap(
          <EditUserMessage message={editMsg} busy={false} submit={vi.fn(rejectIpc)}>
            <span>原始消息</span>
          </EditUserMessage>
        )
      );
      fireEvent.click(screen.getByTestId('edit-msg-u-fe01'));
      fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
      const editAlert = await screen.findByRole('alert');
      expect(editAlert.textContent).toContain('目标访问被拒');
      expect(editAlert.textContent).not.toContain('Error invoking remote method');
      editView.unmount();

      // 2) ProjectSidebar (manageSession 失败)
      const sidebarSession = makeSession({ sessionId: 'sess-side-fe01', title: '侧栏错误剥离' });
      const sidebarView = render(
        wrap(
          <ProjectSidebar
            collapsed={false}
            width={264}
            sessions={[sidebarSession]}
            openTabSessionIds={['sess-side-fe01']}
            selectedSessionId="sess-side-fe01"
            hideLegacyPollutionSessions={true}
            organizingTitles={false}
            onToggleCollapse={vi.fn()}
            onSelectSession={vi.fn()}
            onOpenNewSession={vi.fn()}
            onOrganizeTitles={vi.fn().mockResolvedValue(undefined)}
            onTogglePollutionVisibility={vi.fn().mockResolvedValue(undefined)}
            onRenameSession={vi.fn().mockResolvedValue(undefined)}
            onTogglePinSession={vi.fn().mockResolvedValue(undefined)}
            onManageSession={vi.fn(rejectIpc)}
          />
        )
      );
      fireEvent.click(screen.getByTestId('manage-session-sess-side-fe01'));
      fireEvent.click(screen.getByRole('button', { name: /归档会话|Archive conversation/i }));
      const sideAlert = await screen.findByRole('alert');
      expect(sideAlert.textContent).toContain('目标访问被拒');
      expect(sideAlert.textContent).not.toContain('Error invoking remote method');
      sidebarView.unmount();

      // 3) QuestionBar
      const qView = render(
        wrap(
          <QuestionBar
            question={{
              state: 'open',
              message: '请选择方案',
              fields: [
                {
                  name: 'choice',
                  title: '方案',
                  type: 'string',
                  required: true,
                  initial: 'A',
                },
              ],
            }}
            draftKey="fe01-q"
            native={true}
            submit={vi.fn(rejectIpc)}
          />
        )
      );
      fireEvent.click(screen.getByRole('button', { name: /发送回答|Send answer/i }));
      const qAlert = await screen.findByRole('alert');
      expect(qAlert.textContent).toContain('目标访问被拒');
      expect(qAlert.textContent).not.toContain('Error invoking remote method');
      qView.unmount();

      // 4) SelectionAnnotationTools (TargetContextMenu)
      const onCtxErr = vi.fn();
      const ctxView = render(
        wrap(
          <TargetContextMenu
            x={100}
            y={100}
            detected={{
              kind: 'openable-file',
              target: 'C:\\Workspace\\GravityDemo\\README.md',
              displayPath: 'C:\\Workspace\\GravityDemo\\README.md',
            }}
            cwd="C:\\Workspace\\GravityDemo"
            locale="zh-CN"
            onClose={vi.fn()}
            onError={onCtxErr}
          />
        )
      );
      fireEvent.click(screen.getByTestId('ctx-open-default-app'));
      await waitFor(() => expect(onCtxErr).toHaveBeenCalledTimes(1));
      expect(onCtxErr.mock.calls[0][0]).toContain('目标访问被拒');
      expect(onCtxErr.mock.calls[0][0]).not.toContain('Error invoking remote method');
      ctxView.unmount();

      // 5) MessageImage (Lightbox reveal-in-folder)
      const imgView = render(
        wrap(
          <ImageWorkspace.Provider value="C:\\Workspace\\GravityDemo">
            <MessageImage
              source="C:\\Workspace\\GravityDemo\\shot.png"
              displayUrl="data:image/png;base64,iVBORw0KGgo="
              alt="FE01 Shot"
            />
          </ImageWorkspace.Provider>
        )
      );
      fireEvent.click(screen.getByRole('button', { name: 'FE01 Shot' }));
      fireEvent.click(await screen.findByTestId('lightbox-reveal-btn'));
      const lbAlert = await screen.findByTestId('lightbox-reveal-error');
      expect(lbAlert.textContent).toContain('目标访问被拒');
      expect(lbAlert.textContent).not.toContain('Error invoking remote method');
      imgView.unmount();

      // 6 & 7) MediaGallery: TargetLink + MediaCard reveal + FileTrayItem reveal
      const galleryItems: MediaPreviewItem[] = [
        {
          key: 'img-1',
          source: 'C:\\Workspace\\GravityDemo\\hero.png',
          displayUrl: 'data:image/png;base64,iVBORw0KGgo=',
          label: 'hero.png',
          kind: 'image',
        },
        {
          key: 'file-1',
          source: 'C:\\Workspace\\GravityDemo\\report.txt',
          label: 'report.txt',
          kind: 'file',
        },
      ];
      const mgView = render(
        wrap(
          <ImageWorkspace.Provider value="C:\\Workspace\\GravityDemo">
            <TargetLink
              safe={{ href: 'file:///C:/Workspace/GravityDemo/standalone.ts', kind: 'file', tooltip: 'C:\\Workspace\\GravityDemo\\standalone.ts' }}
            >
              standalone.ts
            </TargetLink>
            <MediaGallery items={galleryItems} />
          </ImageWorkspace.Provider>
        )
      );
      fireEvent.click(screen.getByText('standalone.ts'));
      fireEvent.click(screen.getByTestId('md-media-reveal-btn'));
      const fileRevealBtn = document.querySelector<HTMLButtonElement>('.md-file-reveal');
      expect(fileRevealBtn).toBeTruthy();
      fireEvent.click(fileRevealBtn!);
      await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(3));
      for (const alertEl of screen.getAllByRole('alert')) {
        expect(alertEl.textContent).toContain('目标访问被拒');
        expect(alertEl.textContent).not.toContain('Error invoking remote method');
      }
      mgView.unmount();

      // 8) AccountQuotaFeed（含无二次 Error: 前缀的 IPC 包装）
      const feed1 = new AccountQuotaFeed('fe01-q1', async () => {
        throw new Error(RAW_IPC_ERR);
      });
      await feed1.manual();
      expect(feed1.snapshot().error).toBe('目标访问被拒');

      const feed2 = new AccountQuotaFeed('fe01-q2', async () => {
        throw new Error(RAW_IPC_ERR_NO_NESTED);
      });
      await feed2.manual();
      expect(feed2.snapshot().error).toBe('账户配额查询失败');
      expect(feed2.snapshot().error).not.toContain('Error invoking remote method');
    } finally {
      restoreDialog();
    }
  });

  /* ------------------------------------------------------------------ FE-02 */
  it('FE-02：流式生成中按 Escape 退出行内批注编辑、关闭窗格下拉或反馈输入时，绝不调用 cancelPrompt', async () => {
    const sid = 'sess-fe02';
    const otherSession = makeSession({ sessionId: 'sess-fe02-other', title: '备用会话' });
    const streamingSession = makeSession({ sessionId: sid, status: 'streaming', title: '生成中会话' });
    const assistantMsg: ChatMessageItem = {
      id: 'a-fe02',
      sessionId: sid,
      role: 'assistant',
      content: '这是一段正在流式输出的正文内容。',
      isStreaming: true,
      createdAt: '2026-11-25T12:00:00.000Z',
    };

    // 预置一条行内批注
    const draftKey = 'gravity.annotations.' + JSON.stringify(['default', sid]);
    window.localStorage.setItem(
      draftKey,
      JSON.stringify({
        quotes: [],
        notes: [
          {
            id: 'note-1',
            messageId: 'a-fe02',
            selectedText: '正在流式输出的正文',
            comment: '这里补充边界条件',
            createdAt: '2026-11-25T12:00:01.000Z',
          },
        ],
      })
    );

    const onCancelPrompt = vi.fn().mockResolvedValue(undefined);
    const props = makeSessionPaneProps({
      layoutMode: 'split-2',
      session: streamingSession,
      availableSessions: [streamingSession, otherSession],
      messages: [assistantMsg],
      onCancelPrompt,
    });

    const view = render(wrap(<SessionPane {...props} />));

    try {
      // A) 打开行内批注编辑并按 Escape -> 仅退出编辑，不中断生成
      const noteCard = screen.getByTestId('turn-notation-note-1');
      const editBtn = within(noteCard).getByTitle(/编辑批注|Edit notation/i);
      fireEvent.click(editBtn);

      const editInput = noteCard.querySelector<HTMLInputElement>('.turn-notation-edit-row input');
      expect(editInput).toBeTruthy();
      editInput!.focus();
      fireEvent.keyDown(editInput!, { key: 'Escape' });

      expect(noteCard.querySelector('.turn-notation-edit-row')).toBeNull();
      expect(onCancelPrompt).not.toHaveBeenCalled();

      // B) 聚焦双栏窗格切换 <select class="pane-switch"> 并按 Escape -> 绝不调用 cancelPrompt
      const paneSwitch = document.querySelector<HTMLSelectElement>('select.pane-switch');
      expect(paneSwitch).toBeTruthy();
      paneSwitch!.focus();
      fireEvent.keyDown(paneSwitch!, { key: 'Escape' });
      expect(onCancelPrompt).not.toHaveBeenCalled();

      // C) 在待审批反馈框 (.feedback-box input) 按 Escape -> 绝不调用 cancelPrompt
      const approvalReq: PendingApprovalRequest = {
        requestId: 'req-fe02',
        sessionId: sid,
        toolCallId: 'tc-fe02',
        toolName: 'run_command',
        commandOrSummary: 'npm run deploy',
        cwd: streamingSession.cwd,
        createdAt: '2026-11-25T12:00:02.000Z',
        riskLevel: 'high',
        explanation: { meaning: '执行部署', target: 'dist', risk: '外部副作用' },
        screeningSource: 'local-ast',
      };
      view.rerender(
        wrap(
          <SessionPane
            {...props}
            session={{ ...streamingSession, status: 'waiting_approval' }}
            pendingApprovals={[approvalReq]}
          />
        )
      );
      fireEvent.click(screen.getByTestId('btn-reject-feedback-req-fe02'));
      const feedbackInput = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('.feedback-box textarea, .feedback-box input');
      expect(feedbackInput).toBeTruthy();
      feedbackInput!.focus();
      fireEvent.keyDown(feedbackInput!, { key: 'Escape' });
      expect(onCancelPrompt).not.toHaveBeenCalled();

      // D) 对照校验：焦点回到普通区域按 Escape 仍正常中断生成
      view.rerender(wrap(<SessionPane {...props} pendingApprovals={[]} />));
      const paneEl = screen.getByTestId(`session-pane-${sid}`);
      fireEvent.keyDown(paneEl, { key: 'Escape' });
      await waitFor(() => expect(onCancelPrompt).toHaveBeenCalledTimes(1));
    } finally {
      clearAnnotationDraft('default', sid);
    }
  });

  /* ------------------------------------------------------------------ FE-03 */
  it('FE-03：中文 IME 组合态（isComposing / keyCode=229）按 Escape 不关闭 SettingsView 与 NewSessionModal', async () => {
    // 1) SettingsView
    const { props } = await makeSettingsBaseProps();
    const settingsOnClose = vi.fn();
    const settingsView = render(wrap(<SettingsView {...props} onClose={settingsOnClose} />));

    act(() => {
      dispatchImeEscape(window, { isComposing: true });
      dispatchImeEscape(window, { isComposing: false, keyCode: 229 });
    });
    expect(settingsOnClose).not.toHaveBeenCalled();

    // 正常非组合态 Escape 应关闭设置页
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(settingsOnClose).toHaveBeenCalledTimes(1);
    settingsView.unmount();

    // 2) NewSessionModal
    const modalOnClose = vi.fn();
    render(
      wrap(
        <NewSessionModal
          open={true}
          defaultCwd="C:\\Workspace\\GravityDemo"
          onClose={modalOnClose}
          onCreate={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );

    act(() => {
      dispatchImeEscape(window, { isComposing: true });
      dispatchImeEscape(window, { isComposing: false, keyCode: 229 });
    });
    expect(modalOnClose).not.toHaveBeenCalled();

    // 正常非组合态 Escape 应关闭新建会话弹窗
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(modalOnClose).toHaveBeenCalledTimes(1);
  });

  /* ------------------------------------------------------------------ FE-04 */
  it('FE-04：MediaGallery 预览缓存受 LRU 上限控制、切号/删会话可清空；无本地目标的 <Markdown> 不触发无关重渲染', async () => {
    const fallback = getFallbackDesktopBridge();

    // Part A：无本地目标的 <Markdown> 实例不订阅全局预览缓存、不因其他消息预览完成而重渲染
    let resolveInspect!: (res: { items: Record<string, InspectedLocalTarget> }) => void;
    const inspectSpy = vi.fn().mockImplementation(
      () =>
        new Promise<{ items: Record<string, InspectedLocalTarget> }>((resolve) => {
          resolveInspect = resolve;
        })
    );
    window.gravityDesktop = {
      ...fallback,
      inspectLocalTargets: inspectSpy,
    };

    const plainRenders = vi.fn();
    const plainAndLocalView = render(
      wrap(
        <ImageSessionContext.Provider value="sess-fe04-a">
          <ImageWorkspace.Provider value="C:\\Workspace\\GravityDemo">
            <Profiler id="plain-md" onRender={plainRenders}>
              <Markdown text="这是一段纯文本回复，没有任何本地文件路径。" />
            </Profiler>
            <Markdown text="请查看本地截图 [diagram.png](file:///C:/Workspace/GravityDemo/diagram.png)。" />
          </ImageWorkspace.Provider>
        </ImageSessionContext.Provider>
      )
    );

    await waitFor(() => expect(inspectSpy).toHaveBeenCalledTimes(1));
    const rendersBeforeResolve = plainRenders.mock.calls.length;

    await act(async () => {
      resolveInspect({
        items: {
          'file:///C:/Workspace/GravityDemo/diagram.png': {
            rawTarget: 'file:///C:/Workspace/GravityDemo/diagram.png',
            kind: 'image',
            exists: true,
            resolvedPath: 'C:\\Workspace\\GravityDemo\\diagram.png',
            fileUrl: 'file:///C:/Workspace/GravityDemo/diagram.png',
            fileName: 'diagram.png',
            previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            width: 320,
            height: 200,
          },
        },
      });
      await Promise.resolve();
    });

    // 无本地目标的 <Markdown> 不应再触发任何重渲染
    expect(plainRenders.mock.calls.length).toBe(rendersBeforeResolve);
    plainAndLocalView.unmount();

    // Part B：LRU 容量/字节上限控制（大量大体积预览写入后，最早条目被淘汰并在再次访问时重新查询）
    clearLocalTargetInspectionCache();
    const bigPayload = 'data:image/png;base64,' + 'A'.repeat(256 * 1024); // ~256KB / 条
    const lruInspect = vi.fn().mockImplementation(async ({ targets }: { targets: string[] }) => ({
      items: Object.fromEntries(
        targets.map((t) => [
          t,
          {
            rawTarget: t,
            kind: 'image' as const,
            exists: true,
            resolvedPath: t,
            fileName: path.basename(t),
            previewDataUrl: bigPayload,
          },
        ])
      ),
    }));
    window.gravityDesktop = {
      ...fallback,
      inspectLocalTargets: lruInspect,
    };

    function Probe({ targets }: { targets: string[] }) {
      useLocalTargetInspection(targets, { cwd: 'C:\\Workspace\\GravityDemo', sessionId: 'sess-lru' });
      return null;
    }

    const batchTargets = Array.from({ length: 240 }, (_, i) => `C:\\Workspace\\GravityDemo\\img-${i}.png`);
    const lruView = render(<Probe targets={batchTargets} />);
    await waitFor(() => expect(lruInspect).toHaveBeenCalledTimes(Math.ceil(240 / 48)));
    lruView.unmount();

    // 再次查询最早写入的 img-0.png：受 LRU 字节/条目上限淘汰，必须重新发 IPC 而不是永驻内存
    lruInspect.mockClear();
    const checkOldest = render(<Probe targets={[batchTargets[0]]} />);
    await waitFor(() => expect(lruInspect).toHaveBeenCalledTimes(1));
    checkOldest.unmount();

    // Part C：在完整 <App /> 中删除会话时，缓存必须清空（源码或运行时行为双向核验）
    const baseBoot = await fallback.getBootstrap();
    const s1 = makeSession({ sessionId: 'sess-fe04-del', title: '待删会话' });
    const cachedTarget = 'file:///C:/Workspace/GravityDemo/cached-fe04.png';
    const delInspect = vi.fn().mockResolvedValue({
      items: {
        [cachedTarget]: {
          rawTarget: cachedTarget,
          kind: 'image',
          exists: true,
          resolvedPath: 'C:\\Workspace\\GravityDemo\\cached-fe04.png',
          fileName: 'cached-fe04.png',
          previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        },
      },
    });
    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        sessions: [s1],
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: ['sess-fe04-del'],
          activePrimarySessionId: 'sess-fe04-del',
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
      }),
      getSessionMessagePage: async () =>
        emptyPage([
          {
            id: 'a-fe04-del',
            sessionId: 'sess-fe04-del',
            role: 'assistant',
            content: `图片引用 [cached-fe04.png](${cachedTarget})`,
            createdAt: '2026-11-25T12:00:00.000Z',
          },
        ]),
      inspectLocalTargets: delInspect,
      manageSession: async () => ({
        sessions: [],
        layout: { ...baseBoot.layout, openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null },
      }),
    };

    const restoreDialog = stubDialogPrototype();
    try {
      const appView = render(<App />);
      await waitFor(() => expect(delInspect).toHaveBeenCalledTimes(1));

      // 通过侧栏删除该会话
      fireEvent.click(screen.getByTestId('manage-session-sess-fe04-del'));
      fireEvent.click(screen.getByRole('button', { name: /删除会话|Delete conversation/i }));
      fireEvent.click(screen.getByRole('button', { name: /确认永久删除|Permanently delete/i }));
      await waitFor(() => expect(screen.queryByTestId('sidebar-session-sess-fe04-del')).toBeNull());
      appView.unmount();

      // 删会话清空缓存后，重新查询相同目标必须重新触发 inspectLocalTargets
      function SameSessionProbe() {
        useLocalTargetInspection([cachedTarget], { cwd: s1.cwd, sessionId: s1.sessionId });
        return null;
      }
      delInspect.mockClear();
      render(<SameSessionProbe />);
      await waitFor(() => expect(delInspect).toHaveBeenCalledTimes(1));
    } finally {
      restoreDialog();
    }
  });

  /* ------------------------------------------------------------------ FE-05 */
  it('FE-05：handleCloseTab 不覆盖 composerMinHeight；bootstrap 期间事件不丢；setAppIcon/importCustomTheme/thoughtExpandedByDefault 串行写队列', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();

    // 5a + 5b：bootstrap 期间慢 resumeSession + 中途推送 accounts / updateState / translationConfig + 关闭标签不覆盖 composerMinHeight
    let resolveResume!: (s: ManagedSessionSummary) => void;
    let accountListener: ((a: AccountsStateSnapshot) => void) | undefined;
    let updateListener: ((u: AppUpdateState) => void) | undefined;
    let translationListener: ((t: TranslationConfig) => void) | undefined;

    const s1 = makeSession({ sessionId: 'sess-fe05-1', title: '主标签', status: 'closed' });
    const s2 = makeSession({ sessionId: 'sess-fe05-2', title: '次标签', status: 'idle' });
    let persistedLayout: WorkspaceLayoutState = {
      ...baseBoot.layout,
      openTabSessionIds: ['sess-fe05-1', 'sess-fe05-2'],
      activePrimarySessionId: 'sess-fe05-1',
      splitSecondarySessionId: null,
      composerMinHeight: 160,
    };
    const saveLayoutSpy = vi.fn().mockImplementation(async (patch: Partial<WorkspaceLayoutState>) => {
      persistedLayout = { ...persistedLayout, ...patch };
      return persistedLayout;
    });

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        sessions: [s1, s2],
        layout: persistedLayout,
        pendingApprovals: [],
        updateState: {
          status: 'idle',
          currentVersion: '0.3.3',
          repoUrl: baseBoot.updateState?.repoUrl || 'https://github.com/example/gravity',
        },
        translationConfig: structuredClone(DEFAULT_TRANSLATION_CONFIG),
      }),
      resumeSession: vi.fn().mockImplementation(
        () =>
          new Promise<ManagedSessionSummary>((resolve) => {
            resolveResume = resolve;
          })
      ),
      getSessionMessagePage: async () => emptyPage([]),
      saveWorkspaceLayout: saveLayoutSpy,
      onAccountUpdated: (fn) => {
        accountListener = fn;
        return () => { accountListener = undefined; };
      },
      onUpdateState: (fn) => {
        updateListener = fn;
        return () => { updateListener = undefined; };
      },
      onTranslationConfigUpdated: (fn) => {
        translationListener = fn;
        return () => { translationListener = undefined; };
      },
    };

    const view1 = render(<App />);
    await waitFor(() => expect(resolveResume).toBeTypeOf('function'));

    // 在 bootstrap 等待 resumeSession 期间推送最新 accounts / updateState / translationConfig
    const pushedAccounts: AccountsStateSnapshot = {
      ...baseBoot.accounts,
      profiles: [
        ...baseBoot.accounts.profiles,
        {
          profileId: 'prof-early',
          name: 'Early Pushed Profile',
          isDefault: false,
          createdAt: '2026-11-25T12:00:00.000Z',
          lastActivatedAt: '2026-11-25T12:00:00.000Z',
        },
      ],
    };
    const pushedUpdate: AppUpdateState = {
      status: 'available',
      currentVersion: '0.3.3',
      latestVersion: '0.3.9',
      repoUrl: 'https://github.com/example/gravity',
    };
    const pushedTranslation: TranslationConfig = {
      ...structuredClone(DEFAULT_TRANSLATION_CONFIG),
      engine: 'external-api',
      externalTranslator: {
        ...DEFAULT_TRANSLATION_CONFIG.externalTranslator,
        enabled: true,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: 'sk-early-test',
        connectionStatus: 'connected',
        verifiedBy: 'translation-call',
        lastVerifiedAt: '2026-11-25T12:00:00.000Z',
      },
    };

    act(() => {
      accountListener?.(pushedAccounts);
      updateListener?.(pushedUpdate);
      translationListener?.(pushedTranslation);
    });

    await act(async () => {
      resolveResume({ ...s1, status: 'idle' });
      await Promise.resolve();
    });

    await screen.findByTestId('composer-input-sess-fe05-1');

    // 验证 bootstrap 期间推送的 updateState 未被过期 boot 覆盖（应弹出新版本提示或在关于页可见）
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    await screen.findByTestId('settings-overlay');
    // 检查关于页：latestVersion 0.3.9 必须保留
    fireEvent.click(screen.getByTestId('settings-tab-about'));
    expect(screen.getByTestId('update-panel').textContent).toContain('0.3.9');
    // 检查账号页：Early Pushed Profile 必须保留
    fireEvent.click(screen.getByTestId('settings-tab-accounts'));
    expect(screen.getByTestId('settings-overlay').textContent).toContain('Early Pushed Profile');
    // 检查通用页：external-api 必须保留（展开外部翻译卡片验证模型为 gpt-4o-mini）
    fireEvent.click(screen.getByTestId('settings-tab-general'));
    const expandExtBtn = screen.queryByTestId('external-translator-expand-btn');
    if (expandExtBtn && !screen.queryByTestId('translator-model-input') && !screen.queryByTestId('translator-model-select')) {
      fireEvent.click(expandExtBtn);
    }
    expect(screen.getByTestId('translator-connection-badge').textContent).toContain('已连接');
    expect(screen.getByTestId('settings-overlay').innerHTML).toContain('gpt-4o-mini');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('settings-overlay')).toBeNull());

    // 模拟后端 composerMinHeight 已被调整为 220，再关闭次标签 -> handleCloseTab 仅发送 3 字段 patch，绝不把旧 160 写回覆盖 220
    persistedLayout = { ...persistedLayout, composerMinHeight: 220 };
    saveLayoutSpy.mockClear();
    fireEvent.click(screen.getByTestId('tab-close-sess-fe05-2'));
    await waitFor(() => expect(saveLayoutSpy).toHaveBeenCalledTimes(1));
    const closePatch = saveLayoutSpy.mock.calls[0][0] as Partial<WorkspaceLayoutState>;
    expect(closePatch).not.toHaveProperty('composerMinHeight');
    expect(persistedLayout.composerMinHeight).toBe(220);
    view1.unmount();

    // 5c：setAppIcon / updatePreferences 并发乱序响应不回滚较新偏好（走同一 preferenceWrites 序号队列）
    let resolveSlowIcon!: (p: ClientPreferences) => void;
    const basePrefs: ClientPreferences = {
      ...baseBoot.preferences,
      locale: 'zh-CN',
      theme: 'claude-code-dark',
      appIcon: 'gravity-claude-dark',
    };
    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        preferences: basePrefs,
        sessions: [s2],
        layout: { ...baseBoot.layout, openTabSessionIds: ['sess-fe05-2'], activePrimarySessionId: 'sess-fe05-2', splitSecondarySessionId: null },
        pendingApprovals: [],
      }),
      getSessionMessagePage: async () => emptyPage([]),
      setAppIcon: vi.fn().mockImplementation(
        () =>
          new Promise<ClientPreferences>((resolve) => {
            resolveSlowIcon = resolve;
          })
      ),
      updatePreferences: vi.fn().mockImplementation(async (patch: Partial<ClientPreferences>) => ({
        ...basePrefs,
        ...patch,
      })),
    };

    const view2 = render(<App />);
    await screen.findByTestId('composer-input-sess-fe05-2');

    // 打开设置 -> 图标，点击切换图标（较早请求，故意延迟返回）
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    await screen.findByTestId('settings-overlay');
    fireEvent.click(screen.getByTestId('settings-tab-themes'));
    fireEvent.click(screen.getByTestId('settings-tab-icons'));
    fireEvent.click(screen.getByTestId('icon-variant-gravity-macos-dark'));
    await waitFor(() => expect(resolveSlowIcon).toBeTypeOf('function'));

    // 立即切到主题页修改主题为 claude-code-light（较新请求，立即返回）
    fireEvent.click(screen.getByTestId('settings-tab-themes'));
    fireEvent.click(screen.getByTestId('theme-card-claude-code-light'));
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('claude-code-light'));

    // 此时较早的 setAppIcon 携带着旧 theme='claude-code-dark' 才迟到返回 -> 绝不可将较新主题回滚！
    await act(async () => {
      resolveSlowIcon({ ...basePrefs, appIcon: 'gravity-macos-dark', theme: 'claude-code-dark' });
      await Promise.resolve();
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('claude-code-light');
    view2.unmount();
  });

  /* ------------------------------------------------------------------ FE-06 */
  it('FE-06：SettingsView 删除正在编辑的 Project 后自动退出编辑态，后续新增保存不静默丢弃', async () => {
    const { props } = await makeSettingsBaseProps();
    const projA: WorkspaceProjectConfig = {
      id: 'proj-a',
      name: 'Alpha Repo',
      path: 'C:\\Workspace\\Alpha',
      pinned: true,
    };
    const projB: WorkspaceProjectConfig = {
      id: 'proj-b',
      name: 'Beta Repo',
      path: 'C:\\Workspace\\Beta',
      pinned: true,
    };

    const updates: Array<Partial<ClientPreferences>> = [];
    function StatefulProjectsSettings() {
      const [prefs, setPrefs] = React.useState<ClientPreferences>({
        ...props.preferences,
        projects: [projA, projB],
      });
      return (
        <SettingsView
          {...props}
          section="projects"
          preferences={prefs}
          onUpdatePreferences={async (patch) => {
            updates.push(patch);
            setPrefs((prev) => ({ ...prev, ...patch }));
          }}
        />
      );
    }

    render(wrap(<StatefulProjectsSettings />));

    // 1) 点击编辑 projA
    fireEvent.click(screen.getByTestId('edit-project-proj-a'));
    expect((screen.getByTestId('project-name-input') as HTMLInputElement).value).toBe('Alpha Repo');

    // 2) 删除正在编辑的 projA -> 必须自动退出编辑态并重置表单
    fireEvent.click(screen.getByTestId('delete-project-proj-a'));
    await waitFor(() => expect(screen.queryByTestId('project-row-proj-a')).toBeNull());
    expect((screen.getByTestId('project-name-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('project-path-input') as HTMLInputElement).value).toBe('');

    // 3) 输入新项目 Gamma 并保存 -> 必须成功新增到 projects 列表而非静默丢弃
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'Gamma Repo' } });
    fireEvent.change(screen.getByTestId('project-path-input'), { target: { value: 'C:\\Workspace\\Gamma' } });
    fireEvent.click(screen.getByTestId('save-project-btn'));

    await waitFor(() => {
      const last = updates.at(-1);
      expect(last?.projects?.some((p) => p.name === 'Gamma Repo')).toBe(true);
    });
    expect(screen.getByText('Gamma Repo')).toBeTruthy();
  });

  /* ------------------------------------------------------------------ FE-07 */
  it('FE-07：React StrictMode 下 RightInspector 切换悬浮仅回调 1 次；TokensPanel 保存失败时保持 dirty 态', async () => {
    // 7a: StrictMode 下点击 RightInspector 停靠/悬浮开关，onToggleFloating 仅触发 1 次
    const onToggleFloating = vi.fn();
    const inspView = render(
      <React.StrictMode>
        {wrap(
          <RightInspector
            collapsed={false}
            width={380}
            floating={false}
            activeTab="diff"
            focusedDiffFile={null}
            sessionId="sess-fe07"
            sessionMessages={[]}
            telemetry={makeEmptyTelemetry()}
            onSelectTab={vi.fn()}
            onFocusDiffFile={vi.fn()}
            onCommitWidth={vi.fn()}
            onToggleFloating={onToggleFloating}
            onOpenRateCardsSettings={vi.fn()}
          />
        )}
      </React.StrictMode>
    );
    fireEvent.click(screen.getByTestId('inspector-float-toggle'));
    expect(onToggleFloating).toHaveBeenCalledTimes(1);
    expect(onToggleFloating).toHaveBeenCalledWith(true);
    inspView.unmount();

    // 7b: TokensPanel 点击应用保存失败时保持 dirty 态，卸载时再次兜底落盘且不被外部旧 props 冲掉草稿
    const preset = THEME_PRESETS[0];
    const initialTheme: CustomThemeConfig = {
      name: 'Original Custom',
      polarity: preset.polarity,
      baseThemeId: preset.id,
      tokens: { ...preset.tokens },
    };
    const externalTheme: CustomThemeConfig = {
      name: 'External Overwrite Attempt',
      polarity: preset.polarity,
      baseThemeId: preset.id,
      tokens: { ...preset.tokens, accentPrimary: '#00ff00' },
    };
    const onUpdatePreferences = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disk temporarily locked'))
      .mockResolvedValueOnce(undefined);

    const basePrefs: ClientPreferences = {
      locale: 'zh-CN',
      theme: 'custom',
      customTheme: initialTheme,
      appIcon: 'gravity-claude-dark',
      defaultThoughtTrack: 'zh',
      processPerSession: false,
      activeProfileId: 'default',
    };

    const tokensView = render(
      wrap(
        <TokensPanel
          preferences={basePrefs}
          onUpdatePreferences={onUpdatePreferences}
          onImportCustomTheme={vi.fn().mockResolvedValue(undefined)}
          onExportCustomTheme={vi.fn().mockResolvedValue('{}')}
        />
      )
    );

    // 修改配色名称并点击立即应用 -> 首次保存失败
    const nameInput = screen.getByLabelText(/主题名称|Theme name/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Unsaved Edited Theme' } });
    fireEvent.click(screen.getByTestId('apply-custom-theme-btn'));

    const errBanner = await screen.findByRole('alert');
    expect(errBanner.textContent).toContain('Disk temporarily locked');

    // 保存失败后 dirtyRef 必须仍为 true：即使父组件推送了其他 customTheme，本地未保存草稿也不应被覆盖
    tokensView.rerender(
      wrap(
        <TokensPanel
          preferences={{ ...basePrefs, customTheme: externalTheme }}
          onUpdatePreferences={onUpdatePreferences}
          onImportCustomTheme={vi.fn().mockResolvedValue(undefined)}
          onExportCustomTheme={vi.fn().mockResolvedValue('{}')}
        />
      )
    );
    expect((screen.getByLabelText(/主题名称|Theme name/i) as HTMLInputElement).value).toBe('Unsaved Edited Theme');

    // 卸载面板时因仍处于 dirty 态，应再次尝试兜底保存
    tokensView.unmount();
    expect(onUpdatePreferences).toHaveBeenCalledTimes(2);
    expect(onUpdatePreferences.mock.calls[1][0].customTheme?.name).toBe('Unsaved Edited Theme');
  });

  /* ------------------------------------------------------------ FE-08 & FE-09 */
  it('FE-08 & FE-09：生成中 Composer Effort 禁用；Escape 尊重 modeMenuOpen；关闭审批菜单重置 showConnectPrompt', () => {
    const sid = 'sess-fe08';
    const streamingSession = makeSession({
      sessionId: sid,
      status: 'streaming',
      reasoningEffort: 'medium',
      availableModels: [{ modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
    });
    const onCancelPrompt = vi.fn().mockResolvedValue(undefined);
    const onSetSessionEffort = vi.fn().mockResolvedValue(undefined);

    render(
      wrap(
        <Composer
          session={streamingSession}
          availableSessions={[streamingSession]}
          availableModels={streamingSession.availableModels!}
          approvalConfig={makeApprovalConfig({ mode: 'rules-only' })}
          canTriggerDemoApproval={false}
          onSendPrompt={vi.fn().mockResolvedValue(undefined)}
          onCancelPrompt={onCancelPrompt}
          onCompactContext={vi.fn().mockResolvedValue(undefined)}
          onSetSessionMode={vi.fn().mockResolvedValue(undefined)}
          onSetSessionEffort={onSetSessionEffort}
          onSetSessionModel={vi.fn().mockResolvedValue(undefined)}
          onQueryWorkspaceFiles={vi.fn().mockResolvedValue([])}
          onCycleApprovalMode={vi.fn().mockResolvedValue(undefined)}
          onOpenApprovalSettings={vi.fn()}
          onOpenContextInspector={vi.fn()}
          onTriggerDemoApproval={vi.fn()}
        />
      )
    );

    // FE-08：生成中打开模型与推理强度菜单 -> 所有 Effort 按钮必须 disabled 且点击不触发 onSetSessionEffort
    fireEvent.click(screen.getByTestId(`model-select-${sid}`));
    const effortGroup = screen.getByTestId(`effort-select-${sid}`);
    const effortButtons = within(effortGroup).getAllByRole('radio') as HTMLButtonElement[];
    expect(effortButtons.length).toBeGreaterThan(0);
    for (const btn of effortButtons) {
      expect(btn.disabled).toBe(true);
      fireEvent.click(btn);
    }
    expect(onSetSessionEffort).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });

    // FE-09a：生成中打开执行模式菜单，焦点在输入框内按 Escape -> 仅关闭菜单，绝不调用 onCancelPrompt
    fireEvent.click(screen.getByTestId(`execution-mode-pill-${sid}`));
    expect(screen.getByTestId(`execution-mode-menu-${sid}`)).toBeTruthy();
    const textarea = screen.getByTestId(`composer-input-${sid}`);
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancelPrompt).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`execution-mode-menu-${sid}`)).toBeNull();

    // FE-09b：打开审批菜单点击未连接的 AI 代审触发连接引导，按 Escape 关闭后重开 -> 不应残留旧的 showConnectPrompt
    fireEvent.click(screen.getByTestId(`approval-mode-pill-${sid}`));
    fireEvent.click(screen.getByTestId(`approval-menu-mode-hybrid-${sid}`));
    expect(screen.getByTestId(`approval-connect-reviewer-prompt-${sid}`)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId(`approval-menu-${sid}`)).toBeNull();

    fireEvent.click(screen.getByTestId(`approval-mode-pill-${sid}`));
    expect(screen.queryByTestId(`approval-connect-reviewer-prompt-${sid}`)).toBeNull();

    // 再测试点击外部关闭也重置 showConnectPrompt
    fireEvent.click(screen.getByTestId(`approval-menu-mode-hybrid-${sid}`));
    expect(screen.getByTestId(`approval-connect-reviewer-prompt-${sid}`)).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId(`approval-menu-${sid}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`approval-mode-pill-${sid}`));
    expect(screen.queryByTestId(`approval-connect-reviewer-prompt-${sid}`)).toBeNull();
  });

  /* ------------------------------------------------------------ FE-10 & FE-11 */
  it('FE-10 & FE-11：ProjectSidebar 渲染 waiting_question 状态点；RightInspector Terminal 将 rejected 标红置顶', () => {
    // FE-10：侧栏展示 waiting_question 状态点
    const waitingSession = makeSession({
      sessionId: 'sess-fe10-wq',
      title: '等待回答会话',
      status: 'waiting_question',
    });
    const sideView = render(
      wrap(
        <ProjectSidebar
          collapsed={false}
          width={264}
          sessions={[waitingSession]}
          openTabSessionIds={['sess-fe10-wq']}
          selectedSessionId="sess-fe10-wq"
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
      )
    );
    const row = screen.getByTestId('sidebar-session-sess-fe10-wq');
    expect(row.querySelector('.status-dot.is-waiting_question')).toBeTruthy();
    sideView.unmount();

    // FE-11：RightInspector Terminal Tab 将 status='rejected'（即使 exitCode 未定义且时间更早）标红并置顶
    const inspectorData: SessionInspectorData = {
      sessionId: 'sess-fe11',
      diffs: [],
      todos: [],
      terminals: [
        {
          id: 'term-ok-newer',
          toolCallId: 'tc-ok',
          command: 'git status',
          output: 'On branch main',
          status: 'completed',
          exitCode: 0,
          timestamp: '2026-11-25T12:10:00.000Z',
        },
        {
          id: 'term-rejected-older',
          toolCallId: 'tc-rej',
          command: 'cat ~/.gemini/secret.pb',
          output: '[本地安全策略已拦截] 禁止读取受保护路径',
          status: 'rejected',
          timestamp: '2026-11-25T12:01:00.000Z',
        },
      ],
    };

    const inspView = render(
      wrap(
        <RightInspector
          collapsed={false}
          width={420}
          activeTab="diff"
          focusedDiffFile={null}
          sessionId="sess-fe11"
          inspectorData={inspectorData}
          sessionMessages={[]}
          telemetry={makeEmptyTelemetry()}
          onSelectTab={vi.fn()}
          onFocusDiffFile={vi.fn()}
          onCommitWidth={vi.fn()}
          onOpenRateCardsSettings={vi.fn()}
        />
      )
    );

    // 未切换到 Terminal Tab 时，存在 rejected 命令应让终端页签徽标呈现 danger 语义
    const termTab = screen.getByTestId('inspector-tab-terminal');
    expect(termTab.querySelector('.is-danger, .badge-danger, [data-tone="danger"], .tab-count.tone-danger')).toBeTruthy();

    // 切到 Terminal Tab：rejected 条目排在第一位且带 is-failed 红色标记
    inspView.rerender(
      wrap(
        <RightInspector
          collapsed={false}
          width={420}
          activeTab="terminal"
          focusedDiffFile={null}
          sessionId="sess-fe11"
          inspectorData={inspectorData}
          sessionMessages={[]}
          telemetry={makeEmptyTelemetry()}
          onSelectTab={vi.fn()}
          onFocusDiffFile={vi.fn()}
          onCommitWidth={vi.fn()}
          onOpenRateCardsSettings={vi.fn()}
        />
      )
    );
    const articles = Array.from(document.querySelectorAll<HTMLElement>('article.term'));
    expect(articles).toHaveLength(2);
    expect(articles[0].textContent).toContain('cat ~/.gemini/secret.pb');
    expect(articles[0].className).toContain('is-failed');
    expect(articles[1].textContent).toContain('git status');
    expect(articles[1].className).not.toContain('is-failed');
  });

  /* ------------------------------------------------------ FE-12, FE-13, FE-14 */
  it('FE-12：切号失败触发 reloadProfile(initialNotice) 时 toast 为 tone-error 且定时自动消失', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    const twoProfiles: AccountsStateSnapshot = {
      ...baseBoot.accounts,
      activeProfileId: 'default',
      profiles: [
        {
          profileId: 'default',
          name: 'Default',
          isDefault: true,
          createdAt: '2026-11-25T10:00:00.000Z',
          lastActivatedAt: '2026-11-25T10:00:00.000Z',
        },
        {
          profileId: 'work',
          name: 'Work Profile',
          isDefault: false,
          createdAt: '2026-11-25T10:05:00.000Z',
          lastActivatedAt: '2026-11-25T10:05:00.000Z',
        },
      ],
    };

    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        accounts: twoProfiles,
        sessions: [],
        layout: { ...baseBoot.layout, openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null },
        pendingApprovals: [],
      }),
      switchAccountProfile: vi.fn().mockRejectedValue(new Error('Switch profile partial failure')),
      // 模拟切号报错但后端活跃账号已经变为 work，触发 reloadProfile(notice)
      getAccountsState: vi.fn().mockResolvedValue({ ...twoProfiles, activeProfileId: 'work' }),
    };

    render(<App />);
    await waitFor(() => expect(screen.queryByTestId('app-loading')).toBeNull());

    // 打开设置 -> 账号页并切换至 Work Profile
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    await screen.findByTestId('settings-overlay');
    fireEvent.click(screen.getByTestId('settings-tab-accounts'));

    const switchBtn =
      document.querySelector<HTMLButtonElement>('[data-testid="switch-profile-work"]') ??
      screen.getByRole('button', { name: /切换|Switch/i });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(switchBtn);

    const toastEl = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.toast');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(toastEl.className).toContain('tone-error');
    expect(toastEl.className).not.toContain('tone-info');
    expect(toastEl.textContent).toContain('Switch profile partial failure');

    // 自动关闭定时器生效（超过错误提示停留时间 5200ms 后自动消失）
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('FE-13：SwarmPanel 使用 rowId ?? id 作为成员卡片 key，同 id 归档成员无重复 key 警告且折叠态独立', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const longBrief1 = '第一轮归档成员任务说明：' + '需要逐项审计构建配置、包体瘦身与 CSP 规则并输出详细结论。'.repeat(4);
    const longBrief2 = '第二轮同名成员任务说明：' + '负责验证多账号切换与离线视觉 E2E 回归并整理验收文档。'.repeat(4);

    const topology: SwarmTopologyState = {
      sessionId: 'sess-fe13',
      isActive: true,
      swarmTitle: '重复 ID 归档成员验证',
      channels: ['main'],
      workers: [
        {
          rowId: 101,
          id: 'worker-same-id',
          name: 'builder',
          kind: 'swarm-worker',
          role: 'Builder Round 1',
          model: 'gemini-4-neon',
          workspaceMode: 'share',
          status: 'completed',
          channels: ['main'],
          brief: longBrief1,
          startedAt: '2026-11-25T10:55:00.000Z',
          updatedAt: '2026-11-25T11:00:00.000Z',
        },
        {
          rowId: 102,
          id: 'worker-same-id',
          name: 'builder',
          kind: 'swarm-worker',
          role: 'Builder Round 2',
          model: 'gemini-4-neon',
          workspaceMode: 'share',
          status: 'working',
          channels: ['main'],
          brief: longBrief2,
          startedAt: '2026-11-25T11:55:00.000Z',
          updatedAt: '2026-11-25T12:00:00.000Z',
        },
      ],
      boardMessages: [],
      actionTimeline: [],
      stats: { total: 2, working: 1, waiting: 0, completed: 1, killed: 0 },
      updatedAt: '2026-11-25T12:00:00.000Z',
    };

    render(wrap(<SwarmPanel sessionId="sess-fe13" topology={topology} />));

    const duplicateKeyWarnings = consoleErrSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && /same key|unique "key"/i.test(a))
    );
    expect(duplicateKeyWarnings).toEqual([]);

    const cards = screen.getAllByTestId('swarm-worker-builder');
    expect(cards).toHaveLength(2);

    // 仅展开第一张卡片，第二张卡片折叠态保持独立不受影响
    const firstToggle = within(cards[0]).getByTestId('toggle-worker-brief-builder');
    const secondToggle = within(cards[1]).getByTestId('toggle-worker-brief-builder');
    fireEvent.click(firstToggle);
    expect(firstToggle.textContent).toContain('收起');
    expect(secondToggle.textContent).toContain('展开');
  });

  it('FE-14：剩余 5 处数字输入（翻译/复核 maxTokens 与 timeout、RatesPanel 单价）清空退格不回弹 0', async () => {
    const { props } = await makeSettingsBaseProps();

    // 1 & 2) SettingsView GeneralPanel：translator-max-output-input & translator-timeout-input
    const genView = render(
      wrap(
        <SettingsView
          {...props}
          section="general"
          translationConfig={structuredClone(DEFAULT_TRANSLATION_CONFIG)}
          focusExternalTranslatorSeq={1}
        />
      )
    );
    const transMaxOut = screen.getByTestId('translator-max-output-input') as HTMLInputElement;
    const transTimeout = screen.getByTestId('translator-timeout-input') as HTMLInputElement;

    fireEvent.change(transMaxOut, { target: { value: '' } });
    expect(transMaxOut.value).toBe('');
    fireEvent.change(transMaxOut, { target: { value: '2048' } });
    expect(transMaxOut.value).toBe('2048');

    fireEvent.change(transTimeout, { target: { value: '' } });
    expect(transTimeout.value).toBe('');
    fireEvent.change(transTimeout, { target: { value: '12000' } });
    expect(transTimeout.value).toBe('12000');
    genView.unmount();

    // 3 & 4) WorkspacePanels ApprovalsPanel：reviewer-max-output-input & reviewer-timeout-input
    const revView = render(
      wrap(
        <ApprovalsPanel
          config={makeApprovalConfig()}
          auditEntries={[]}
          initialTab="reviewer"
          onUpdateConfig={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );
    const revMaxOut = screen.getByTestId('reviewer-max-output-input') as HTMLInputElement;
    const revTimeout = screen.getByTestId('reviewer-timeout-input') as HTMLInputElement;

    fireEvent.change(revMaxOut, { target: { value: '' } });
    expect(revMaxOut.value).toBe('');
    fireEvent.change(revMaxOut, { target: { value: '3072' } });
    expect(revMaxOut.value).toBe('3072');

    fireEvent.change(revTimeout, { target: { value: '' } });
    expect(revTimeout.value).toBe('');
    // 输入过小值 blur 后统一钳制至 >= 500ms
    fireEvent.change(revTimeout, { target: { value: '120' } });
    fireEvent.blur(revTimeout);
    expect(Number(revTimeout.value)).toBeGreaterThanOrEqual(500);
    revView.unmount();

    // 5) RatesPanel 单价输入
    const onSaveRates = vi.fn().mockResolvedValue(undefined);
    const rateCard = DEFAULT_MODEL_RATE_CARDS[0];
    render(
      wrap(
        <RatesPanel
          rateCards={DEFAULT_MODEL_RATE_CARDS.map((c) => ({ ...c }))}
          onUpdateRateCards={onSaveRates}
        />
      )
    );
    const rateInput = screen.getByTestId(`rate-${rateCard.modelId}-inputPerMillionUsd`) as HTMLInputElement;
    fireEvent.change(rateInput, { target: { value: '' } });
    expect(rateInput.value).toBe('');
    fireEvent.change(rateInput, { target: { value: '2.75' } });
    expect(rateInput.value).toBe('2.75');
    fireEvent.blur(rateInput);
    fireEvent.click(screen.getByTestId('save-rate-cards-btn'));
    await waitFor(() => expect(onSaveRates).toHaveBeenCalledTimes(1));
    expect(onSaveRates.mock.calls[0][0][0].inputPerMillionUsd).toBe(2.75);
  });

  /* ------------------------------------------------------------ FE-15 (D1-B) */
  it('FE-15 (D1-B 收口)：只读历史视图 ReadOnlyHistoryView.tsx 已由 D1-B 彻底移除', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src', 'renderer', 'components', 'ReadOnlyHistoryView.tsx'))).toBe(false);
  });

  /* ------------------------------------------------------------ FE-16 & FE-17 */
  it('FE-16：切回已向上滚动的历史会话时不误标 hasUnseen，并直接显示“回到底部”按钮', () => {
    const sA = makeSession({ sessionId: 'sess-fe16-a', title: '会话 A' });
    const sB = makeSession({ sessionId: 'sess-fe16-b', title: '会话 B' });
    const scrollMemoryRef = { current: { 'sess-fe16-a': 1200, 'sess-fe16-b': 0 } as Record<string, number> };

    const msgA: ChatMessageItem = {
      id: 'm-a1',
      sessionId: 'sess-fe16-a',
      role: 'assistant',
      content: '会话 A 内容',
      createdAt: '2026-11-25T12:00:00.000Z',
    };
    const msgB: ChatMessageItem = {
      id: 'm-b1',
      sessionId: 'sess-fe16-b',
      role: 'assistant',
      content: '会话 B 长对话内容',
      createdAt: '2026-11-25T12:00:00.000Z',
    };

    const view = render(
      wrap(
        <SessionPane
          {...makeSessionPaneProps({
            session: sA,
            availableSessions: [sA, sB],
            messages: [msgA],
            scrollMemoryRef,
          })}
        />
      )
    );

    const streamEl = document.querySelector<HTMLDivElement>('.stream')!;
    expect(streamEl).toBeTruthy();
    Object.defineProperty(streamEl, 'scrollHeight', { configurable: true, get: () => 2200 });
    Object.defineProperty(streamEl, 'clientHeight', { configurable: true, get: () => 500 });

    // 切换到已上滚到顶部的会话 B（scrollMemoryRef['sess-fe16-b'] = 0，距底 1700px > 240px）
    view.rerender(
      wrap(
        <SessionPane
          {...makeSessionPaneProps({
            session: sB,
            availableSessions: [sA, sB],
            messages: [msgB],
            scrollMemoryRef,
          })}
        />
      )
    );

    // 必须显示“回到底部”按钮且绝不误带 has-unseen 未读高亮
    const jumpBtn = screen.getByTestId('jump-latest-sess-fe16-b');
    expect(jumpBtn).toBeTruthy();
    expect(jumpBtn.className).not.toContain('has-unseen');
    expect(jumpBtn.textContent).not.toMatch(/新内容|New activity/i);
  });

  it('FE-17 (P3-3 闭环)：相邻两条同 turnStop.code 助手消息仅展示 1 张底部 TurnDiagnosticCard（隐藏前一条重复紧凑卡）', () => {
    const sid = 'sess-fe17-p33';
    const session = makeSession({ sessionId: sid, status: 'idle' });
    const stop1 = buildDiagnosticBanner('policy_blocked', {
      occurredAt: '2026-11-25T12:00:05.000Z',
      stopReason: 'end_turn',
    });
    const stop2 = buildDiagnosticBanner('policy_blocked', {
      occurredAt: '2026-11-25T12:00:10.000Z',
      stopReason: 'end_turn',
    });

    const userMsg: ChatMessageItem = {
      id: 'u-p33',
      sessionId: sid,
      role: 'user',
      content: '请诊断服务器日志',
      createdAt: '2026-11-25T12:00:00.000Z',
    };
    const firstAssistant: ChatMessageItem = {
      id: 'a-p33-1',
      sessionId: sid,
      role: 'assistant',
      content: '我马上排查 TLS 握手日志。',
      turnStop: stop1,
      createdAt: '2026-11-25T12:00:01.000Z',
      completedAt: '2026-11-25T12:00:05.000Z',
    };
    const autoResumeNotice: ChatMessageItem = {
      id: 'sys-p33',
      sessionId: sid,
      role: 'system',
      content: '部分命令因触及本地安全策略已被拦截，已自动通知模型跳过受限项并继续完成答复…',
      createdAt: '2026-11-25T12:00:06.000Z',
    };
    const secondAssistant: ChatMessageItem = {
      id: 'a-p33-2',
      sessionId: sid,
      role: 'assistant',
      content: '',
      autoResumeFailure: { detail: '官方服务结束了续接，未返回正文或附件（end_turn）。' },
      turnStop: stop2,
      createdAt: '2026-11-25T12:00:07.000Z',
      completedAt: '2026-11-25T12:00:10.000Z',
    };

    // 场景 A：真实 P3-3 序列（a1 + system 自动续接提示 + a2，同为 policy_blocked）-> 仅展示 1 张完整底部卡
    const view = render(
      wrap(
        <SessionPane
          {...makeSessionPaneProps({
            session,
            messages: [userMsg, firstAssistant, autoResumeNotice, secondAssistant],
          })}
        />
      )
    );
    const cardsWithSystem = screen.getAllByTestId('turn-diagnostic-card');
    expect(cardsWithSystem).toHaveLength(1);
    expect(cardsWithSystem[0].getAttribute('data-diagnostic-code')).toBe('policy_blocked');
    expect(cardsWithSystem[0].className).not.toContain('is-compact');

    // 场景 B：直接相邻两条同 code 助手消息 [u1, a1, a2] -> 同样仅展示 1 张底部卡
    view.rerender(
      wrap(
        <SessionPane
          {...makeSessionPaneProps({
            session,
            messages: [userMsg, firstAssistant, secondAssistant],
          })}
        />
      )
    );
    expect(screen.getAllByTestId('turn-diagnostic-card')).toHaveLength(1);

    // 场景 C：不同 turnStop.code（tool_failure_stopped vs policy_blocked）-> 不误合并，两张均保留
    const diffCodeAssistant: ChatMessageItem = {
      ...firstAssistant,
      turnStop: buildDiagnosticBanner('tool_failure_stopped', { occurredAt: '2026-11-25T12:00:05.000Z' }),
    };
    view.rerender(
      wrap(
        <SessionPane
          {...makeSessionPaneProps({
            session,
            messages: [userMsg, diffCodeAssistant, autoResumeNotice, secondAssistant],
          })}
        />
      )
    );
    expect(screen.getAllByTestId('turn-diagnostic-card')).toHaveLength(2);
  });

  /* ------------------------------------------------------------ FE-18 & FE-19 */
  it('FE-18：自定义主题极性 / Inspector files / <details> 接入双语 i18n；审批菜单与预设下拉具备 ARIA 属性', () => {
    const preset = THEME_PRESETS[0];
    const prefs: ClientPreferences = {
      locale: 'zh-CN',
      theme: 'custom',
      customTheme: { name: 'Test', polarity: 'dark', baseThemeId: preset.id, tokens: { ...preset.tokens } },
      appIcon: 'gravity-claude-dark',
      defaultThoughtTrack: 'zh',
      processPerSession: false,
      activeProfileId: 'default',
    };

    // 1) AppearancePanels (TokensPanel)：中文模式下极性按钮不使用硬编码 'dark'/'light'，且预设下拉具备 aria-label
    const tokensView = render(
      wrap(
        <TokensPanel
          preferences={prefs}
          onUpdatePreferences={vi.fn().mockResolvedValue(undefined)}
          onImportCustomTheme={vi.fn().mockResolvedValue(undefined)}
          onExportCustomTheme={vi.fn().mockResolvedValue('{}')}
        />,
        'zh-CN'
      )
    );
    const polarityBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.segmented .segmented-btn'));
    expect(polarityBtns.length).toBeGreaterThanOrEqual(2);
    expect(polarityBtns.map((b) => b.textContent?.trim())).not.toEqual(['dark', 'light']);
    const presetSelect = document.querySelector<HTMLSelectElement>('select');
    expect(presetSelect).toBeTruthy();
    expect(Boolean(presetSelect!.getAttribute('aria-label')?.trim())).toBe(true);
    tokensView.unmount();

    // 2) RightInspector 中文模式变更汇总不使用硬编码英文 'files'
    const inspView = render(
      wrap(
        <RightInspector
          collapsed={false}
          width={380}
          activeTab="diff"
          focusedDiffFile={null}
          sessionId="sess-fe18"
          inspectorData={{
            sessionId: 'sess-fe18',
            diffs: [
              {
                filePath: 'src/a.ts',
                oldText: 'a',
                newText: 'b',
                addedLines: 1,
                removedLines: 1,
                lines: [],
                updatedAt: '2026-11-25T12:00:00.000Z',
              },
            ],
            todos: [],
            terminals: [],
          }}
          sessionMessages={[]}
          telemetry={makeEmptyTelemetry()}
          onSelectTab={vi.fn()}
          onFocusDiffFile={vi.fn()}
          onCommitWidth={vi.fn()}
          onOpenRateCardsSettings={vi.fn()}
        />,
        'zh-CN'
      )
    );
    const summaryEl = screen.getByTestId('inspector-change-summary');
    expect(summaryEl.textContent).not.toMatch(/\bfiles\b/);
    inspView.unmount();

    // 3) Markdown <details> 无 <summary> 时在英文环境下输出英文默认标题（非硬编码中文「详情」）
    const mdView = render(wrap(<Markdown text={'<details>\nHidden body\n</details>'} />, 'en-US'));
    const summaryNode = document.querySelector('details > summary');
    expect(summaryNode).toBeTruthy();
    expect(summaryNode!.textContent?.trim()).not.toBe('详情');
    expect(summaryNode!.textContent?.trim()).toMatch(/Details/i);
    mdView.unmount();

    // 4) Composer 审批菜单触发器具备 aria-haspopup 与动态 aria-expanded
    const sid = 'sess-fe18-aria';
    const session = makeSession({ sessionId: sid });
    render(
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
    const approvalPill = screen.getByTestId(`approval-mode-pill-${sid}`);
    expect(approvalPill.getAttribute('aria-haspopup')).toBe('menu');
    expect(approvalPill.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(approvalPill);
    expect(approvalPill.getAttribute('aria-expanded')).toBe('true');
  });

  it('FE-19：坏图卡隐藏放大镜；Lightbox 翻页清 revealError；ResizeHandle blur 释放拖拽；非法 ISO 不输出 Invalid Date', async () => {
    const restoreDialog = stubDialogPrototype();
    try {
      // 1) 坏图卡隐藏放大镜按钮（md-media-zoom-btn）
      const badImg: MediaPreviewItem = {
        key: 'broken-fe19',
        source: 'data:image/png;base64,BROKEN_FE19',
        displayUrl: 'data:image/png;base64,BROKEN_FE19',
        label: 'broken.png',
        kind: 'image',
      };
      const mgView = render(wrap(<MediaGallery items={[badImg]} />));
      expect(screen.getByTestId('md-media-zoom-btn')).toBeTruthy();
      const img = document.querySelector<HTMLImageElement>('img.md-img')!;
      fireEvent.error(img);
      expect(screen.queryByTestId('md-media-zoom-btn')).toBeNull();
      mgView.unmount();

      // 2) Lightbox 翻页清除 revealError
      window.gravityDesktop = {
        ...getFallbackDesktopBridge(),
        openLinkOrFileTarget: vi.fn().mockRejectedValue(new Error('File vanished')),
      };
      const gallery = [
        {
          source: 'C:\\Workspace\\GravityDemo\\one.png',
          url: 'data:image/png;base64,iVBORw0KGgo=',
          label: 'one.png',
          revealTarget: 'C:\\Workspace\\GravityDemo\\one.png',
        },
        {
          source: 'C:\\Workspace\\GravityDemo\\two.png',
          url: 'data:image/png;base64,R0lGODlhAQABAAAAACw=',
          label: 'two.png',
          revealTarget: 'C:\\Workspace\\GravityDemo\\two.png',
        },
      ];
      const lbView = render(
        wrap(
          <ImageWorkspace.Provider value="C:\\Workspace\\GravityDemo">
            <MessageImage
              source={gallery[0].source}
              displayUrl={gallery[0].url}
              alt="one.png"
              gallery={gallery}
              galleryIndex={0}
            />
          </ImageWorkspace.Provider>
        )
      );
      fireEvent.click(screen.getByRole('button', { name: 'one.png' }));
      fireEvent.click(await screen.findByTestId('lightbox-reveal-btn'));
      expect(await screen.findByTestId('lightbox-reveal-error')).toBeTruthy();

      // 点击下一张（或按右方向键）-> revealError 立即清除
      fireEvent.click(screen.getByTestId('lightbox-next-btn'));
      await waitFor(() => expect(screen.queryByTestId('lightbox-reveal-error')).toBeNull());
      lbView.unmount();

      // 3) ResizeHandle 收到 window blur 时释放拖拽状态与 body 光标锁
      const onPreview = vi.fn();
      const onCommit = vi.fn();
      const rhView = render(
        <ResizeHandle
          value={300}
          min={200}
          max={500}
          defaultValue={300}
          label="调整宽度"
          testId="fe19-resize-handle"
          onPreview={onPreview}
          onCommit={onCommit}
        />
      );
      const handle = screen.getByTestId('fe19-resize-handle');
      fireEvent.mouseDown(handle, { button: 0, clientX: 300 });
      expect(document.body.classList.contains('gv-resizing')).toBe(true);
      expect(handle.classList.contains('is-dragging')).toBe(true);

      fireEvent(window, new Event('blur'));
      expect(document.body.classList.contains('gv-resizing')).toBe(false);
      expect(handle.classList.contains('is-dragging')).toBe(false);
      rhView.unmount();

      // 4) 非法 ISO 时间戳在 AccountQuotaFooter 与 ContextCostInspectorView 中均不输出 "Invalid Date"
      const badProfileId = `quota-bad-iso-${Date.now()}`;
      const badQuota: AccountQuota = {
        profileId: badProfileId,
        plan: 'Pro',
        checkedAt: 'not-a-valid-iso',
        buckets: [
          { id: 'gemini-weekly', remainingFraction: 0.5, resetAt: 'definitely-not-a-date' },
        ],
      };
      window.gravityDesktop = {
        ...getFallbackDesktopBridge(),
        getAccountQuota: vi.fn().mockResolvedValue(badQuota),
      };
      const quotaView = render(wrap(<AccountQuotaFooter profileId={badProfileId} />));
      fireEvent.click(screen.getByTestId('quota-weekly'));
      const details = await screen.findByTestId('quota-details');
      await waitFor(() => expect(within(details).getAllByTestId('quota-bucket').length).toBe(1));
      expect(details.textContent).not.toContain('Invalid Date');
      quotaView.unmount();

      const badCompactionTelemetry = makeEmptyTelemetry({
        activeSessions: {
          'sess-fe19-ctx': {
            sessionId: 'sess-fe19-ctx',
            modelId: 'gemini-4-neon',
            maxContextTokens: 1000000,
            usedContextTokens: 12000,
            usageRatio: 0.012,
            pressureLevel: 'healthy',
            breakdown: {
              systemAndRulesTokens: 1000,
              userMessagesTokens: 5000,
              agentMessagesTokens: 4000,
              thoughtTokens: 500,
              toolCallsTokens: 1500,
              attachmentsTokens: 0,
            },
            attachments: [],
            currentTokensPerSecond: 0,
            peakTokensPerSecond: 0,
            costSummary: {
              inputTokens: 10000,
              cachedInputTokens: 2000,
              outputTokens: 1000,
              thinkingTokens: 500,
              totalTokens: 13500,
              inputCostUsd: 0.01,
              cachedInputCostUsd: 0.001,
              outputCostUsd: 0.005,
              thinkingCostUsd: 0.002,
              totalCostUsd: 0.018,
            },
            usageSource: 'acp-reported',
            pricingSource: 'reference-api-estimate',
            compactions: [
              {
                id: 'comp-bad-iso',
                trigger: 'manual',
                beforeTokens: 50000,
                afterTokens: 12000,
                savedTokens: 38000,
                maxContextTokens: 1000000,
                timestamp: 'not-an-iso-timestamp',
              },
            ],
            updatedAt: '2026-11-25T12:00:00.000Z',
          },
        },
      });
      const ctxView = render(
        wrap(
          <ContextCostInspectorView
            sessionId="sess-fe19-ctx"
            dashboard={badCompactionTelemetry}
            onOpenRateCardsSettings={vi.fn()}
          />
        )
      );
      const compRow = screen.getByTestId('compaction-record-comp-bad-iso');
      expect(compRow.textContent).not.toContain('Invalid Date');
      ctxView.unmount();

      // 5) SessionPane lastUserId 排除 sendFailed 消息（仅最后一条成功发送的用户消息带 edit-latest）
      const sid = 'sess-fe19-lastuser';
      render(
        wrap(
          <SessionPane
            {...makeSessionPaneProps({
              session: makeSession({ sessionId: sid }),
              messages: [
                { id: 'u-ok', sessionId: sid, role: 'user', content: '成功发送的消息', createdAt: '2026-11-25T12:00:00.000Z' },
                { id: 'a-ok', sessionId: sid, role: 'assistant', content: '好的', createdAt: '2026-11-25T12:00:01.000Z' },
                { id: 'u-fail', sessionId: sid, role: 'user', content: '发送失败的消息', sendFailed: true, createdAt: '2026-11-25T12:00:02.000Z' },
              ],
            })}
          />
        )
      );
      expect(screen.getByTestId('edit-msg-u-ok').className).toContain('edit-latest');
      expect(screen.getByTestId('edit-msg-u-fail').className).not.toContain('edit-latest');
    } finally {
      restoreDialog();
    }
  });
});
