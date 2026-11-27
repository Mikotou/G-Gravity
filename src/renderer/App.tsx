import { getComponentCopy } from './i18n/domains/copy';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import {
  APP_BRAND,
  APPROVAL_MODE_ORDER,
  normalizeProjectCompareKey,
  DEFAULT_APPROVAL_CONFIG,
  emptyMessagePosition,
  clampUiScale,
  DEFAULT_MODEL_RATE_CARDS,
  DEFAULT_TRANSLATION_CONFIG,
  SAFE_CYCLE_EXECUTION_MODES,
  GRAVITY_BUILTIN_CAPABILITIES,
  isExternalReviewerConnected,
  isExternalTranslatorConnected,
  isTempExtractionDir,
  MAX_PARALLEL_ACTIVE_SESSIONS, placeSession, workspaceSlots, withoutSessionPatch,
  mergeTelemetryDashboard,
  TITLE_ORGANIZE_MODEL_LABEL,
  TITLE_ORGANIZE_RATE_LIMIT,
  UI_SCALE_LIMITS,
  uiScaleCommandForKey,
  type UiScaleCommand,
  type AccountsStateSnapshot,
  type AcpConnectionStatus,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type AppUpdateState,
  type ApprovalAuditEntry,
  type ApprovalDecisionSubmission,
  type ApprovalMode,
  type ApprovalReviewingEvent,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientLocale,
  type ClientPreferences,
  type ConversationMessagePage,
  type ConversationTreeState,
  type GravityIconPreference,
  type ManagedSessionSummary,
  type MessagePagePosition,
  type McpActionInput,
  type ModelRateCard,
  type PendingApprovalRequest,
  type PluginActionInput,
  type PluginsManagerSnapshot,
  type ReviseMessageInput,
  type RightInspectorTab,
  type SendPromptInput,
  type SessionAction,
  type SessionInspectorData,
  type SwarmTopologyState,
  type SwarmHistoryCursor,
  type TelemetryDashboardSnapshot,
  type TitleOrganizeRequest,
  type TitleOrganizeResult,
  type TokenCostSummary,
  type TranslationConfig,
  type TranslationConfigPatch,
  type WorkspaceLayoutState,
  type WorkspaceSplitMode,
} from '@shared';
import { ActivityRail } from './components/ActivityRail';
import { NewSessionModal, type NewSessionCreateOptions } from './components/NewSessionModal';
import { buildNewSessionModelOptions, resolveCreateModelId } from './lib/model-options';
import { useStableCallbacks } from './hooks/useStableCallbacks';
import { ComposerDrafts } from './lib/composer-draft';
import { clearAnnotationDraft } from './lib/annotation-drafts';
import { clearDismissedQuestionsForSession } from './lib/dismissed-questions';
import { ProjectSidebar } from './components/ProjectSidebar';
import { RightInspector, readInspectorFloating } from './components/RightInspector';
import { SwarmDrafts } from './components/SwarmPanel';
import type { ContextInspectorViewMode } from './components/ContextCostInspectorView';
import { SessionWorkspaceGrid } from './components/SessionWorkspaceGrid';
import { SettingsView, type SettingsSection } from './components/SettingsView';
import type { ApprovalTab } from './components/settings/WorkspacePanels';
import { TitleOrganizerModal } from './components/TitleOrganizerModal';
import { TopBar } from './components/TopBar';
import { I18nProvider } from './i18n/I18nContext';
import { isImeComposing, isPrimaryModifier } from './lib/platform-keys';
import { formatActionError, UI_DICTIONARIES, stripIpcErrorPrefix } from './i18n/locales';
import { getDesktopBridge } from './services/desktop-bridge';
import { WorkspaceWritersContext, type WorkspaceWriters } from './lib/workspace-writers';
import { clearLocalTargetInspectionCache } from './components/MediaGallery';
import {
  applyDocumentFavicon,
  applyThemePreference,
  resolveGravityIconVariant,
  subscribeSystemThemeChange,
} from './styles/theme';
import { Icon } from './components/ui/Icon';

const SPLIT_CYCLE: readonly WorkspaceSplitMode[] = ['single', 'split-2'];
/** 窄窗双栏保护阈值：视口宽度不超过该值（如 960×640 最小窗口）且处于 split-2 时自动收起停靠检视器（FE-4）。 */
const NARROW_SPLIT_MAX_VIEWPORT = 1000;
/**
 * macOS hiddenInset 交通灯（trafficLightPosition x:14）在屏幕像素中占据约 14–66px，不随页面 zoomFactor 缩放。
 * 与 --win-controls-w 一致，按缩放倍率换算成 CSS 像素，保证 80%–160% 缩放下抽屉标题与顶栏首个控件都在交通灯右侧。
 */
const MAC_TRAFFIC_LIGHT_SAFE_W = 78;

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

/** 共享空数组：避免每次渲染生成新的 `[]` 打破子组件 memo */
const EMPTY_MESSAGES: ChatMessageItem[] = [];

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' ||
    (el.tagName === 'TEXTAREA' && !el.classList.contains('composer-input')) || el.isContentEditable));
}

/**
 * F-01：焦点落在按钮、链接、页签、菜单项、分隔条等可聚焦控件上时，`Shift+Tab` 必须保持浏览器原生的焦点后退，
 * 不能被工作台模式循环吞掉（否则键盘用户无法从按钮向前移动焦点，且会误切执行模式/审批档位）。
 */
const NATIVE_FOCUS_CONTROL_SELECTOR =
  'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"], [role="switch"], [role="checkbox"], [role="separator"], [role="slider"]';
function isNativeFocusControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest(NATIVE_FOCUS_CONTROL_SELECTOR));
}

interface SessionReadUpdates {
  messages: Map<string, ChatMessageItem>;
  inspector?: SessionInspectorData;
  swarm?: SwarmTopologyState;
  tree?: ConversationTreeState;
}

export function App(): React.ReactElement {
  const [workspace, setWorkspace] = useState<{ revision: number; notice?: WorkspaceNotice }>({ revision: 0 });
  const reloadProfile = useCallback((notice?: WorkspaceNotice) => {
    // 切号后整棵工作区重新挂载：上一 Profile 的本地媒体预览缓存一并清空。
    clearLocalTargetInspectionCache();
    setWorkspace(previous => ({ revision: previous.revision + 1, notice }));
  }, []);
  return <ProfileWorkspace key={workspace.revision} reopenAccounts={workspace.revision > 0} initialNotice={workspace.notice} reloadProfile={reloadProfile} />;
}

interface WorkspaceNotice {
  message: string;
  tone: ToastTone;
}

const toastLifeMs = (tone: ToastTone) => (tone === 'error' ? 5200 : 3200);

function ProfileWorkspace({ reopenAccounts, initialNotice, reloadProfile }: {
  reopenAccounts: boolean; initialNotice?: WorkspaceNotice; reloadProfile: (notice?: WorkspaceNotice) => void;
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
  /** D2：系统明暗切换计数，驱动 `'auto'` 图标在 `theme: 'system'` 下重新解析 */
  const [systemThemeEpoch, setSystemThemeEpoch] = useState(0);
  const preferenceWrites = useRef({ sent: 0, applied: 0 });
  const zoomScale = useRef<{ confirmed: number; pending?: { id: number; value: number } }>({ confirmed: UI_SCALE_LIMITS.default });
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
  const [approvalConfig, setApprovalConfig] = useState<ApproveForMeConfig>(() => structuredClone(DEFAULT_APPROVAL_CONFIG));
  const [translationConfig, setTranslationConfig] = useState<TranslationConfig>(() =>
    structuredClone(DEFAULT_TRANSLATION_CONFIG)
  );
  const [translationSettingsFocusSeq, setTranslationSettingsFocusSeq] = useState(0);
  const [composerDrafts] = useState(() => new Map() as NonNullable<React.ContextType<typeof ComposerDrafts>>);
  const [sessions, setSessions] = useState<ManagedSessionSummary[]>([]);
  const tabSessions = useMemo(() => sessions.filter(s => !s.archivedAt), [sessions]);
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
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // 分屏时，焦点可落在任意窗格。
  // 把焦点会话与布局中的主会话分开保存，右侧检查器和快捷键才能跟随当前操作。
  const [requestedFocus, setFocusedSessionId] = useState<string | null>(null);
  // A branch switch briefly closes one session before replacing its pane. Its sibling should keep its own focus.
  const paneIds = workspaceSlots(layout);
  const focusedSessionId = requestedFocus && paneIds.includes(requestedFocus)
    ? requestedFocus : paneIds.find(id => id !== null) ?? null;
  const [focusedDiffFile, setFocusedDiffFile] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessageItem[]>>({});
  const [messagePositions, setMessagePositions] = useState<Record<string, MessagePagePosition>>({});
  const pageRequests = useRef(new Map<string, symbol>());
  const sessionReads = useRef(new Map<string, SessionReadUpdates>());
  const [inspectorBySession, setInspectorBySession] = useState<Record<string, SessionInspectorData>>({});
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalRequest[]>([]);
  // Stage 2 Guardian 正在进行的外部复核（按请求号保存，结束/转人工后移除）
  const [reviewingApprovals, setReviewingApprovals] = useState<ApprovalReviewingEvent[]>([]);
  /** F-07：启动阶段单个标签加载失败的原因，窗格内提示并可重试 */
  const [sessionLoadErrors, setSessionLoadErrors] = useState<Record<string, string>>({});
  const localeRef = useRef<ClientLocale>('zh-CN');
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
  const swarmDrafts = useMemo(() => new SwarmDrafts(), [accounts.activeProfileId]);
  const [treeByRoot, setTreeByRoot] = useState<Record<string, ConversationTreeState>>({});
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const switchingBranchRef = useRef(false);
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    status: 'idle',
    currentVersion: APP_BRAND.version,
    repoUrl: APP_BRAND.repoUrl,
    canInstallDirectly: false,
  });
  const notifiedUpdateVersionRef = useRef<string | null>(null);

  // 覆盖层
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(reopenAccounts ? 'accounts' : null);
  const [approvalSettingsTab, setApprovalSettingsTab] = useState<ApprovalTab>('rules');
  const [contextInspectorViewMode, setContextInspectorViewMode] = useState<ContextInspectorViewMode>('context');
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [organizeRequest, setOrganizeRequest] = useState<TitleOrganizeRequest>({ scope: 'all' });
  const [organizeResult, setOrganizeResult] = useState<TitleOrganizeResult | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [organizingTarget, setOrganizingTarget] = useState<string | null>(null);
  const [organizeQuotaLeft, setOrganizeQuotaLeft] = useState<number>(TITLE_ORGANIZE_RATE_LIMIT.maxCalls);
  const [organizeCooldownUntil, setOrganizeCooldownUntil] = useState<number>(0);
  const [organizeCooldownSec, setOrganizeCooldownSec] = useState<number>(0);
  const [toast, setToast] = useState<{ id: number; message: string; tone: ToastTone } | null>(
    initialNotice ? { id: 0, message: initialNotice.message, tone: initialNotice.tone } : null
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

  useEffect(() => {
    const scale = clampUiScale(preferences.uiScale);
    document.documentElement.style.setProperty('--win-controls-w', `${Math.round(138 / scale)}px`);
    document.documentElement.style.setProperty('--mac-traffic-w', `${Math.round(MAC_TRAFFIC_LIGHT_SAFE_W / scale)}px`);
  }, [preferences.uiScale]);

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
    toastTimerRef.current = setTimeout(() => setToast(null), toastLifeMs(tone));
  }, []);

  // 切号失败等重新挂载时携带的提示同样按语气倒计时自动消失（只处理挂载时的那一条）。
  useEffect(() => {
    if (!initialNotice) return undefined;
    const timer = setTimeout(() => setToast(prev => (prev?.id === 0 ? null : prev)), toastLifeMs(initialNotice.tone));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reportError = useCallback(
    (err: unknown) => showToast(formatActionError(err, UI_DICTIONARIES[preferences.locale]), 'error'),
    [preferences.locale, showToast]
  );

  localeRef.current = preferences.locale;

  const beginSessionRead = useCallback((id: string) => {
    // A slow history read can finish after a newer stream event or a second request for the same tab.
    const updates: SessionReadUpdates = { messages: new Map() };
    sessionReads.current.set(id, updates);
    return updates;
  }, []);

  const applySessionRead = useCallback((id: string, updates: SessionReadUpdates, page: ConversationMessagePage,
    inspector: SessionInspectorData, swarm: SwarmTopologyState, tree?: ConversationTreeState) => {
    if (sessionReads.current.get(id) !== updates) return;
    const { messages, ...position } = page;
    const latest = new Map(messages.map(message => [message.id, message]));
    for (const [key, message] of updates.messages) latest.set(key, message);
    const ordered = Array.from(latest.values());
    const latestTree = updates.tree ?? tree;
    pageRequests.current.delete(id);
    setMessagesBySession(prev => ({ ...prev, [id]: ordered }));
    setMessagePositions(prev => ({ ...prev, [id]: position }));
    setInspectorBySession(prev => ({ ...prev, [id]: updates.inspector ?? inspector }));
    setSwarmBySession(prev => ({ ...prev, [id]: updates.swarm ?? swarm }));
    if (latestTree) setTreeByRoot(prev => ({ ...prev, [latestTree.rootSessionId]: latestTree }));
  }, []);

  const loadSessionData = useCallback(async (id: string, includeTelemetry = true) => {
    const bridge = getDesktopBridge();
    const updates = beginSessionRead(id);
    try {
      const [page, inspector, swarm, tree, telemetry] = await Promise.all([
        bridge.getSessionMessagePage(id), bridge.getSessionInspector(id), bridge.getSwarmState(id),
        bridge.getConversationTree(id).catch(() => undefined),
        includeTelemetry ? bridge.getTelemetryDashboard() : undefined,
      ]);
      if (sessionReads.current.get(id) !== updates) return;
      applySessionRead(id, updates, page, inspector, swarm, tree);
      if (telemetry) setTelemetry(prev => mergeTelemetryDashboard(prev, telemetry));
    } finally {
      if (sessionReads.current.get(id) === updates) sessionReads.current.delete(id);
    }
  }, [applySessionRead, beginSessionRead]);

  /* ---------------------------------------------------------------- 启动与订阅 */
  useEffect(() => {
    let cancelled = false;
    const bridge = getDesktopBridge();
    let earlyApprovals: Map<string, PendingApprovalRequest | null> | undefined = new Map();
    // APR-01：启动快照落地前已结束（完成 / 取消 / 已裁决）的复核请求，避免快照把它们重新挂回界面。
    let earlyReviewsSettled: Set<string> | undefined = new Set();
    let earlyApprovalConfig: ApproveForMeConfig | undefined;
    let earlyConnection: AcpConnectionStatus | undefined;
    let earlySessions: Map<string, ManagedSessionSummary> | undefined = new Map();
    // 启动快照应用前到达的账号、更新状态与翻译配置推送比快照更新，快照落地时以推送值为准。
    let booting = true;
    let earlyAccounts: AccountsStateSnapshot | undefined;
    let earlyUpdateState: AppUpdateState | undefined;
    let earlyTranslationConfig: TranslationConfig | undefined;
    let auditRead = 0;

    async function bootstrap(): Promise<void> {
      setBootstrapError(null);
      try {
        const boot = await bridge.getBootstrap();
        if (cancelled) return;
        applyThemePreference(boot.preferences.theme, boot.preferences.customTheme);
        applyDocumentFavicon(boot.preferences.appIcon, boot.preferences.theme, boot.preferences.customTheme);
        document.documentElement.lang = boot.preferences.locale;
        document.documentElement.dataset.windowChrome = boot.windowChrome || 'standard';
        // v0.3.2：macOS 专属排版与表面阶梯以 data-platform="darwin" 为作用域（mac-inset 窗口必为 macOS，其余按 UA 判定）。
        document.documentElement.dataset.platform =
          boot.windowChrome === 'mac-inset' || /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'darwin' : 'other';
        const initScale = clampUiScale(boot.preferences.uiScale);
        document.documentElement.style.setProperty('--win-controls-w', `${Math.round(138 / initScale)}px`);
        document.documentElement.style.setProperty('--mac-traffic-w', `${Math.round(MAC_TRAFFIC_LIGHT_SAFE_W / initScale)}px`);
        // 将主进程持久化偏好镜像回 localStorage，避免便携版每次更新解包到新临时路径时丢失界面习惯。
        try {
          if (boot.preferences.thoughtExpandedByDefault !== undefined) {
            window.localStorage.setItem('gravity.thoughts.expanded', boot.preferences.thoughtExpandedByDefault ? 'true' : 'false');
          }
          if (boot.layout.inspectorFloating !== undefined) {
            window.localStorage.setItem('gravity.inspector.floating', boot.layout.inspectorFloating ? 'true' : 'false');
          }
          if (boot.layout.composerMinHeight !== undefined) {
            window.localStorage.setItem('gravity.composer.minHeight', String(Math.round(boot.layout.composerMinHeight)));
          }
        } catch {
          /* ignore storage unavailable */
        }

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
        const validOpenIds = boot.layout.openTabSessionIds.filter(id => resumedMap.has(id));
        const primaryId =
          boot.layout.activePrimarySessionId && validOpenIds.includes(boot.layout.activePrimarySessionId)
            ? boot.layout.activePrimarySessionId
            : validOpenIds[0] ?? null;

        const finalSessions = mergedSessions.map((s) => earlySessions?.get(s.sessionId) ?? s);
        if (earlySessions) {
          const knownIds = new Set(finalSessions.map((s) => s.sessionId));
          for (const updated of earlySessions.values()) {
            if (!knownIds.has(updated.sessionId)) finalSessions.unshift(updated);
          }
        }
        const finalConnection = earlyConnection ?? boot.connection;
        earlySessions = undefined;
        earlyConnection = undefined;

        zoomScale.current.confirmed = initScale;
        booting = false;
        setPreferences(boot.preferences);
        setConnection(finalConnection);
        setAccounts(earlyAccounts ?? boot.accounts);
        setApprovalConfig(earlyApprovalConfig ?? boot.approvalConfig);
        const finalTranslationConfig = earlyTranslationConfig ?? boot.translationConfig;
        if (finalTranslationConfig) setTranslationConfig(finalTranslationConfig);
        setSessions(finalSessions);
        setLayout({
          ...boot.layout,
          openTabSessionIds: validOpenIds,
          activePrimarySessionId: primaryId,
        });
        setFocusedSessionId(primaryId);
        const approvals = new Map(boot.pendingApprovals.map(card => [card.requestId, card]));
        for (const [id, card] of earlyApprovals ?? []) {
          if (card) approvals.set(id, card);
          else approvals.delete(id);
        }
        earlyApprovals = undefined;
        setPendingApprovals([...approvals.values()]);
        // APR-01：重载窗口 / macOS Dock 重开后恢复进行中的二阶段外部复核卡片，与实时事件按 requestId 去重合并（实时事件优先）。
        const settledReviews = earlyReviewsSettled ?? new Set<string>();
        earlyReviewsSettled = undefined;
        const bootReviews = (boot.activeReviews ?? []).filter(
          (r) => r.status === 'reviewing' && !settledReviews.has(r.requestId)
        );
        if (bootReviews.length > 0) {
          setReviewingApprovals((prev) => {
            const merged = new Map<string, ApprovalReviewingEvent>();
            for (const r of bootReviews) merged.set(r.requestId, r);
            for (const r of prev) merged.set(r.requestId, r);
            return [...merged.values()];
          });
        }
        setPluginsSnap(boot.plugins);
        const finalUpdateState = earlyUpdateState ?? boot.updateState;
        if (finalUpdateState) setUpdateState(finalUpdateState);
        earlyAccounts = undefined;
        earlyUpdateState = undefined;
        earlyTranslationConfig = undefined;

        // 启动快照只列会话摘要。并行拉取已打开标签的消息、检视数据、分支树和协作看板，按会话号放回各自的缓存。
        // F-07：单个标签读取失败只在该窗格内提示并可重试，不再让整个工作台停留在启动失败页。
        const [audits, freshTele, ...tabLoads] = await Promise.allSettled([
          bridge.listApprovalAudit(50),
          bridge.getTelemetryDashboard().catch(() => boot.telemetry),
          ...openSessions.map(s => loadSessionData(s.sessionId, false)),
        ]);
        if (cancelled) return;
        const loadErrors: Record<string, string> = {};
        tabLoads.forEach((result, index) => {
          if (result.status === 'rejected') {
            loadErrors[openSessions[index].sessionId] = stripIpcErrorPrefix(result.reason);
          }
        });
        setSessionLoadErrors(loadErrors);
        if (freshTele.status === 'fulfilled') setTelemetry(previous => mergeTelemetryDashboard(previous, freshTele.value));
        if (!auditRead && audits.status === 'fulfilled') setAuditEntries(audits.value);
        setReady(true);
      } catch (err) {
        if (!cancelled) setBootstrapError(formatActionError(err, UI_DICTIONARIES[localeRef.current]));
      }
    }
    void bootstrap();

    const offs = [
      bridge.onSessionUpdated((updated) => {
        earlySessions?.set(updated.sessionId, updated);
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.sessionId === updated.sessionId);
          if (idx === -1) return [updated, ...prev];
          const copy = [...prev];
          copy[idx] = updated;
          return copy;
        });
      }),
      // 流式事件携带更新后的整条消息。
      // 已有 ID 替换该会话里的旧条目，首次出现才追加，避免每个分片产生一个气泡。
      bridge.onMessageUpserted(({ sessionId, message }) => {
        sessionReads.current.get(sessionId)?.messages.set(message.id, message);
        setMessagesBySession((prev) => {
          const list = prev[sessionId] ?? [];
          const idx = list.findIndex((m) => m.id === message.id);
          if (idx === -1) return { ...prev, [sessionId]: [...list, message] };
          const copy = [...list];
          copy[idx] = message;
          return { ...prev, [sessionId]: copy };
        });
      }),
      bridge.onInspectorUpdated(data => {
        const read = sessionReads.current.get(data.sessionId);
        if (read) read.inspector = data;
        setInspectorBySession(prev => ({ ...prev, [data.sessionId]: data }));
      }),
      bridge.onApprovalRequested((req) => {
        earlyApprovals?.set(req.requestId, req);
        setPendingApprovals((prev) => {
          const idx = prev.findIndex((p) => p.requestId === req.requestId);
          if (idx === -1) return [...prev, req];
          const copy = [...prev];
          copy[idx] = req;
          return copy;
        });
      }),
      ...(typeof bridge.onApprovalReviewing === 'function'
        ? [bridge.onApprovalReviewing((event) => {
            if (event.status !== 'reviewing') earlyReviewsSettled?.add(event.requestId);
            setReviewingApprovals((prev) => {
              const rest = prev.filter((item) => item.requestId !== event.requestId);
              return event.status === 'reviewing' ? [...rest, event] : rest;
            });
          })]
        : []),
      bridge.onApprovalConfigUpdated(cfg => {
        if (earlyApprovals) earlyApprovalConfig = cfg;
        setApprovalConfig(cfg);
      }),
      bridge.onApprovalResolved(({ requestId }) => {
        earlyApprovals?.set(requestId, null);
        earlyReviewsSettled?.add(requestId);
        const read = ++auditRead;
        setPendingApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
        setReviewingApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
        void bridge
          .listApprovalAudit(50)
          .then((list) => {
            if (!cancelled && read === auditRead) setAuditEntries(list);
          })
          .catch(() => {});
      }),
      bridge.onTelemetryUpdated((snap) => setTelemetry(previous => mergeTelemetryDashboard(previous, snap))),
      bridge.onSwarmUpdated(topo => {
        const read = sessionReads.current.get(topo.sessionId);
        if (read) read.swarm = topo;
        setSwarmBySession(prev => ({ ...prev, [topo.sessionId]: topo }));
      }),
      bridge.onAccountUpdated((state) => {
        if (booting) earlyAccounts = state;
        setAccounts(state);
      }),
      bridge.onUpdateState((next) => {
        if (booting) earlyUpdateState = next;
        setUpdateState(next);
      }),
      bridge.onTreeUpdated(tree => {
        for (const [id, read] of sessionReads.current) {
          if (tree.rootSessionId === id || Object.hasOwn(tree.nodesById, id)) read.tree = tree;
        }
        setTreeByRoot(prev => ({ ...prev, [tree.rootSessionId]: tree }));
      }),
      ...(typeof bridge.onTranslationConfigUpdated === 'function'
        ? [bridge.onTranslationConfigUpdated((cfg) => {
            if (booting) earlyTranslationConfig = cfg;
            setTranslationConfig(cfg);
          })]
        : []),
      // ACP 断连、限流冷却与重连实时推送，状态点与诊断卡片不再停留在过期的「已连接」。
      ...(typeof bridge.onConnectionUpdated === 'function'
        ? [bridge.onConnectionUpdated((status) => {
            if (cancelled) return;
            if (earlySessions) earlyConnection = status;
            setConnection(status);
          })]
        : []),
    ];
    // 注销窗口事件的同时，让尚未完成的启动请求识别卸载状态，避免继续应用其最终结果。
    return () => {
      cancelled = true;
      sessionReads.current.clear();
      offs.forEach((off) => off());
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [bootstrapAttempt, loadSessionData]);

  // 只有跟随系统的模式订阅明暗变化。切到固定或自定义主题时，React 会先移除上一次订阅。
  useEffect(() => {
    applyThemePreference(preferences.theme, preferences.customTheme);
    if (preferences.theme === 'system')
      return subscribeSystemThemeChange(() => {
        applyThemePreference('system');
        // D2：跟随系统明暗时，'auto' 图标需随之重新解析。
        setSystemThemeEpoch((n) => n + 1);
      });
    return undefined;
  }, [preferences.theme, preferences.customTheme]);

  useEffect(() => {
    applyDocumentFavicon(preferences.appIcon, preferences.theme, preferences.customTheme);
  }, [preferences.appIcon, preferences.theme, preferences.customTheme, systemThemeEpoch]);

  useEffect(() => {
    document.documentElement.lang = preferences.locale;
  }, [preferences.locale]);

  useEffect(() => {
    if (
      updateState.status === 'available' &&
      updateState.latestVersion &&
      notifiedUpdateVersionRef.current !== updateState.latestVersion
    ) {
      notifiedUpdateVersionRef.current = updateState.latestVersion;
      showToast(UI_DICTIONARIES[preferences.locale].updatesToastAvailable(updateState.latestVersion), 'info');
    }
  }, [preferences.locale, showToast, updateState.latestVersion, updateState.status]);

  /* ---------------------------------------------------------------- 布局 */
  /*
   * FE-4（v0.3.4 macOS 真机 QA）：窄窗（视口 <= 1080px）进入 split-2 双栏时，停靠检视器会把单栏挤到 ~145px，
   * 导致 Composer 右侧操作区与底部 ctx 被裁切。仅在「刚进入窄窗双栏」这一刻临时收起停靠检视器（不写入持久化布局），
   * 离开窄窗双栏即自动恢复；用户任何显式展开 / 收起操作都会立即解除临时收起，不会被反复抢占。
   * 悬浮检视器不占栏宽，保持不动；超窄窗格仍由 composer.css 的 @container pane 紧凑排版兜底。
   */
  const [narrowSplitAutoCollapsed, setNarrowSplitAutoCollapsed] = useState(false);
  const patchLayout = useCallback(
    async (patch: Partial<WorkspaceLayoutState>) => {
      if ('rightInspectorCollapsed' in patch) setNarrowSplitAutoCollapsed(false);
      try {
        const next = await getDesktopBridge().saveWorkspaceLayout(patch);
        layoutRef.current = next;
        setLayout(next);
      } catch (err) {
        reportError(err);
      }
    },
    [reportError]
  );

  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const narrowSplit = layout.layoutMode === 'split-2' && viewportWidth <= NARROW_SPLIT_MAX_VIEWPORT;
  const narrowSplitRef = useRef(false);
  useEffect(() => {
    const entered = narrowSplit && !narrowSplitRef.current;
    narrowSplitRef.current = narrowSplit;
    if (!narrowSplit) setNarrowSplitAutoCollapsed(false);
    else if (entered && !layout.rightInspectorCollapsed && !(layout.inspectorFloating ?? readInspectorFloating())) {
      setNarrowSplitAutoCollapsed(true);
    }
  }, [narrowSplit, layout.rightInspectorCollapsed, layout.inspectorFloating]);
  const inspectorCollapsed = layout.rightInspectorCollapsed || narrowSplitAutoCollapsed;
  const topBarLayout = useMemo(
    () => (narrowSplitAutoCollapsed ? { ...layout, rightInspectorCollapsed: true } : layout),
    [layout, narrowSplitAutoCollapsed]
  );

  const loadEarlierMessages = async (id: string): Promise<boolean> => {
    const before = messagePositions[id]?.earlierCount;
    if (!before || pageRequests.current.has(id)) return false;
    const request = Symbol();
    pageRequests.current.set(id, request);
    try {
      const { messages, ...position } = await getDesktopBridge().getSessionMessagePage(id, before);
      if (pageRequests.current.get(id) !== request) return false;
      setMessagesBySession(previous => {
        const current = previous[id] || [];
        const visible = new Set(current.map(m => m.id));
        return { ...previous, [id]: [...messages.filter(m => !visible.has(m.id)), ...current] };
      });
      setMessagePositions(previous => ({ ...previous, [id]: position }));
      return true;
    } catch (err) {
      if (pageRequests.current.get(id) === request) reportError(err);
      return false;
    } finally {
      if (pageRequests.current.get(id) === request) pageRequests.current.delete(id);
    }
  };

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

  const openApprovalSettings = useCallback((initialTab: ApprovalTab = 'rules') => {
    setApprovalSettingsTab(initialTab);
    setSettingsSection('approvals');
  }, []);

  const handleSetApprovalMode = useCallback(
    async (mode: ApprovalMode) => {
      if (mode === 'hybrid' && !isExternalReviewerConnected(approvalConfig.externalReviewer)) {
        showToast(
          preferences.locale === 'zh-CN'
            ? '尚未连接外部复核模型，无法开启「AI 代审」，请先前往「外部复核」完成连接'
            : 'Connect an external reviewer API first to enable AI Review mode',
          'error'
        );
        openApprovalSettings('reviewer');
        return;
      }
      try {
        setApprovalConfig(await getDesktopBridge().setApprovalMode(mode));
      } catch (err) {
        reportError(err);
      }
    },
    [approvalConfig.externalReviewer, openApprovalSettings, preferences.locale, reportError, showToast]
  );

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

  const handleSelectTab = useCallback(
    async (sessionId: string) => {
      if (workspaceSlots(layout).includes(sessionId)) {
        setFocusedSessionId(sessionId);
        return;
      }
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (target && target.status === 'closed' && !target.readOnly) await handleActivateSession(target);
      else if (target) await openSessionInWorkspace(sessionId).catch(reportError);
    },
    [handleActivateSession, openSessionInWorkspace, layout, sessions, reportError]
  );

  const handleCloseTab = useCallback(
    (sessionId: string) => {
      const profile = profileRef.current;
      // 与打开/放置会话共用同一个队列：关闭标签读取的是排队到达时的最新布局，避免与并发的放置请求互相覆盖。
      const apply = async () => {
        if (profile !== profileRef.current) return;
        const bridge = getDesktopBridge();
        // 先让主进程关闭会话，再保存剩余标签。如果关掉主标签，还要从余下标签中选出新的主会话。
        await bridge.closeSession(sessionId);
        composerDrafts.delete(sessionId);
        if (profile !== profileRef.current) return;
        // 仅提交标签三元组，不回写整份布局，避免用旧快照覆盖 composerMinHeight 等其他字段。
        const next = await bridge.saveWorkspaceLayout(withoutSessionPatch(layoutRef.current, sessionId));
        if (profile !== profileRef.current) return;
        layoutRef.current = next;
        setLayout(next);
        setFocusedSessionId((prev) => (prev === sessionId ? next.activePrimarySessionId : prev));
      };
      const result = placementQueue.current.then(apply);
      placementQueue.current = result.catch(() => {});
      return result.catch(reportError);
    },
    [composerDrafts, reportError]
  );

  /** 断连或出错的会话：重新拉起官方 agy 并恢复当前对话（错误交给调用方的诊断卡片显示）。 */
  const handleReconnectSession = useCallback(
    async (sessionId: string) => {
      const bridge = getDesktopBridge();
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (!target) return;
      const resumed = await bridge.resumeSession(sessionId, target.cwd);
      replaceSession(resumed);
      void bridge.getConnectionStatus().then(setConnection).catch(() => {});
      await loadSessionData(resumed.sessionId);
    },
    [loadSessionData, replaceSession, sessions]
  );

  const handleManageSession = async (id: string, action: SessionAction) => {
    const result = await getDesktopBridge().manageSession(id, action);
    setSessions(result.sessions);
    layoutRef.current = result.layout;
    setLayout(result.layout);
    const remainingIds = new Set(result.sessions.map(s => s.sessionId));
    if (action !== 'restore' && focusedSessionId && (!remainingIds.has(focusedSessionId) || result.sessions.find(s => s.sessionId === focusedSessionId)?.archivedAt)) {
      setFocusedSessionId(result.layout.activePrimarySessionId);
    }
    if (action === 'delete') {
      swarmDrafts.keepSessions(remainingIds);
      composerDrafts.delete(id);
      clearAnnotationDraft(accounts.activeProfileId, id);
      clearDismissedQuestionsForSession(accounts.activeProfileId, id);
      try { localStorage.removeItem('gravity.terminal.read.' + accounts.activeProfileId + '.' + id); } catch { /* optional storage */ }
      clearLocalTargetInspectionCache();
      setMessagesBySession(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => remainingIds.has(k))));
      setMessagePositions(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => remainingIds.has(k))));
      for (const key of pageRequests.current.keys()) if (!remainingIds.has(key)) pageRequests.current.delete(key);
      for (const key of sessionReads.current.keys()) if (!remainingIds.has(key)) sessionReads.current.delete(key);
      setInspectorBySession(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => remainingIds.has(k))));
      setSwarmBySession(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => remainingIds.has(k))));
      setTreeByRoot(prev => Object.fromEntries(Object.entries(prev).filter(([rootId]) => remainingIds.has(rootId))));
    }
  };

  const handleBindSlotSession = useCallback(
    async (slotIndex: number, sessionId: string) => {
      try {
        const bridge = getDesktopBridge();
        const target = sessions.find((s) => s.sessionId === sessionId);
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
    [loadSessionData, openSessionInWorkspace, preferences.activeProfileId, replaceSession, reportError, sessions]
  );

  const handleRetrySessionLoad = useCallback(
    (sessionId: string) => {
      void loadSessionData(sessionId)
        .then(() =>
          setSessionLoadErrors((prev) => {
            if (!(sessionId in prev)) return prev;
            const next = { ...prev };
            delete next[sessionId];
            return next;
          })
        )
        .catch((err) => setSessionLoadErrors((prev) => ({ ...prev, [sessionId]: stripIpcErrorPrefix(err) })));
    },
    [loadSessionData]
  );

  /** U-02：可选模型目录（连接快照 + 现有非污染会话去重），新建弹窗与欢迎卡片共用。 */
  const newSessionModels = useMemo(
    () => buildNewSessionModelOptions(connection.availableModels, sessions),
    [connection.availableModels, sessions]
  );
  const projectsRef = useRef(preferences.projects);
  projectsRef.current = preferences.projects;
  const newSessionModelsRef = useRef(newSessionModels);
  newSessionModelsRef.current = newSessionModels;

  const handleCreateSession = useCallback(
    async (
      cwd: string,
      title?: string,
      executionMode?: AgentExecutionMode,
      options?: NewSessionCreateOptions
    ) => {
      const bridge = getDesktopBridge();
      const key = normalizeProjectCompareKey(cwd);
      const project = (projectsRef.current ?? []).find((p) => normalizeProjectCompareKey(p.path) === key);
      const modelId = resolveCreateModelId(options?.modelId, project?.defaultModelId, newSessionModelsRef.current);
      const created = await bridge.createSession({
        cwd,
        ...(title ? { title } : {}),
        ...(executionMode ? { executionMode } : {}),
        ...(modelId ? { modelId } : {}),
        ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      });

      replaceSession(created);
      void bridge.getConnectionStatus().then(setConnection).catch(() => {});
      void bridge.getAccountsState().then(setAccounts).catch(() => {});
      await loadSessionData(created.sessionId);
      await openSessionInWorkspace(created.sessionId);
    },
    [openSessionInWorkspace, loadSessionData, replaceSession]
  );

  /** 欢迎页直达：在所选目录新建会话，并把首句作为第一条消息立即发送。 */
  const handleQuickStart = useCallback(
    async (cwd: string, text: string, slotIndex?: number, options?: NewSessionCreateOptions) => {
      const bridge = getDesktopBridge();
      const key = normalizeProjectCompareKey(cwd);
      const project = (projectsRef.current ?? []).find((p) => normalizeProjectCompareKey(p.path) === key);
      const modelId = resolveCreateModelId(options?.modelId, project?.defaultModelId, newSessionModelsRef.current);
      const created = await bridge.createSession({
        cwd,
        ...(project?.defaultMode ? { executionMode: project.defaultMode } : {}),
        ...(modelId ? { modelId } : {}),
        ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      });
      replaceSession(created);
      void bridge.getConnectionStatus().then(setConnection).catch(() => {});
      void bridge.getAccountsState().then(setAccounts).catch(() => {});
      await loadSessionData(created.sessionId);
      await openSessionInWorkspace(created.sessionId, slotIndex);
      // 会话已打开后欢迎卡片随即卸载，首句发送失败改由全局轻提示告知；已挂载的输入框保留这句草稿便于重发。
      await bridge.sendPrompt({ sessionId: created.sessionId, text }).catch((err) => {
        composerDrafts.get(created.sessionId)?.set('text', (prev: string) => prev || text);
        reportError(err);
      });
    },
    [composerDrafts, openSessionInWorkspace, loadSessionData, replaceSession, reportError]
  );

  const handleSelectDirectory = useCallback(
    async (defaultPath?: string) => getDesktopBridge().selectDirectory(defaultPath),
    []
  );

  const handleCancelStage2Review = useCallback(async (requestId: string) => {
    const result = await getDesktopBridge().cancelStage2ApprovalReview(requestId);
    // 主进程确认中止后会推送 cancelled 事件；这里同步移除卡片，避免等待事件期间重复点击。
    if (result.cancelled) setReviewingApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
  }, []);

  const handleOrganizeTitles = useCallback(
    async (request: TitleOrganizeRequest = { scope: 'all' }, fromModal = false) => {
      const bridge = getDesktopBridge();
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
      try {
        const res = await bridge.organizeTitles({ ...request, scope });
        const remaining = res.remainingQuotaInWindow ?? TITLE_ORGANIZE_RATE_LIMIT.maxCalls;
        setOrganizeQuotaLeft(remaining);
        if (remaining <= 0 && res.cooldownResetAt) {
          const until = Date.parse(res.cooldownResetAt);
          if (Number.isFinite(until) && until > Date.now()) setOrganizeCooldownUntil(until);
        }
        const modelLabel = res.modelUsed || TITLE_ORGANIZE_MODEL_LABEL;
        if (!fromModal) setOrganizeRequest({ ...request, scope });
        if (scope === 'session' && !fromModal) {
          const suggestion = res.suggestions[0];
          showToast(
            suggestion
              ? preferences.locale === 'zh-CN'
                ? `已通过 ${modelLabel} 整理为「${suggestion.organizedTitle}」`
                : `Organized with ${modelLabel}: "${suggestion.organizedTitle}"`
              : !res.modelUsed || res.skippedChangedCount
                ? (preferences.locale === 'zh-CN' ? '已保留当前标题' : 'Current title preserved')
              : preferences.locale === 'zh-CN'
                ? `${modelLabel} 已核对，该会话标题无需调整`
                : `Checked with ${modelLabel} — no title change needed`,
            'success'
          );
        } else {
          setOrganizeResult(res);
          if (!fromModal) setOrganizeOpen(true);
        }
      } catch (err) {
        const msg = stripIpcErrorPrefix(err);
        // 兼容中英文冷却提示：「请 30 秒后」「retry in 30s」「wait 30 seconds」「after 30 sec」
        const waitMatch = /请\s*(\d+)\s*秒后|(?:in|after|wait(?:\s+for)?)\s+(\d+)\s*(?:s\b|secs?\b|seconds?\b)/i.exec(msg);
        const waitSec = waitMatch ? Number(waitMatch[1] ?? waitMatch[2]) : NaN;
        if (Number.isFinite(waitSec) && waitSec > 0) {
          setOrganizeQuotaLeft(0);
          setOrganizeCooldownUntil(Date.now() + waitSec * 1000);
        }
        if (fromModal) throw err;
        reportError(err);
      } finally {
        setOrganizing(false);
        setOrganizingTarget(null);
      }
    },
    [preferences.locale, reportError, showToast]
  );

  const handleTogglePollution = useCallback(async () => {
    try {
      const bridge = getDesktopBridge();
      const nextHide = !layout.hideLegacyPollutionSessions;
      const [nextLayout, list] = await Promise.all([
        bridge.saveWorkspaceLayout({ hideLegacyPollutionSessions: nextHide }),
        bridge.listSessions(true),
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
        const updated = await getDesktopBridge().renameSession(sessionId, title);
        if (updated.profileId === profileRef.current) replaceSession(updated);
      } catch (err) {
        reportError(err);
        throw err;
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

  const handleReviseMessage = useCallback(async (input: ReviseMessageInput) => {
    const profile = profileRef.current;
    const bridge = getDesktopBridge();
    const branch = await bridge.reviseMessage(input);
    if (profile !== profileRef.current) return;
    replaceSession(branch);
    await loadSessionData(branch.sessionId);
    // 与打开/关闭标签共用放置队列：替换分支时读取排队到达时的最新布局。
    const apply = async () => {
      if (profile !== profileRef.current) return;
      const curLayout = layoutRef.current;
      const replace = (id: string | null) => (id === input.sessionId ? branch.sessionId : id);
      const nextTabs = [...new Set(curLayout.openTabSessionIds.map((id) => replace(id)!))];
      const savedLayout = await bridge.saveWorkspaceLayout({
        openTabSessionIds: nextTabs,
        activePrimarySessionId: replace(curLayout.activePrimarySessionId),
        splitSecondarySessionId: replace(curLayout.splitSecondarySessionId),
      });
      if (profile !== profileRef.current) return;
      layoutRef.current = savedLayout;
      setLayout(savedLayout);
      setFocusedSessionId(branch.sessionId);
    };
    const result = placementQueue.current.then(apply);
    placementQueue.current = result.catch(() => {});
    await result;
  }, [loadSessionData, replaceSession]);

  const handleSwitchBranch = useCallback(
    async (rootSessionId: string, targetBranchId: string) => {
      if (switchingBranchRef.current) return;
      switchingBranchRef.current = true;
      setSwitchingBranch(true);
      const updates = beginSessionRead(targetBranchId);
      try {
        const res = await getDesktopBridge().switchConversationBranch({
          sessionId: rootSessionId,
          targetBranchId,
        });
        setSessions((prev) => {
          const exists = prev.some((s) => s.sessionId === res.session.sessionId);
          const updated = prev.map((s) => {
            if (s.sessionId === res.session.sessionId) return res.session;
            if (res.previousBranchId && s.sessionId === res.previousBranchId) {
              return { ...s, status: 'closed' as const, activeBranchId: res.session.sessionId };
            }
            if ((s.rootSessionId || s.sessionId) === res.tree.rootSessionId) {
              return { ...s, activeBranchId: res.session.sessionId, branchCount: res.tree.totalBranches };
            }
            return s;
          });
          return exists ? updated : [res.session, ...updated];
        });
        applySessionRead(res.session.sessionId, updates, {
          ...(res.messagePosition ?? emptyMessagePosition()), messages: res.messages,
        }, res.inspector, res.swarm, res.tree);
        setTelemetry(previous => mergeTelemetryDashboard(previous, res.telemetry));
        layoutRef.current = res.layout;
        setLayout(res.layout);
        setFocusedSessionId(res.session.sessionId);
      } catch (err) {
        reportError(err);
        void getDesktopBridge()
          .getConversationTree(rootSessionId)
          .then((freshTree) => setTreeByRoot((prev) => ({ ...prev, [freshTree.rootSessionId]: freshTree })))
          .catch(() => {});
      } finally {
        if (sessionReads.current.get(targetBranchId) === updates) sessionReads.current.delete(targetBranchId);
        switchingBranchRef.current = false;
        setSwitchingBranch(false);
      }
    },
    [reportError, beginSessionRead, applySessionRead]
  );
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
      const result = await bridge.submitApprovalDecision(submission);
      const zh = preferences.locale === 'zh-CN';
      if (submission.decision === 'approve_for_me_ai' && result) {
        if (result.outcome === 'approved' && result.delegatedMode) {
          const mode = result.delegatedMode === 'hybrid' ? (getComponentCopy(zh).aiReview) : (getComponentCopy(zh).basicRules);
          showToast(zh ? '已放行本次操作。仅当前会话使用' + mode : 'Approved. This session now uses ' + mode, 'success');
        } else if (result.outcome === 'pending') {
          showToast(getComponentCopy(zh).yourDecisionIsStillNeeded, 'info');
        }
      }
    },
    [preferences.locale, showToast]
  );
  const handleUpdateApprovalConfig = useCallback(async (patch: Partial<ApproveForMeConfig>) => {
    setApprovalConfig(await getDesktopBridge().updateApprovalConfig(patch));
  }, []);
  const handleUpdateTranslationConfig = useCallback(async (patch: TranslationConfigPatch) => {
    const next = await getDesktopBridge().updateTranslationConfig(patch);
    setTranslationConfig(next);
    setPreferences((prev) =>
      prev.translationEngine === next.engine ? prev : { ...prev, translationEngine: next.engine }
    );
    return next;
  }, []);
  const openExternalTranslatorSettings = useCallback(() => {
    setTranslationSettingsFocusSeq((n) => n + 1);
    setSettingsSection('general');
  }, []);
  const openTranslatorStats = useCallback(() => {
    setSettingsSection(null);
    setContextInspectorViewMode('translator');
    void patchLayout({ rightInspectorCollapsed: false, activeInspectorTab: 'context' });
  }, [patchLayout]);
  const handleLoadSwarmPage = useCallback((id: string, before: SwarmHistoryCursor) => getDesktopBridge().getSwarmState(id, before), []);
  const handleLaunchSwarmTask = useCallback(
    async (id: string, taskBrief: string) => {
      const prompt = UI_DICTIONARIES[localeRef.current].ui.v031.swarmLaunchPrompt(taskBrief);
      await getDesktopBridge().sendPrompt({ sessionId: id, text: prompt });
    },
    []
  );

  /* ---------------------------------------------------------------- 设置 */
  /**
   * 所有偏好写入（常规偏好、应用图标、自定义主题导入、思考块默认展开）共用同一序列号：
   * 只应用比已生效写入更新的回包，避免较早的回包在较新的快照之后到达并覆盖它。
   */
  const writePreferences = useCallback(
    (send: () => Promise<ClientPreferences>, uiScale?: number, announceZoom = false) => {
      const writes = preferenceWrites.current;
      const zoom = zoomScale.current;
      const id = ++writes.sent;
      if (uiScale !== undefined) zoom.pending = { id, value: clampUiScale(uiScale) };
      // 请求同步发出以保持写入顺序；同步抛错的桥接实现也收敛为被拒绝的 Promise，统一走下方的错误提示。
      let request: Promise<ClientPreferences>;
      try {
        request = send();
      } catch (error) {
        request = Promise.reject(error);
      }
      const saved = request.then(next => {
        // The main process saves in request order. An older reply may arrive after a newer settings snapshot.
        if (id > writes.applied) {
          writes.applied = id;
          zoom.confirmed = clampUiScale(next.uiScale);
          setPreferences(next);
        }
        if (zoom.pending?.id === id) {
          zoom.pending = undefined;
          if (announceZoom && id === writes.applied) showToast(UI_DICTIONARIES[next.locale].ui.uiScaleToast(Math.round(zoom.confirmed * 100)));
        }
      });
      return { saved, id };
    },
    [showToast]
  );
  const handleUpdatePreferences = useCallback(
    (patch: Partial<ClientPreferences>, announceZoom = false) => {
      const zoom = zoomScale.current;
      const { saved, id } = writePreferences(() => getDesktopBridge().updatePreferences(patch), patch.uiScale, announceZoom);
      // Switches use the shared error notice. Forms also await the original save before clearing their draft.
      void saved.catch(error => {
        if (patch.uiScale !== undefined) {
          if (zoom.pending?.id !== id) return;
          zoom.pending = undefined;
        }
        reportError(error);
      });
      return saved;
    },
    [reportError, writePreferences]
  );
  const handleChangeLocale = useCallback(
    (locale: ClientLocale) => void handleUpdatePreferences({ locale }),
    [handleUpdatePreferences]
  );
  const handleSetAppIcon = useCallback(
    async (iconId: GravityIconPreference) => {
      try {
        await writePreferences(() => getDesktopBridge().setAppIcon(iconId)).saved;
      } catch (err) {
        reportError(err);
      }
    },
    [reportError, writePreferences]
  );
  const handleImportTheme = useCallback(async (json: string) => {
    await writePreferences(() => getDesktopBridge().importCustomTheme(json)).saved;
  }, [writePreferences]);
  const workspaceWriters = useMemo<WorkspaceWriters>(() => ({
    // 思考块默认展开等后台偏好写入静默失败，不弹错误提示，但仍经由同一序列化队列。
    updatePreferences: (patch) => writePreferences(() => getDesktopBridge().updatePreferences(patch)).saved,
    patchLayout,
  }), [patchLayout, writePreferences]);
  const handleExportTheme = useCallback(async () => getDesktopBridge().exportCustomTheme(), []);
  const handleUpdateRates = useCallback(async (cards: ModelRateCard[]) => {
    const updated = await getDesktopBridge().updateModelRateCards(cards);
    setTelemetry(previous => mergeTelemetryDashboard(previous, updated));
  }, []);
  const handleCheckUpdates = useCallback(async () => {
    try {
      const next = await getDesktopBridge().checkForUpdates();
      setUpdateState(next);
    } catch (err) {
      reportError(err);
    }
  }, [reportError]);
  const handleDownloadUpdate = useCallback(async () => {
    try {
      const next = await getDesktopBridge().downloadUpdate();
      setUpdateState(next);
    } catch (err) {
      reportError(err);
    }
  }, [reportError]);
  const handleInstallUpdate = useCallback(async () => {
    try {
      const res = await getDesktopBridge().installUpdate();
      if (res.message) showToast(res.message, res.launched ? 'success' : 'info');
    } catch (err) {
      reportError(err);
    }
  }, [reportError, showToast]);
  const pluginWorkspace = tabSessions.find(s => s.sessionId === focusedSessionId)?.cwd || preferences.defaultWorkspaceCwd || undefined;
  const pluginWorkspaceRef = useRef(pluginWorkspace);
  pluginWorkspaceRef.current = pluginWorkspace;
  // PL-1：刷新回调保持稳定引用，避免切换会话页签/工作区 cwd 时静默触发 CLI 探测；仅在显式打开插件页或手动刷新时读取当前工作区。
  const handleRefreshPlugins = useCallback(async () => {
    setPluginsSnap(await getDesktopBridge().getPluginsSnapshot(pluginWorkspaceRef.current));
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
      reloadProfile({ message: formatActionError(error, UI_DICTIONARIES[preferences.locale]), tone: 'error' });
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

  /* ---------------------------------------------------------------- F-08 稳定回调（配合 React.memo 跳过无关窗格提交） */
  const unarchivedSessions = useMemo(() => sessions.filter((s) => !s.archivedAt), [sessions]);
  const gridHandlers = useStableCallbacks({
    onCommitSplitRatio: (r: number) => void patchLayout({ splitRatio: r }),
    onFocusPane: (id: string | null) => setFocusedSessionId(id),
    onBindSlotSession: (slot: number, id: string) => void handleBindSlotSession(slot, id),
    onOpenNewSession: () => setNewSessionOpen(true),
    onSwitchBranch: (rootId: string, targetId: string) => void handleSwitchBranch(rootId, targetId),
    onOpenTreeInspector: (id: string) => openInspectorAt(id, 'tree'),
    onClearSessionApprovals: async (id: string) => {
      replaceSession(await getDesktopBridge().clearSessionApprovals(id));
      showToast(preferences.locale === 'zh-CN' ? '已清除本会话记住的授权' : 'Cleared saved approvals for this conversation');
    },
    onOpenApprovalSettings: () => openApprovalSettings('rules'),
    onLaunchOfficialLogin: () => handleLaunchLogin(accounts.activeProfileId),
    onOpenAccountSettings: () => setSettingsSection('accounts'),
    onOpenExternalReviewerSettings: () => openApprovalSettings('reviewer'),
    onOpenReviewerStats: (id: string) => {
      setContextInspectorViewMode('reviewer');
      openInspectorAt(id, 'context');
    },
    onOpenSwarmInspector: (id: string) => openInspectorAt(id, 'swarm'),
    onOpenContextInspector: (id: string) => {
      setContextInspectorViewMode('context');
      openInspectorAt(id, 'context');
    },
    onInspectDiffFile: (id: string, fp: string) => openInspectorAt(id, 'diff', fp),
    onOpenPlanInspector: (id: string) => openInspectorAt(id, 'plan'),
  });
  const sidebarHandlers = useStableCallbacks({
    onToggleCollapse: () => void patchLayout({ leftSidebarCollapsed: true }),
    onSelectSession: (s: ManagedSessionSummary) => void handleActivateSession(s),
    onOpenNewSession: () => setNewSessionOpen(true),
    onCreateSessionInProject: (cwd: string, mode?: AgentExecutionMode) => void handleCreateSession(cwd, undefined, mode).catch(reportError),
    onOrganizeTitles: (req?: TitleOrganizeRequest) => handleOrganizeTitles(req),
    onCommitWidth: (w: number) => void patchLayout({ leftSidebarWidth: w }),
  });
  const inspectorHandlers = useStableCallbacks({
    onOpenExternalReviewerSettings: () => openApprovalSettings('reviewer'),
    onSwitchBranch: (rootId: string, targetId: string) => void handleSwitchBranch(rootId, targetId),
    onSelectTab: (tab: RightInspectorTab) => void patchLayout({ activeInspectorTab: tab }),
    onFocusDiffFile: (fp: string) => setFocusedDiffFile(fp),
    onCommitWidth: (w: number) => void patchLayout({ rightInspectorWidth: w }),
    onToggleFloating: (v: boolean) => void patchLayout({ inspectorFloating: v }),
    onCollapse: () => void patchLayout({ rightInspectorCollapsed: true }),
    onOpenRateCardsSettings: () => setSettingsSection('rates'),
  });

  /* ---------------------------------------------------------------- 快捷键 */
  const overlayOpen = settingsSection !== null || newSessionOpen || organizeOpen;
  const macShortcuts = document.documentElement.dataset.windowChrome === 'mac-inset';
  const applyZoomCommand = useCallback((command: UiScaleCommand) => {
    const current = zoomScale.current.pending?.value ?? zoomScale.current.confirmed;
    const next = command === 'reset' ? UI_SCALE_LIMITS.default
      : clampUiScale(current + (command === 'decrease' ? -UI_SCALE_LIMITS.step : UI_SCALE_LIMITS.step));
    if (next === current && command !== 'reset') return;
    void handleUpdatePreferences({ uiScale: next }, true);
  }, [handleUpdatePreferences]);
  useEffect(() => {
    if (ready && macShortcuts) return getDesktopBridge().onUiScaleCommand(applyZoomCommand);
  }, [ready, macShortcuts, applyZoomCommand]);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      // 输入法组词中的按键（含 macOS 拼音的 ⇧⇥ / 回车上屏）一律交给输入法。
      if (isImeComposing(e)) return;
      // macOS 只认 ⌘：Ctrl+B / Ctrl+N 等是文本框里的光标移动键，不能被工作台快捷键抢占。
      const mod = isPrimaryModifier(e, macShortcuts);
      const key = e.key.toLowerCase();
      if (mod && key === ',') {
        e.preventDefault();
        setSettingsSection((prev) => (prev ? null : 'general'));
        return;
      }
      const zoom = mod && !e.altKey ? uiScaleCommandForKey(e.key) : undefined;
      if (zoom) {
        if (macShortcuts && e.metaKey && !e.ctrlKey) return;
        e.preventDefault();
        applyZoomCommand(zoom);
        return;
      }
      // 设置或弹窗打开时暂停后续工作台快捷键，防止一次按键同时作用于覆盖层和底层会话。
      if (overlayOpen || document.querySelector('dialog[open]')) return;
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
        void patchLayout({ rightInspectorCollapsed: !inspectorCollapsed });
        return;
      }
      if (mod && e.key === '\\') {
        e.preventDefault();
        void patchLayout({ layoutMode: SPLIT_CYCLE[(SPLIT_CYCLE.indexOf(layout.layoutMode) + 1) % SPLIT_CYCLE.length] });
        return;
      }
      if (e.shiftKey && e.key === 'Tab' && !isTypingTarget(e.target) && !isNativeFocusControl(e.target)) {
        e.preventDefault();
        const active = sessions.find((s) => s.sessionId === focusedSessionId && s.status !== 'closed');
        if (active) {
          // v0.3.2：Shift+Tab 仅在 default / accept-edits / plan 三档安全循环，绝不盲切进入 Turbo（full-access）。
          // 处于 Turbo 时按 Shift+Tab 回落到 default（indexOf 返回 -1 → 0）。
          const idx = SAFE_CYCLE_EXECUTION_MODES.indexOf(active.executionMode || 'default');
          void handleSetSessionMode(
            active.sessionId,
            SAFE_CYCLE_EXECUTION_MODES[(idx + 1) % SAFE_CYCLE_EXECUTION_MODES.length]
          ).catch(reportError);
        } else {
          const allowedModes = isExternalReviewerConnected(approvalConfig.externalReviewer)
            ? APPROVAL_MODE_ORDER
            : APPROVAL_MODE_ORDER.filter((m) => m !== 'hybrid');
          const idx = allowedModes.indexOf(approvalConfig.mode);
          void handleSetApprovalMode(allowedModes[(idx + 1) % allowedModes.length]);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    approvalConfig.mode,
    approvalConfig.externalReviewer,
    applyZoomCommand,
    macShortcuts,
    focusedSessionId,
    handleSetApprovalMode,
    handleSetSessionMode,
    layout.layoutMode,
    layout.leftSidebarCollapsed,
    inspectorCollapsed,
    overlayOpen,
    patchLayout,
    reportError,
    sessions,
  ]);

  const recentCwds = useMemo(
    () =>
      [...sessions]
        .filter((s) => !s.isLegacyApprovalPollution)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((s) => s.cwd)
        .filter((cwd) => Boolean(cwd) && !isTempExtractionDir(cwd)),
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
            <ul className="boot-error-tips" data-testid="app-bootstrap-troubleshoot">
              {bootDict.ui.v031.bootstrapTroubleshoot.map((tip) => <li key={tip}>{tip}</li>)}
            </ul>
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
            <img className="app-boot-logo" src={resolveGravityIconVariant(preferences.appIcon, preferences.theme, preferences.customTheme).publicSvgUrl} alt="" />
            <span>{bootDict.bootstrapLoading}</span>
          </>
        )}
      </div>
    );
  }

  const stageSessionId = focusedSessionId;
  const stageSession = stageSessionId ? sessions.find((s) => s.sessionId === stageSessionId) : undefined;
  const stageRootId = stageSession ? (stageSession.rootSessionId || stageSession.sessionId) : null;
  const stageTree = stageRootId ? treeByRoot[stageRootId] : undefined;
  const stageSessionBusy = stageSession?.status === 'streaming' || stageSession?.status === 'waiting_approval';
  const activeCount = sessions.filter(
    (s) => !s.archivedAt && s.status !== 'closed' && (!layout.hideLegacyPollutionSessions || !s.isLegacyApprovalPollution)
  ).length;
  const isIsolatedProfile =
    accounts.profiles.find((p) => p.profileId === accounts.activeProfileId)?.isDefault === false;

  return (
    <I18nProvider locale={preferences.locale} onChangeLocale={handleChangeLocale} macShortcuts={macShortcuts}>
      <div className="app-shell" data-testid="agy-app-root" data-brand="Gravity">
        <ActivityRail
          appIcon={preferences.appIcon}
          theme={preferences.theme}
          customTheme={preferences.customTheme}
          themeEpoch={systemThemeEpoch}
          sidebarCollapsed={layout.leftSidebarCollapsed}
          connection={connection}
          accounts={accounts}
          projectCount={(preferences.projects ?? []).length}
          pluginCount={pluginsSnap.plugins.length + pluginsSnap.mcpServers.length}
          activeSessionCount={activeCount}
          hasAvailableUpdate={updateState.status === 'available' || updateState.status === 'downloaded'}
          availableUpdateVersion={updateState.latestVersion}
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
          openTabSessionIds={layout.openTabSessionIds}
          selectedSessionId={stageSessionId}
          hideLegacyPollutionSessions={layout.hideLegacyPollutionSessions}
          organizingTitles={organizing}
          organizingTarget={organizingTarget}
          organizeCooldownSec={organizeCooldownSec}
          organizeQuotaLeft={organizeQuotaLeft}
          projects={preferences.projects}
          {...sidebarHandlers}
          onTogglePollutionVisibility={handleTogglePollution}
          onRenameSession={handleRenameSession}
          onTogglePinSession={handleTogglePin}
          onManageSession={handleManageSession}
        />

        <div className="main">
          <TopBar
            sessions={tabSessions}
            layout={topBarLayout}
            focusedSessionId={focusedSessionId}
            pendingApprovals={pendingApprovals}
            onToggleRightInspector={() => void patchLayout({ rightInspectorCollapsed: !inspectorCollapsed })}
            onSelectTab={(id) => void handleSelectTab(id)}
            onCloseTab={(id) => void handleCloseTab(id)}
            onOpenNewSessionModal={() => setNewSessionOpen(true)}
            onChangeLayoutMode={(mode) => void patchLayout({ layoutMode: mode })}
          />

          <WorkspaceWritersContext.Provider value={workspaceWriters}>
          <ComposerDrafts.Provider value={composerDrafts}>
            <SessionWorkspaceGrid
              layout={layout}
              focusedSessionId={focusedSessionId}
              sessions={unarchivedSessions}
              availableModels={connection.availableModels}
              modelListSource={connection.modelListSource}
              newSessionModels={newSessionModels}
              sessionLoadErrors={sessionLoadErrors}
              onRetrySessionLoad={handleRetrySessionLoad}
              theme={preferences.theme}
              customTheme={preferences.customTheme}
              messagesBySession={messagesBySession}
              messagePositions={messagePositions}
              onLoadEarlier={loadEarlierMessages}
              pendingApprovals={pendingApprovals}
              reviewingApprovals={reviewingApprovals}
              onCancelStage2Review={handleCancelStage2Review}
              recentCwds={recentCwds}
              defaultWorkspaceCwd={
                preferences.defaultWorkspaceCwd ||
                recentCwds.find((c) => c === sessions.find((s) => s.sessionId === stageSessionId)?.cwd) ||
                recentCwds[0] ||
                ''
              }
              onSelectDirectory={handleSelectDirectory}
              onQuickStart={handleQuickStart}
              auditLog={auditEntries}
              approvalConfig={approvalConfig}
              defaultThoughtTrack={preferences.defaultThoughtTrack}
              telemetryDashboard={telemetry}
              swarmBySession={swarmBySession}
              treeByRoot={treeByRoot}
              switchingBranch={switchingBranch}
              scrollMemoryRef={scrollMemoryRef}
              appIcon={preferences.appIcon}
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
              {...gridHandlers}
              connection={connection}
              isIsolatedProfile={isIsolatedProfile}
              onReconnectSession={handleReconnectSession}
            />
          </ComposerDrafts.Provider>
          </WorkspaceWritersContext.Provider>
        </div>

        <RightInspector
          profileId={preferences.activeProfileId}
          collapsed={inspectorCollapsed}
          width={layout.rightInspectorWidth}
          floating={layout.inspectorFloating}
          activeTab={layout.activeInspectorTab}
          contextViewMode={contextInspectorViewMode}
          onChangeContextViewMode={setContextInspectorViewMode}
          reviewerConnected={isExternalReviewerConnected(approvalConfig.externalReviewer)}
          translatorConnected={isExternalTranslatorConnected(translationConfig.externalTranslator)}
          onOpenExternalTranslatorSettings={openExternalTranslatorSettings}
          focusedDiffFile={focusedDiffFile}
          sessionId={stageSessionId}
          sessionCwd={stageSession?.cwd}
          inspectorData={stageSessionId ? inspectorBySession[stageSessionId] : undefined}
          {...inspectorHandlers}
          sessionMessages={stageSessionId ? messagesBySession[stageSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES}
          telemetry={telemetry}
          conversationTree={stageTree}
          sessionBusy={stageSessionBusy}
          switchingBranch={switchingBranch}
          swarmTopology={stageSessionId ? swarmBySession[stageSessionId] : undefined}
          swarmDrafts={swarmDrafts}
          onLaunchSwarmTask={stageSession && !stageSession.readOnly && !stageSession.archivedAt && stageSession.status !== 'closed' ? handleLaunchSwarmTask : undefined}
          onLoadSwarmPage={handleLoadSwarmPage}
        />

        {settingsSection && (
          <SettingsView
            section={settingsSection}
            preferences={preferences}
            connection={connection}
            accounts={accounts}
            approvalConfig={approvalConfig}
            approvalInitialTab={approvalSettingsTab}
            externalReviewerTelemetry={telemetry.externalReviewer}
            translationConfig={translationConfig}
            externalTranslatorTelemetry={telemetry.externalTranslator}
            focusExternalTranslatorSeq={translationSettingsFocusSeq}
            currentSessionId={stageSessionId}
            auditEntries={auditEntries}
            plugins={pluginsSnap}
            rateCards={telemetry.rateCards}
            updateState={updateState}
            onSectionChange={setSettingsSection}
            onClose={() => setSettingsSection(null)}
            onUpdatePreferences={handleUpdatePreferences}
            onUpdateTranslationConfig={handleUpdateTranslationConfig}
            onOpenTranslatorStats={openTranslatorStats}
            onCheckUpdates={handleCheckUpdates}
            onDownloadUpdate={handleDownloadUpdate}
            onInstallUpdate={handleInstallUpdate}
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
            onQuickCreateInProject={(cwd, mode) => handleCreateSession(cwd, undefined, mode).catch(reportError)}
          />
        )}

        {organizeOpen && <TitleOrganizerModal
          open
          result={organizeResult}
          cooldownSec={organizeCooldownSec}
          onClose={() => setOrganizeOpen(false)}
          repeatRequest={organizeRequest}
          onRunOrganize={request => handleOrganizeTitles(request, true)}
        />}

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
          availableModels={newSessionModels}
          onClose={() => setNewSessionOpen(false)}
          onCreate={handleCreateSession}
          onSaveDefaultCwd={async (nextDefault) => {
            await handleUpdatePreferences({ defaultWorkspaceCwd: nextDefault });
          }}
          onSaveProject={async (proj) => {
            const existing = preferences.projects ?? [];
            await handleUpdatePreferences({
              projects: [proj, ...existing.filter((p) => normalizeProjectCompareKey(p.path) !== normalizeProjectCompareKey(proj.path))],
            });
          }}
          onOpenProjectsSettings={() => setSettingsSection('projects')}
        />

        {toast && (
          <div key={toast.id} className={`toast tone-${toast.tone}`} role="status" data-testid="app-toast"
            style={{ '--toast-life': toast.tone === 'error' ? '5200ms' : '3200ms' } as React.CSSProperties}>
            {toast.tone === 'error' ? <Icon icon={AlertCircle} size="md" /> : toast.tone === 'success' ? <Icon icon={CheckCircle2} size="md" /> : <Icon icon={Info} size="md" />}
            <span>{toast.message}</span>
            <button type="button" className="icon-btn icon-btn-sm toast-close" onClick={dismissToast}
              aria-label={UI_DICTIONARIES[preferences.locale].closeAction}>
              <Icon icon={X} size="xs" />
            </button>
          </div>
        )}
      </div>
    </I18nProvider>
  );
}

export default App;
