import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import {
  APPROVAL_MODE_ORDER,
  clampUiScale,
  DEFAULT_MODEL_RATE_CARDS,
  EXECUTION_MODE_ORDER,
  GRAVITY_BUILTIN_CAPABILITIES,
  MAX_PARALLEL_ACTIVE_SESSIONS, placeSession, workspaceSlots, withoutSession,
  TITLE_ORGANIZE_MODEL_LABEL,
  TITLE_ORGANIZE_RATE_LIMIT,
  UI_SCALE_LIMITS,
  type AccountsStateSnapshot,
  type AcpConnectionStatus,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type ApprovalAuditEntry,
  type ApprovalDecisionSubmission,
  type ApprovalMode,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientLocale,
  type ClientPreferences,
  type GravityIconId,
  type ImportedHistorySessionRecord,
  type ManagedSessionSummary,
  type McpActionInput,
  type ModelRateCard,
  type PendingApprovalRequest,
  type PluginActionInput,
  type PluginsManagerSnapshot,
  type RightInspectorTab,
  type SendPromptInput,
  type SessionInspectorData,
  type SwarmTopologyState,
  type TelemetryDashboardSnapshot,
  type TitleOrganizeRequest,
  type TitleOrganizeResult,
  type TokenCostSummary,
  type WorkspaceLayoutState,
  type WorkspaceSplitMode,
} from '@shared';
import { ActivityRail } from './components/ActivityRail';
import { NewSessionModal } from './components/NewSessionModal';
import { ComposerDrafts } from './lib/composer-draft';
import { clearAnnotationDraft } from './lib/annotation-drafts';
import type { SessionAction } from '../shared/session-contract';
import { ProjectSidebar } from './components/ProjectSidebar';
import { ImportedHistoryPane } from './components/ReadOnlyHistoryView';
import { RightInspector } from './components/RightInspector';
import { SessionWorkspaceGrid } from './components/SessionWorkspaceGrid';
import { SettingsView, type SettingsSection } from './components/SettingsView';
import { TitleOrganizerModal } from './components/TitleOrganizerModal';
import { TopBar } from './components/TopBar';
import { I18nProvider } from './i18n/I18nContext';
import { formatActionError, UI_DICTIONARIES } from './i18n/locales';
import { getDesktopBridge, getFallbackDesktopBridge, isUsingNativeDesktopBridge } from './services/desktop-bridge';
import {
  applyDocumentFavicon,
  applyThemePreference,
  resolveGravityIconVariant,
  subscribeSystemThemeChange,
} from './styles/theme';

const SPLIT_CYCLE: readonly WorkspaceSplitMode[] = ['single', 'split-2'];

type ToastTone = 'info' | 'success' | 'error';

const ZERO_COST: TokenCostSummary = {
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

const INITIAL_TELEMETRY: TelemetryDashboardSnapshot = {
  activeSessions: {},
  hourly24h: [],
  matrix7d: [],
  calendar30d: [],
  costByRange: { today: ZERO_COST, '7d': ZERO_COST, '30d': ZERO_COST },
  modelBreakdownByRange: { today: [], '7d': [], '30d': [] },
  sessionModelBreakdowns: {},
  rateCards: DEFAULT_MODEL_RATE_CARDS.map((r) => ({ ...r })),
  pricingSource: 'reference-api-estimate',
  generatedAt: '',
};

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable));
}

export function App(): React.ReactElement {
  const [workspace, setWorkspace] = useState({ revision: 0, notice: '' });
  const reloadProfile = useCallback((notice = '') => {
    setWorkspace(previous => ({ revision: previous.revision + 1, notice }));
  }, []);
  return <ProfileWorkspace key={workspace.revision} reopenAccounts={workspace.revision > 0} initialNotice={workspace.notice} reloadProfile={reloadProfile} />;
}

function ProfileWorkspace({ reopenAccounts, initialNotice, reloadProfile }: {
  reopenAccounts: boolean; initialNotice: string; reloadProfile: (notice?: string) => void;
}): React.ReactElement {
  const [ready, setReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);

  const [preferences, setPreferences] = useState<ClientPreferences>({
    locale: 'zh-CN',
    theme: 'claude-code-dark',
    appIcon: 'gravity-claude-dark',
    defaultThoughtTrack: 'zh',
    processPerSession: false,
    activeProfileId: 'default',
  });
  const [connection, setConnection] = useState<AcpConnectionStatus>({
    connected: false,
    agyBinaryPath: 'agy',
    agyVersion: '',
    activeSessionCount: 0,
    maxParallelSessions: MAX_PARALLEL_ACTIVE_SESSIONS,
    activeProfileId: 'default',
    availableModels: [],
  });
  const [accounts, setAccounts] = useState<AccountsStateSnapshot>({
    activeProfileId: 'default',
    profiles: [],
    acpIdentity: { connected: false, authMethods: [], supportsLogout: false },
  });
  const [approvalConfig, setApprovalConfig] = useState<ApproveForMeConfig>({
    mode: 'hybrid',
    enableSafeDownloadAutoApprove: true,
    maxDownloadSizeMB: 20,
    cacheTtlHours: 24,
    allowPatterns: [],
    askPatterns: [],
    denyPatterns: [],
    externalReviewer: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
      timeoutMs: 2500,
    },
  });
  const [composerDrafts] = useState(() => new Map() as NonNullable<React.ContextType<typeof ComposerDrafts>>);
  const [sessions, setSessions] = useState<ManagedSessionSummary[]>([]);
  const [importedHistory, setImportedHistory] = useState<ImportedHistorySessionRecord[]>([]);
  const historyIds = useMemo(() => importedHistory.map(h => h.sessionId), [importedHistory]);
  const tabSessions = useMemo(() => [...sessions.filter(s => !s.archivedAt),
    ...importedHistory.map(({ sessionId, title, cwd, readOnly }) => ({ sessionId, title, cwd, readOnly, status: 'closed' as const }))],
    [sessions, importedHistory]);
  const [layout, setLayout] = useState<WorkspaceLayoutState>({
    openTabSessionIds: [],
    activePrimarySessionId: null,
    splitSecondarySessionId: null,
    layoutMode: 'single',
    hideLegacyPollutionSessions: true,
    leftSidebarCollapsed: false,
    leftSidebarWidth: 268,
    rightInspectorCollapsed: false,
    rightInspectorWidth: 380,
    activeInspectorTab: 'diff',
  });
  // 分屏时，焦点可落在任意窗格。
  // 把焦点会话与布局中的主会话分开保存，右侧检查器和快捷键才能跟随当前操作。
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [focusedDiffFile, setFocusedDiffFile] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessageItem[]>>({});
  const [inspectorBySession, setInspectorBySession] = useState<Record<string, SessionInspectorData>>({});
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalRequest[]>([]);
  const [auditEntries, setAuditEntries] = useState<ApprovalAuditEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryDashboardSnapshot>(INITIAL_TELEMETRY);
  const [pluginsSnap, setPluginsSnap] = useState<PluginsManagerSnapshot>({
    builtins: GRAVITY_BUILTIN_CAPABILITIES,
    plugins: [],
    mcpServers: [],
    skills: [],
    refreshedAt: '',
  });
  const [swarmBySession, setSwarmBySession] = useState<Record<string, SwarmTopologyState>>({});

  // 覆盖层
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(reopenAccounts ? 'accounts' : null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [organizeResult, setOrganizeResult] = useState<TitleOrganizeResult | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [organizingTarget, setOrganizingTarget] = useState<string | null>(null);
  const [organizeQuotaLeft, setOrganizeQuotaLeft] = useState<number>(TITLE_ORGANIZE_RATE_LIMIT.maxCalls);
  const [organizeCooldownUntil, setOrganizeCooldownUntil] = useState<number>(0);
  const [organizeCooldownSec, setOrganizeCooldownSec] = useState<number>(0);
  const [toast, setToast] = useState<{ id: number; message: string; tone: ToastTone } | null>(
    initialNotice ? { id: 0, message: initialNotice, tone: 'info' } : null
  );

  useEffect(() => {
    if (!organizeCooldownUntil) {
      setOrganizeCooldownSec(0);
      return;
    }
    const tick = () => {
      const remain = Math.max(0, Math.ceil((organizeCooldownUntil - Date.now()) / 1000));
      setOrganizeCooldownSec(remain);
      if (remain <= 0) {
        setOrganizeCooldownUntil(0);
        setOrganizeQuotaLeft(TITLE_ORGANIZE_RATE_LIMIT.maxCalls);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [organizeCooldownUntil]);

  const scrollMemoryRef = useRef<Record<string, number>>({});
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);

  /** 统一的轻提示：错误停留更久，成功与信息提示短暂出现；同一时刻只保留最新一条。 */
  const showToast = useCallback((msg: string, tone: ToastTone = 'info') => {
    setToast((prev) => ({ id: (prev?.id ?? 0) + 1, message: msg, tone }));
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), tone === 'error' ? 5200 : 3200);
  }, []);

  const reportError = useCallback(
    (err: unknown) => showToast(formatActionError(err, UI_DICTIONARIES[preferences.locale]), 'error'),
    [preferences.locale, showToast]
  );

  /* ---------------------------------------------------------------- 启动与订阅 */
  useEffect(() => {
    let cancelled = false;
    const bridge = getDesktopBridge();

    async function bootstrap(): Promise<void> {
      setBootstrapError(null);
      try {
        const boot = await bridge.getBootstrap();
        if (cancelled) return;
        applyThemePreference(boot.preferences.theme, boot.preferences.customTheme);
        applyDocumentFavicon(boot.preferences.appIcon);
        document.documentElement.lang = boot.preferences.locale;

        // 恢复上次打开的标签前，先与本次取得的会话列表取交集。
        // 单个关闭会话恢复失败时保留摘要，继续处理其他标签。
        const tabCandidates = boot.layout.openTabSessionIds.map(id => boot.sessions.find(s => s.sessionId === id))
          .filter((s): s is ManagedSessionSummary => Boolean(s && !s.archivedAt && !s.isLegacyApprovalPollution));

        const resumedMap = new Map<string, ManagedSessionSummary>();
        for (const cand of tabCandidates) {
          if (cand.status === 'closed') {
            try {
              const resumed = await bridge.resumeSession(cand.sessionId, cand.cwd);
              resumedMap.set(resumed.sessionId, resumed);
            } catch {
              resumedMap.set(cand.sessionId, cand);
            }
          } else {
            resumedMap.set(cand.sessionId, cand);
          }
        }

        const mergedSessions = boot.sessions.map((s) => resumedMap.get(s.sessionId) ?? s);
        const openSessions = tabCandidates.map((s) => resumedMap.get(s.sessionId) ?? s);
        const validOpenIds = boot.layout.openTabSessionIds.filter(id => resumedMap.has(id) ||
          boot.importedHistory?.some(h => h.sessionId === id));
        const primaryId =
          boot.layout.activePrimarySessionId && validOpenIds.includes(boot.layout.activePrimarySessionId)
            ? boot.layout.activePrimarySessionId
            : validOpenIds[0] ?? null;

        setPreferences(boot.preferences);
        setConnection(boot.connection);
        setAccounts(boot.accounts);
        setApprovalConfig(boot.approvalConfig);
        setSessions(mergedSessions);
        setImportedHistory(boot.importedHistory ?? []);
        setLayout({
          ...boot.layout,
          openTabSessionIds: validOpenIds,
          activePrimarySessionId: primaryId,
        });
        setFocusedSessionId(primaryId);
        setPendingApprovals(boot.pendingApprovals);
        setPluginsSnap(boot.plugins);

        // 启动快照只列会话摘要。并行拉取已打开标签的消息、检视数据和协作看板，按会话号放回各自的缓存。
        const [audits, freshTele, ...bundles] = await Promise.all([
          bridge.listApprovalAudit(50),
          bridge.getTelemetryDashboard().catch(() => boot.telemetry),
          ...openSessions.map(async (s) => {
            const [msgs, insp, sw] = await Promise.all([
              bridge.getSessionMessages(s.sessionId),
              bridge.getSessionInspector(s.sessionId),
              bridge.getSwarmState(s.sessionId),
            ]);
            return { id: s.sessionId, msgs, insp, sw };
          }),
        ]);
        if (cancelled) return;
        setTelemetry(freshTele);
        setAuditEntries(audits);
        setMessagesBySession(Object.fromEntries(bundles.map((b) => [b.id, b.msgs])));
        setInspectorBySession(Object.fromEntries(bundles.map((b) => [b.id, b.insp])));
        setSwarmBySession(Object.fromEntries(bundles.map((b) => [b.id, b.sw])));
        setReady(true);
      } catch (err) {
        if (!cancelled) setBootstrapError(formatActionError(err, UI_DICTIONARIES['zh-CN']));
      }
    }
    void bootstrap();

    const offs = [
      bridge.onSessionUpdated((updated) =>
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.sessionId === updated.sessionId);
          if (idx === -1) return [updated, ...prev];
          const copy = [...prev];
          copy[idx] = updated;
          return copy;
        })
      ),
      // 流式事件携带更新后的整条消息。
      // 已有 ID 替换该会话里的旧条目，首次出现才追加，避免每个分片产生一个气泡。
      bridge.onMessageUpserted(({ sessionId, message }) =>
        setMessagesBySession((prev) => {
          const list = prev[sessionId] ?? [];
          const idx = list.findIndex((m) => m.id === message.id);
          if (idx === -1) return { ...prev, [sessionId]: [...list, message] };
          const copy = [...list];
          copy[idx] = message;
          return { ...prev, [sessionId]: copy };
        })
      ),
      bridge.onInspectorUpdated((data) => setInspectorBySession((prev) => ({ ...prev, [data.sessionId]: data }))),
      bridge.onApprovalRequested((req) =>
        setPendingApprovals((prev) => {
          const idx = prev.findIndex((p) => p.requestId === req.requestId);
          if (idx === -1) return [...prev, req];
          const copy = [...prev];
          copy[idx] = req;
          return copy;
        })
      ),
      bridge.onApprovalResolved(({ requestId }) => {
        setPendingApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
        void bridge
          .listApprovalAudit(50)
          .then((list) => {
            if (!cancelled) setAuditEntries(list);
          })
          .catch(() => {});
      }),
      bridge.onTelemetryUpdated((snap) => setTelemetry(snap)),
      bridge.onSwarmUpdated((topo) => setSwarmBySession((prev) => ({ ...prev, [topo.sessionId]: topo }))),
      bridge.onHistoryUpdated((records) => setImportedHistory(records)),
      bridge.onAccountUpdated((state) => setAccounts(state)),
    ];
    // 注销窗口事件的同时，让尚未完成的启动请求识别卸载状态，避免继续应用其最终结果。
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [bootstrapAttempt]);

  // 只有跟随系统的模式订阅明暗变化。切到固定或自定义主题时，React 会先移除上一次订阅。
  useEffect(() => {
    applyThemePreference(preferences.theme, preferences.customTheme);
    if (preferences.theme === 'system') return subscribeSystemThemeChange(() => applyThemePreference('system'));
    return undefined;
  }, [preferences.theme, preferences.customTheme]);

  useEffect(() => {
    applyDocumentFavicon(preferences.appIcon);
  }, [preferences.appIcon]);

  useEffect(() => {
    document.documentElement.lang = preferences.locale;
  }, [preferences.locale]);

  /* ---------------------------------------------------------------- 布局 */
  const patchLayout = useCallback(
    async (patch: Partial<WorkspaceLayoutState>) => {
      try {
        setLayout(await getDesktopBridge().saveWorkspaceLayout(patch));
      } catch (err) {
        reportError(err);
      }
    },
    [reportError]
  );

  const loadSessionData = useCallback(async (sessionId: string) => {
    const bridge = getDesktopBridge();
    const [msgs, insp, sw, teleSnap] = await Promise.all([
      bridge.getSessionMessages(sessionId),
      bridge.getSessionInspector(sessionId),
      bridge.getSwarmState(sessionId),
      bridge.getTelemetryDashboard(),
    ]);
    setMessagesBySession((prev) => ({ ...prev, [sessionId]: msgs }));
    setInspectorBySession((prev) => ({ ...prev, [sessionId]: insp }));
    setSwarmBySession((prev) => ({ ...prev, [sessionId]: sw }));
    setTelemetry(teleSnap);
  }, []);

  const replaceSession = useCallback((updated: ManagedSessionSummary) => {
    setSessions((prev) =>
      prev.some((s) => s.sessionId === updated.sessionId)
        ? prev.map((s) => (s.sessionId === updated.sessionId ? updated : s))
        : [updated, ...prev]
    );
  }, []);

  /* ---------------------------------------------------------------- 会话 */
  const handleSetSessionMode = useCallback(
    async (sessionId: string, mode: AgentExecutionMode) => {
      replaceSession(await getDesktopBridge().setSessionMode(sessionId, mode));
    },
    [replaceSession]
  );

  const handleSetApprovalMode = useCallback(
    async (mode: ApprovalMode) => {
      try {
        setApprovalConfig(await getDesktopBridge().setApprovalMode(mode));
      } catch (err) {
        reportError(err);
      }
    },
    [reportError]
  );

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const profileRef = useRef(preferences.activeProfileId);
  profileRef.current = preferences.activeProfileId;
  const placementQueue = useRef(Promise.resolve());
  const openSessionInWorkspace = useCallback((sessionId: string, slotIndex?: number) => {
    const profile = preferences.activeProfileId;
    const apply = async () => {
      if (profile !== profileRef.current) return;
      const current = layoutRef.current;
      const visible = workspaceSlots(current);
      const target = slotIndex ?? (visible.includes(sessionId) ? visible.indexOf(sessionId) : Math.max(0, visible.indexOf(focusedSessionId)));
      const next = await getDesktopBridge().saveWorkspaceLayout(placeSession(current, target, sessionId));
      if (profile !== profileRef.current) return;
      layoutRef.current = next;
      setLayout(next);
      setFocusedSessionId(sessionId);
    };
    const result = placementQueue.current.then(apply);
    placementQueue.current = result.catch(() => {});
    return result;
  }, [focusedSessionId, preferences.activeProfileId]);

  const handleActivateSession = useCallback(
    async (session: ManagedSessionSummary) => {
      if (session.isLegacyApprovalPollution) return;
      try {
        const bridge = getDesktopBridge();

        replaceSession(await bridge.resumeSession(session.sessionId, session.cwd));
        void bridge.getConnectionStatus().then(setConnection).catch(() => {});
        void bridge.getAccountsState().then(setAccounts).catch(() => {});
        await loadSessionData(session.sessionId);
        await openSessionInWorkspace(session.sessionId);
      } catch (err) {
        reportError(err);
      }
    },
    [loadSessionData, openSessionInWorkspace, replaceSession, reportError]
  );

  const handleContinueHistory = useCallback(
    async (importedSessionId: string, cwd: string, slot?: number) => {
      const created = await getDesktopBridge().continueHistoryInGravity({
        importedSessionId,
        targetCwd: cwd || undefined,
      });

      replaceSession(created);
      await loadSessionData(created.sessionId);
      await openSessionInWorkspace(created.sessionId, slot);
    },
    [openSessionInWorkspace, loadSessionData, replaceSession]
  );

  const handleRefreshHistory = useCallback(async () => {
    try {
      setImportedHistory(await getDesktopBridge().listImportedHistory());
    } catch (err) {
      reportError(err);
    }
  }, [reportError]);

  const handleSelectTab = useCallback(
    async (sessionId: string) => {

      if (workspaceSlots(layout).includes(sessionId)) {
        setFocusedSessionId(sessionId);
        return;
      }
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (target && target.status === 'closed' && !target.readOnly) await handleActivateSession(target);
      else if (target || importedHistory.some(h => h.sessionId === sessionId)) await openSessionInWorkspace(sessionId).catch(reportError);
    },
    [handleActivateSession, importedHistory, openSessionInWorkspace, layout, sessions, reportError]
  );

  const handleCloseTab = useCallback(
    async (sessionId: string) => {
      try {
        const bridge = getDesktopBridge();
        // 先让主进程关闭会话，再保存剩余标签。如果关掉主标签，还要从余下标签中选出新的主会话。
        if (!sessionId.startsWith('ag-history:')) await bridge.closeSession(sessionId);
        composerDrafts.delete(sessionId);
        const next = await bridge.saveWorkspaceLayout(withoutSession(layoutRef.current, sessionId));
        layoutRef.current = next;
        setLayout(next);
        if (focusedSessionId === sessionId) setFocusedSessionId(next.activePrimarySessionId);
      } catch (err) {
        reportError(err);
      }
    },
    [composerDrafts, focusedSessionId, layout.activePrimarySessionId, layout.openTabSessionIds, reportError]
  );

  const handleManageSession = async (id: string, action: SessionAction) => {
    const result = await getDesktopBridge().manageSession(id, action);
    setSessions(result.sessions);
    setLayout(result.layout);
    if (action !== 'restore' && focusedSessionId === id) setFocusedSessionId(result.layout.activePrimarySessionId);
    if (action === 'delete') {
      composerDrafts.delete(id);
      clearAnnotationDraft(accounts.activeProfileId, id);
      try { localStorage.removeItem('gravity.terminal.read.' + accounts.activeProfileId + '.' + id); } catch { /* optional storage */ }
      setMessagesBySession(prev => { const next = { ...prev }; delete next[id]; return next; });
      setInspectorBySession(prev => { const next = { ...prev }; delete next[id]; return next; });
      setSwarmBySession(prev => { const next = { ...prev }; delete next[id]; return next; });
    }
  };

  const handleBindSlotSession = useCallback(
    async (slotIndex: number, sessionId: string) => {
      try {
        const bridge = getDesktopBridge();
        const target = sessions.find((s) => s.sessionId === sessionId);
        if (importedHistory.some(h => h.sessionId === sessionId)) {
          await openSessionInWorkspace(sessionId, slotIndex);
          return;
        }
        if (!target || target.archivedAt || target.isLegacyApprovalPollution || target.profileId !== preferences.activeProfileId) return;

        if (target.status === 'closed') {
          replaceSession(await bridge.resumeSession(sessionId, target.cwd));
          await loadSessionData(sessionId);
        } else if (!layoutRef.current.openTabSessionIds.includes(sessionId)) {
          await loadSessionData(sessionId);
        }
        await openSessionInWorkspace(sessionId, slotIndex);
      } catch (err) {
        reportError(err);
      }
    },
    [importedHistory, loadSessionData, openSessionInWorkspace, preferences.activeProfileId, replaceSession, reportError, sessions]
  );

  const handleCreateSession = useCallback(
    async (cwd: string, title?: string, executionMode?: AgentExecutionMode) => {
      const bridge = getDesktopBridge();
      const created = await bridge.createSession({ cwd, title, executionMode });

      replaceSession(created);
      void bridge.getConnectionStatus().then(setConnection).catch(() => {});
      void bridge.getAccountsState().then(setAccounts).catch(() => {});
      await loadSessionData(created.sessionId);
      await openSessionInWorkspace(created.sessionId);
    },
    [openSessionInWorkspace, loadSessionData, replaceSession]
  );

  const handleOrganizeTitles = useCallback(
    async (request: TitleOrganizeRequest = { scope: 'all' }) => {
      const bridge = getDesktopBridge();
      const dict = UI_DICTIONARIES[preferences.locale];
      const scope =
        request.scope ??
        (request.projectCwd ? 'project' : request.sessionIds?.length === 1 ? 'session' : request.sessionIds?.length ? 'project' : 'all');
      const targetKey =
        scope === 'session' && request.sessionIds?.[0]
          ? `session:${request.sessionIds[0]}`
          : scope === 'project' && request.projectCwd
            ? `project:${request.projectCwd}`
            : 'all';

      setOrganizing(true);
      setOrganizingTarget(targetKey);
      showToast(dict.ui.organizingWithModel(TITLE_ORGANIZE_MODEL_LABEL), 'info');
      try {
        const res = await bridge.organizeTitles({ ...request, scope });
        setSessions(await bridge.listSessions(!layout.hideLegacyPollutionSessions));
        const remaining = res.remainingQuotaInWindow ?? TITLE_ORGANIZE_RATE_LIMIT.maxCalls;
        setOrganizeQuotaLeft(remaining);
        if (remaining <= 0 && res.cooldownResetAt) {
          const until = Date.parse(res.cooldownResetAt);
          if (Number.isFinite(until) && until > Date.now()) setOrganizeCooldownUntil(until);
        }
        const modelLabel = res.modelUsed || TITLE_ORGANIZE_MODEL_LABEL;
        if (scope === 'session') {
          const suggestion = res.suggestions[0];
          showToast(
            suggestion
              ? preferences.locale === 'zh-CN'
                ? `已通过 ${modelLabel} 整理为「${suggestion.organizedTitle}」`
                : `Organized with ${modelLabel}: "${suggestion.organizedTitle}"`
              : preferences.locale === 'zh-CN'
                ? `${modelLabel} 已核对，该会话标题无需调整`
                : `Checked with ${modelLabel} — no title change needed`,
            'success'
          );
        } else {
          setOrganizeResult(res);
          setOrganizeOpen(true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const waitMatch = /请\s*(\d+)\s*秒后/.exec(msg);
        if (waitMatch) {
          setOrganizeQuotaLeft(0);
          setOrganizeCooldownUntil(Date.now() + Number(waitMatch[1]) * 1000);
        }
        reportError(err);
      } finally {
        setOrganizing(false);
        setOrganizingTarget(null);
      }
    },
    [layout.hideLegacyPollutionSessions, preferences.locale, reportError, showToast]
  );

  const handleTogglePollution = useCallback(async () => {
    try {
      const bridge = getDesktopBridge();
      const nextHide = !layout.hideLegacyPollutionSessions;
      const [nextLayout, list] = await Promise.all([
        bridge.saveWorkspaceLayout({ hideLegacyPollutionSessions: nextHide }),
        bridge.listSessions(!nextHide),
      ]);
      setLayout(nextLayout);
      setSessions(list);
    } catch (err) {
      reportError(err);
    }
  }, [layout.hideLegacyPollutionSessions, reportError]);

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        replaceSession(await getDesktopBridge().renameSession(sessionId, title));
      } catch (err) {
        reportError(err);
      }
    },
    [replaceSession, reportError]
  );

  const handleTogglePin = useCallback(
    async (sessionId: string) => {
      try {
        replaceSession(await getDesktopBridge().togglePinSession(sessionId));
      } catch (err) {
        reportError(err);
      }
    },
    [replaceSession, reportError]
  );

  const handleReviseMessage = useCallback(async (input: import('@shared').ReviseMessageInput) => {
    const bridge = getDesktopBridge();
    const branch = await bridge.reviseMessage(input);
    replaceSession(branch);
    await loadSessionData(branch.sessionId);
    const replace = (id: string | null) => id === input.sessionId ? branch.sessionId : id;
    setLayout(await bridge.saveWorkspaceLayout({ openTabSessionIds: layout.openTabSessionIds.map(id => replace(id)!),
      activePrimarySessionId: replace(layout.activePrimarySessionId), splitSecondarySessionId: replace(layout.splitSecondarySessionId) }));
    setFocusedSessionId(branch.sessionId);
  }, [layout, loadSessionData, replaceSession]);
  const handleSendPrompt = useCallback(async (input: SendPromptInput) => getDesktopBridge().sendPrompt(input), []);
  const handleCancelPrompt = useCallback(async (id: string) => getDesktopBridge().cancelPrompt(id), []);
  const handleCompact = useCallback(async (id: string) => getDesktopBridge().compactSessionContext(id), []);
  const handleSetEffort = useCallback(
    async (id: string, effort: AgentReasoningEffort) => replaceSession(await getDesktopBridge().setSessionEffort(id, effort)),
    [replaceSession]
  );
  const handleSetModel = useCallback(
    async (id: string, modelId: string) => replaceSession(await getDesktopBridge().setSessionModel(id, modelId)),
    [replaceSession]
  );
  const handleQueryFiles = useCallback(async (cwd: string, q?: string) => getDesktopBridge().listWorkspaceFiles(cwd, q), []);
  const handleSubmitApproval = useCallback(
    async (submission: ApprovalDecisionSubmission) => {
      const bridge = getDesktopBridge();
      // 先等待主进程接受决定，再同步托管模式和审计列表。待审卡片本身由审批结束事件移除。
      await bridge.submitApprovalDecision(submission);
      if (submission.decision === 'approve_for_me_ai') {
        setApprovalConfig((prev) => (prev.mode === 'hybrid' ? prev : { ...prev, mode: 'hybrid' }));
        showToast(
          preferences.locale === 'zh-CN'
            ? '已放行本次操作，并开启本会话 Approve for me 智能批量代审'
            : 'Approved and enabled Approve for me smart batch review',
          'success'
        );
      }
      setAuditEntries(await bridge.listApprovalAudit(50));
    },
    [preferences.locale, showToast]
  );
  const handleUpdateApprovalConfig = useCallback(async (patch: Partial<ApproveForMeConfig>) => {
    setApprovalConfig(await getDesktopBridge().updateApprovalConfig(patch));
  }, []);
  const handleLaunchSwarmTask = useCallback(
    async (id: string, taskBrief: string) => {
      const prompt = `请针对以下任务启动多子个体并行协作（优先调用 swarm 或 invoke_subagent 拆分独立角色分工并行执行，并汇总各子个体结果）：\n\n${taskBrief}`;
      void getDesktopBridge()
        .sendPrompt({ sessionId: id, text: prompt })
        .catch((err) => reportError(err));
    },
    [reportError]
  );
  const handleTriggerDemoApproval = useCallback((id: string) => {
    if (!isUsingNativeDesktopBridge()) getFallbackDesktopBridge().triggerDemoApproval(id);
  }, []);

  /* ---------------------------------------------------------------- 设置 */
  const handleUpdatePreferences = useCallback(
    async (patch: Partial<ClientPreferences>) => {
      try {
        setPreferences(await getDesktopBridge().updatePreferences(patch));
      } catch (err) {
        reportError(err);
      }
    },
    [reportError]
  );
  const handleChangeLocale = useCallback(
    (locale: ClientLocale) => void handleUpdatePreferences({ locale }),
    [handleUpdatePreferences]
  );
  const handleSetAppIcon = useCallback(
    async (iconId: GravityIconId) => {
      try {
        setPreferences(await getDesktopBridge().setAppIcon(iconId));
      } catch (err) {
        reportError(err);
      }
    },
    [reportError]
  );
  const handleImportTheme = useCallback(async (json: string) => {
    setPreferences(await getDesktopBridge().importCustomTheme(json));
  }, []);
  const handleExportTheme = useCallback(async () => getDesktopBridge().exportCustomTheme(), []);
  const handleUpdateRates = useCallback(async (cards: ModelRateCard[]) => {
    setTelemetry(await getDesktopBridge().updateModelRateCards(cards));
  }, []);
  const handleRefreshPlugins = useCallback(async () => {
    setPluginsSnap(await getDesktopBridge().getPluginsSnapshot());
  }, []);
  const handleRunPluginAction = useCallback(async (input: PluginActionInput) => {
    setPluginsSnap(await getDesktopBridge().runPluginAction(input));
  }, []);
  const handleRunMcpAction = useCallback(async (input: McpActionInput) => {
    setPluginsSnap(await getDesktopBridge().runMcpAction(input));
  }, []);
  const handleToggleSkill = useCallback(async (id: string, enabled: boolean) => {
    setPluginsSnap(await getDesktopBridge().toggleSkillEnabled(id, enabled));
  }, []);
  const handleCreateProfile = useCallback(async (name: string) => {
    setAccounts(await getDesktopBridge().createAccountProfile({ name }));
  }, []);
  const handleSwitchProfile = useCallback(async (profileId: string) => {
    if (profileId === accounts.activeProfileId) return;
    const bridge = getDesktopBridge();
    setReady(false);
    try {
      await bridge.switchAccountProfile(profileId);
    } catch (error) {
      const selected = await bridge.getAccountsState().catch(() => undefined);
      if (selected?.activeProfileId === accounts.activeProfileId) {
        setReady(true);
        reportError(error);
        return;
      }
      reloadProfile(formatActionError(error, UI_DICTIONARIES[preferences.locale]));
      return;
    }
    reloadProfile();
  }, [accounts.activeProfileId, preferences.locale, reloadProfile, reportError]);
  const handleDeleteProfile = useCallback(async (profileId: string) => {
    setAccounts(await getDesktopBridge().deleteAccountProfile(profileId));
  }, []);
  const handleLaunchLogin = useCallback(
    async (profileId?: string) => showToast((await getDesktopBridge().launchOfficialLogin(profileId)).message),
    [showToast]
  );
  const handleLogout = useCallback(async () => showToast((await getDesktopBridge().officialLogout()).message), [showToast]);

  const openInspectorAt = useCallback(
    (sessionId: string, tab: RightInspectorTab, diffFile?: string) => {
      setFocusedSessionId(sessionId);
      if (diffFile) setFocusedDiffFile(diffFile);
      void patchLayout({ rightInspectorCollapsed: false, activeInspectorTab: tab });
    },
    [patchLayout]
  );

  /* ---------------------------------------------------------------- 快捷键 */
  const overlayOpen = settingsSection !== null || newSessionOpen || organizeOpen;
  const uiScaleRef = useRef(preferences.uiScale);
  useEffect(() => { uiScaleRef.current = preferences.uiScale; }, [preferences.uiScale]);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === ',') {
        e.preventDefault();
        setSettingsSection((prev) => (prev ? null : 'general'));
        return;
      }
      // 界面缩放（高分屏适配）：Ctrl+= 放大，Ctrl+- 缩小，Ctrl+0 复原。设置页打开时同样可用。
      if (mod && !e.altKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_' || e.key === '0')) {
        e.preventDefault();
        const current = clampUiScale(uiScaleRef.current);
        const next = e.key === '0' ? UI_SCALE_LIMITS.default
          : clampUiScale(current + (e.key === '-' || e.key === '_' ? -UI_SCALE_LIMITS.step : UI_SCALE_LIMITS.step));
        // 连续按键时以最近一次请求为基准，不必等上一次保存返回。
        uiScaleRef.current = next;
        if (next !== current || e.key === '0') {
          void handleUpdatePreferences({ uiScale: next }).then(() =>
            showToast(UI_DICTIONARIES[preferences.locale].ui.uiScaleToast(Math.round(next * 100))));
        }
        return;
      }
      // 设置或弹窗打开时暂停后续工作台快捷键，防止一次按键同时作用于覆盖层和底层会话。
      if (overlayOpen) return;
      if (mod && key === 'n') {
        e.preventDefault();
        setNewSessionOpen(true);
        return;
      }
      if (mod && key === 'b') {
        e.preventDefault();
        void patchLayout({ leftSidebarCollapsed: !layout.leftSidebarCollapsed });
        return;
      }
      if (mod && key === 'j') {
        e.preventDefault();
        void patchLayout({ rightInspectorCollapsed: !layout.rightInspectorCollapsed });
        return;
      }
      if (mod && e.key === '\\') {
        e.preventDefault();
        void patchLayout({ layoutMode: SPLIT_CYCLE[(SPLIT_CYCLE.indexOf(layout.layoutMode) + 1) % SPLIT_CYCLE.length] });
        return;
      }
      if (e.shiftKey && e.key === 'Tab' && !isTypingTarget(e.target)) {
        e.preventDefault();
        const activeId = focusedSessionId ?? layout.activePrimarySessionId;
        const active = sessions.find((s) => s.sessionId === activeId && s.status !== 'closed');
        if (active) {
          const idx = EXECUTION_MODE_ORDER.indexOf(active.executionMode || 'default');
          void handleSetSessionMode(active.sessionId, EXECUTION_MODE_ORDER[(idx + 1) % EXECUTION_MODE_ORDER.length]).catch(
            reportError
          );
        } else {
          const idx = APPROVAL_MODE_ORDER.indexOf(approvalConfig.mode);
          void handleSetApprovalMode(APPROVAL_MODE_ORDER[(idx + 1) % APPROVAL_MODE_ORDER.length]);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    approvalConfig.mode,
    focusedSessionId,
    handleSetApprovalMode,
    handleSetSessionMode,
    handleUpdatePreferences,
    layout.activePrimarySessionId,
    layout.layoutMode,
    layout.leftSidebarCollapsed,
    layout.rightInspectorCollapsed,
    overlayOpen,
    patchLayout,
    preferences.locale,
    preferences.uiScale,
    reportError,
    sessions,
    showToast,
  ]);

  const recentCwds = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((s) => s.cwd)
        .filter((cwd) => Boolean(cwd) && !/[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)/i.test(cwd)),
    [sessions]
  );

  /* ---------------------------------------------------------------- 渲染 */
  if (!ready) {
    const bootDict = UI_DICTIONARIES[preferences.locale];
    return (
      <div className="app-boot" data-testid="app-loading">
        {bootstrapError ? (
          <div role="alert" className="boot-error" data-testid="app-bootstrap-error">
            <strong>{bootDict.bootstrapErrorTitle}</strong>
            <span>{bootstrapError}</span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setBootstrapAttempt((n) => n + 1)}
              data-testid="retry-bootstrap-btn"
            >
              {bootDict.retryBootstrapBtn}
            </button>
          </div>
        ) : (
          <>
            <img className="app-boot-logo" src={resolveGravityIconVariant(preferences.appIcon).publicSvgUrl} alt="" />
            <span>{bootDict.bootstrapLoading}</span>
          </>
        )}
      </div>
    );
  }

  // 侧栏选中态和检查器使用同一个会话标识。焦点尚未建立时，依次退到主窗格和首个打开的标签。
  const stageSessionId =
    focusedSessionId ?? layout.activePrimarySessionId ?? layout.openTabSessionIds[0] ?? null;
  const stageHistoryId = stageSessionId && historyIds.includes(stageSessionId) ? stageSessionId : null;
  const activeCount = sessions.filter((s) => !s.archivedAt && s.status !== 'closed').length;

  return (
    <I18nProvider locale={preferences.locale} onChangeLocale={handleChangeLocale}>
      <div className="app-shell" data-testid="agy-app-root" data-brand="Gravity">
        <ActivityRail
          appIcon={preferences.appIcon}
          sidebarCollapsed={layout.leftSidebarCollapsed}
          connection={connection}
          accounts={accounts}
          projectCount={(preferences.projects ?? []).length}
          pluginCount={pluginsSnap.plugins.length + pluginsSnap.mcpServers.length}
          activeSessionCount={activeCount}
          onToggleSidebar={() => void patchLayout({ leftSidebarCollapsed: !layout.leftSidebarCollapsed })}
          onOpenNewSession={() => setNewSessionOpen(true)}
          onOpenProjects={() => setSettingsSection('projects')}
          onOpenPlugins={() => setSettingsSection('plugins')}
          onOpenAccounts={() => setSettingsSection('accounts')}
          onOpenSettings={() => setSettingsSection('themes')}
          onOpenAbout={() => setSettingsSection('about')}
          onChangeLocale={handleChangeLocale}
        />

        <ProjectSidebar
          collapsed={layout.leftSidebarCollapsed}
          width={layout.leftSidebarWidth}
          sessions={sessions}
          importedHistory={importedHistory}
          openTabSessionIds={layout.openTabSessionIds}
          selectedSessionId={stageHistoryId ? null : stageSessionId}
          selectedHistoryId={stageHistoryId}
          hideLegacyPollutionSessions={layout.hideLegacyPollutionSessions}
          organizingTitles={organizing}
          organizingTarget={organizingTarget}
          organizeCooldownSec={organizeCooldownSec}
          organizeQuotaLeft={organizeQuotaLeft}
          projects={preferences.projects}
          onToggleCollapse={() => void patchLayout({ leftSidebarCollapsed: true })}
          onSelectSession={(s) => void handleActivateSession(s)}
          onSelectHistory={r => void openSessionInWorkspace(r.sessionId).catch(reportError)}
          onRefreshHistory={handleRefreshHistory}
          onOpenNewSession={() => setNewSessionOpen(true)}
          onCreateSessionInProject={(cwd, mode) => void handleCreateSession(cwd, undefined, mode).catch(reportError)}
          onOrganizeTitles={(req) => handleOrganizeTitles(req)}
          onTogglePollutionVisibility={handleTogglePollution}
          onRenameSession={handleRenameSession}
          onTogglePinSession={handleTogglePin}
          onManageSession={handleManageSession}
          onCommitWidth={(w) => void patchLayout({ leftSidebarWidth: w })}
        />

        <div className="main">
          <TopBar
            sessions={tabSessions}
            layout={layout}
            focusedSessionId={focusedSessionId}
            pendingApprovals={pendingApprovals}
            onToggleLeftSidebar={() => void patchLayout({ leftSidebarCollapsed: !layout.leftSidebarCollapsed })}
            onToggleRightInspector={() => void patchLayout({ rightInspectorCollapsed: !layout.rightInspectorCollapsed })}
            onSelectTab={(id) => void handleSelectTab(id)}
            onCloseTab={(id) => void handleCloseTab(id)}
            onOpenNewSessionModal={() => setNewSessionOpen(true)}
            onChangeLayoutMode={(mode) => void patchLayout({ layoutMode: mode })}
          />

          <ComposerDrafts.Provider value={composerDrafts}>
            <SessionWorkspaceGrid
              layout={layout}
              historyIds={historyIds}
              renderHistory={(id, slot) => <ImportedHistoryPane key={id} id={id}
                defaultThoughtTrack={preferences.defaultThoughtTrack}
                onContinueInGravity={(source, cwd) => handleContinueHistory(source, cwd, slot)}
                onCloseHistoryView={() => void handleCloseTab(id)} />}
              focusedSessionId={focusedSessionId}
              sessions={sessions.filter(s => !s.archivedAt)}
              availableModels={connection.availableModels}
              messagesBySession={messagesBySession}
              pendingApprovals={pendingApprovals}
              auditLog={auditEntries}
              approvalConfig={approvalConfig}
              defaultThoughtTrack={preferences.defaultThoughtTrack}
              telemetryDashboard={telemetry}
              swarmBySession={swarmBySession}
              onCommitSplitRatio={(r) => void patchLayout({ splitRatio: r })}
              scrollMemoryRef={scrollMemoryRef}
              canTriggerDemoApproval={!isUsingNativeDesktopBridge()}
              appIcon={preferences.appIcon}
              onFocusPane={(id) => setFocusedSessionId(id)}
              onBindSlotSession={(slot, id) => void handleBindSlotSession(slot, id)}
              onOpenNewSession={() => setNewSessionOpen(true)}
              onReviseMessage={handleReviseMessage}
              onSendPrompt={handleSendPrompt}
              onCancelPrompt={handleCancelPrompt}
              onCompactContext={handleCompact}
              onSetSessionMode={handleSetSessionMode}
              onSetSessionEffort={handleSetEffort}
              onSetSessionModel={handleSetModel}
              onQueryWorkspaceFiles={handleQueryFiles}
              onSubmitApproval={handleSubmitApproval}
              onCycleApprovalMode={handleSetApprovalMode}
              onOpenApprovalSettings={() => setSettingsSection('approvals')}
              onOpenSwarmInspector={(id) => openInspectorAt(id, 'swarm')}
              onOpenContextInspector={(id) => openInspectorAt(id, 'context')}
              onInspectDiffFile={(id, fp) => openInspectorAt(id, 'diff', fp)}
              onTriggerDemoApproval={handleTriggerDemoApproval}
            />
          </ComposerDrafts.Provider>
        </div>

        <RightInspector
          profileId={preferences.activeProfileId}
          collapsed={layout.rightInspectorCollapsed}
          width={layout.rightInspectorWidth}
          activeTab={layout.activeInspectorTab}
          focusedDiffFile={focusedDiffFile}
          sessionId={stageSessionId}
          inspectorData={stageSessionId ? inspectorBySession[stageSessionId] : undefined}
          sessionMessages={stageSessionId ? messagesBySession[stageSessionId] ?? [] : []}
          telemetry={telemetry}
          swarmTopology={stageSessionId ? swarmBySession[stageSessionId] : undefined}
          onSelectTab={(tab) => void patchLayout({ activeInspectorTab: tab })}
          onFocusDiffFile={(fp) => setFocusedDiffFile(fp)}
          onCommitWidth={(w) => void patchLayout({ rightInspectorWidth: w })}
          onCollapse={() => void patchLayout({ rightInspectorCollapsed: true })}
          onLaunchSwarmTask={handleLaunchSwarmTask}
          onOpenRateCardsSettings={() => setSettingsSection('rates')}
        />

        {settingsSection && (
          <SettingsView
            section={settingsSection}
            preferences={preferences}
            connection={connection}
            accounts={accounts}
            approvalConfig={approvalConfig}
            auditEntries={auditEntries}
            plugins={pluginsSnap}
            rateCards={telemetry.rateCards}
            onSectionChange={setSettingsSection}
            onClose={() => setSettingsSection(null)}
            onUpdatePreferences={handleUpdatePreferences}
            onSetAppIcon={handleSetAppIcon}
            onImportCustomTheme={handleImportTheme}
            onExportCustomTheme={handleExportTheme}
            onUpdateRateCards={handleUpdateRates}
            onCreateProfile={handleCreateProfile}
            onSwitchProfile={handleSwitchProfile}
            onDeleteProfile={handleDeleteProfile}
            onLaunchLogin={handleLaunchLogin}
            onLogout={handleLogout}
            onUpdateApprovalConfig={handleUpdateApprovalConfig}
            onRefreshPlugins={handleRefreshPlugins}
            onRunPluginAction={handleRunPluginAction}
            onRunMcpAction={handleRunMcpAction}
            onToggleSkill={handleToggleSkill}
            onQuickCreateInProject={(cwd, mode) => handleCreateSession(cwd, undefined, mode)}
          />
        )}

        <TitleOrganizerModal
          open={organizeOpen}
          result={organizeResult}
          cooldownSec={organizeCooldownSec}
          onClose={() => setOrganizeOpen(false)}
          onRunOrganize={handleOrganizeTitles}
        />

        <NewSessionModal
          open={newSessionOpen}
          configuredDefaultCwd={preferences.defaultWorkspaceCwd}
          projects={preferences.projects}
          defaultCwd={
            preferences.defaultWorkspaceCwd ||
            recentCwds.find((c) => c === sessions.find((s) => s.sessionId === stageSessionId)?.cwd) ||
            recentCwds[0] ||
            ''
          }
          recentCwds={recentCwds}
          onClose={() => setNewSessionOpen(false)}
          onCreate={handleCreateSession}
          onSaveDefaultCwd={async (nextDefault) => {
            await handleUpdatePreferences({ defaultWorkspaceCwd: nextDefault });
          }}
          onSaveProject={async (proj) => {
            const existing = preferences.projects ?? [];
            await handleUpdatePreferences({
              projects: [proj, ...existing.filter((p) => p.path.toLowerCase() !== proj.path.toLowerCase())],
            });
          }}
          onOpenProjectsSettings={() => setSettingsSection('projects')}
        />

        {toast && (
          <div key={toast.id} className={`toast tone-${toast.tone}`} role="status" data-testid="app-toast"
            style={{ '--toast-life': toast.tone === 'error' ? '5200ms' : '3200ms' } as React.CSSProperties}>
            {toast.tone === 'error' ? <AlertCircle size={15} /> : toast.tone === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />}
            <span>{toast.message}</span>
            <button type="button" className="icon-btn icon-btn-sm toast-close" onClick={dismissToast}
              aria-label={UI_DICTIONARIES[preferences.locale].closeAction}>
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    </I18nProvider>
  );
}

export default App;
