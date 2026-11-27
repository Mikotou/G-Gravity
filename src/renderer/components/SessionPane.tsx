import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Cpu, FolderGit2, FolderOpen, GitBranch, Info, Network, Plus, RotateCw, X } from 'lucide-react';
import {
  buildDiagnosticBanner,
  computeConversationTreeTotalCost,
  inspectStreamInterruption,
  type AcpConnectionStatus,
  type AcpModelOption,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type ApprovalAuditEntry,
  type ApprovalDecisionSubmission,
  type ApprovalMode,
  type ApprovalReviewingEvent,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ConversationTreeState,
  type CustomThemeConfig,
  type GravityIconPreference,
  type ManagedSessionSummary,
  type MessageForkControl,
  type MessagePagePosition,
  type PendingApprovalRequest,
  type SendPromptInput,
  type SessionDiagnosticBanner,
  type TurnStopState,
  type SwarmTopologyState,
  type TelemetryDashboardSnapshot,
  type ThoughtDisplayTrack,
  type ThemePreference,
  type WorkspaceSplitMode,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { isImeComposing } from '../lib/platform-keys';
import { formatActionError, formatRelativeTime } from '../i18n/locales';
import { resolveGravityIconVariant } from '../styles/theme';
import { modelDisplayName } from '../lib/model-options';
import { scrollBehavior } from '../lib/motion';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { buildForkControlMap } from '../lib/fork-controls';
import { Composer } from './Composer';
import { GuardianReviewingCard, InlineRequestView } from './InlineRequestView';
import type { ReviseMessageInput } from '@shared';
import { useAnnotationDraft, showAnnotationRanges } from '../lib/annotation-drafts';
import { isQuestionDismissed, markQuestionDismissed } from '../lib/dismissed-questions';
import { EditUserMessage } from './EditUserMessage';
import { ImageSessionContext, ImageWorkspace } from './MessageImage';
import { Markdown } from './Markdown';
import {
  detectContextTargetFromElement,
  SelectionFloatingBar,
  TargetContextMenu,
  TurnNotationPins,
  type DetectedContextTarget,
  type TextNotationItem,
  type TextQuoteItem,
} from './SelectionAnnotationTools';
import { writtenQuestion } from '@shared';
import { getDesktopBridge } from '../services/desktop-bridge';
import { QuestionBar } from './QuestionBar';
import { QuestionFollowupStatus } from './QuestionFollowupStatus';
import { SentAnnotations } from './SentAnnotations';
import { ThinkingBlock } from './ThinkingBlock';
import { AccountQuotaFooter } from './AccountQuotaView';
import { PaneStatusChip, ToolActivityStream, TurnOutcomeBar, TurnSettledStrip } from './TurnActivity';
import { isTurnUnconfirmed } from '../lib/turn-insights';
import { WorkingIndicator } from './WorkingIndicator';
import { TurnDiagnosticCard, type DiagnosticHandlers } from './TurnDiagnosticCard';
import { Icon } from './ui/Icon';

export interface SessionPaneProps {
  slotIndex: number;
  layoutMode: WorkspaceSplitMode;
  isFocused: boolean;
  session: ManagedSessionSummary | null;
  availableSessions: ManagedSessionSummary[];
  availableModels: AcpModelOption[];
  /** U-02：欢迎卡片模型药丸可选目录（连接快照 + 非污染会话去重）；缺省时退回 `availableModels` */
  newSessionModels?: AcpModelOption[];
  /** F-07：启动时单个标签数据加载失败的原因（按会话号），仅在该窗格内提示并重试 */
  sessionLoadErrors?: Record<string, string>;
  onRetrySessionLoad?: (sessionId: string) => void;
  /** D2：图标 `'auto'` 跟随主题时需要当前主题 */
  theme?: ThemePreference;
  customTheme?: CustomThemeConfig;
  modelListSource?: 'live' | 'cached' | 'unknown';
  messages: ChatMessageItem[];
  messagePosition?: MessagePagePosition;
  onLoadEarlier?: (sessionId: string) => Promise<boolean>;
  pendingApprovals: PendingApprovalRequest[];
  latestAudit?: ApprovalAuditEntry;
  approvalConfig: ApproveForMeConfig;
  defaultThoughtTrack: ThoughtDisplayTrack;
  telemetryDashboard: TelemetryDashboardSnapshot;
  conversationTree?: ConversationTreeState;
  switchingBranch?: boolean;
  swarmState?: SwarmTopologyState;
  scrollMemoryRef: React.MutableRefObject<Record<string, number>>;
  /** @deprecated v0.3.4：演示审批已移出生产界面 */
  canTriggerDemoApproval?: boolean;
  appIcon: GravityIconPreference;
  onFocusPane: (sessionId: string | null) => void;
  onBindSlotSession: (slotIndex: number, sessionId: string) => void;
  onOpenNewSession: () => void;
  onReviseMessage?: (input: ReviseMessageInput) => Promise<void>;
  onSwitchBranch?: (rootSessionId: string, targetBranchId: string) => void;
  onOpenTreeInspector?: (sessionId: string) => void;
  onSendPrompt: (input: SendPromptInput) => Promise<void>;
  onCancelPrompt: (sessionId: string) => Promise<void>;
  onCompactContext: (sessionId: string) => Promise<void>;
  onSetSessionMode: (sessionId: string, mode: AgentExecutionMode) => Promise<void>;
  onSetSessionEffort: (sessionId: string, effort: AgentReasoningEffort) => Promise<void>;
  onSetSessionModel: (sessionId: string, modelId: string) => Promise<void>;
  onQueryWorkspaceFiles: (cwd: string, query?: string) => Promise<string[]>;
  onSubmitApproval: (submission: ApprovalDecisionSubmission) => Promise<void>;
  onCycleApprovalMode: (nextMode: ApprovalMode) => Promise<void>;
  onClearSessionApprovals?: (sessionId: string) => Promise<void>;
  onOpenApprovalSettings: () => void;
  onOpenExternalReviewerSettings?: () => void;
  onOpenReviewerStats?: (sessionId: string) => void;
  onOpenSwarmInspector: (sessionId: string) => void;
  onOpenContextInspector: (sessionId: string) => void;
  onInspectDiffFile: (sessionId: string, filePath: string) => void;
  /** @deprecated v0.3.4：演示审批已移出生产界面 */
  onTriggerDemoApproval?: (sessionId: string) => void;
  /** Stage 2 Guardian 正在复核的请求（全部会话，窗格内按会话过滤） */
  reviewingApprovals?: ApprovalReviewingEvent[];
  /** 中止 Stage 2 外部复核并转为人工审批 */
  onCancelStage2Review?: (requestId: string) => Promise<void>;
  /** 欢迎页直达：最近使用的工作目录、默认目录与目录选择器 */
  recentCwds?: string[];
  defaultWorkspaceCwd?: string;
  onSelectDirectory?: (defaultPath?: string) => Promise<string | null>;
  /** 欢迎页直达：在所选目录新建会话并立即发送首句 */
  onQuickStart?: (cwd: string, text: string, slotIndex: number, options?: QuickStartOptions) => Promise<void>;
  /** 实时连接状态（断连、429/403 冷却） */
  connection?: AcpConnectionStatus;
  /** AQ-1：当前活动账号是否为隔离 Profile（跳过默认自动额度探测） */
  isIsolatedProfile?: boolean;
  /** 断连或出错会话的一键重连（重新拉起官方 agy 并恢复会话） */
  onReconnectSession?: (sessionId: string) => Promise<void>;
  /** 由用户点击后拉起官方登录终端 */
  onLaunchOfficialLogin?: () => Promise<void> | void;
  /** 打开账号设置（仅导航，绝不自动切换账号） */
  onOpenAccountSettings?: () => void;
}

/** 系统提示中表示异常或中断的关键词，命中时以警示色呈现。 */
const SYSTEM_WARNING_RE =
  /拒绝|失败|错误|限流|超时|中断|断开|异常|取消|未授权|429|403|401|500|502|503|rejected|failed|error|rate.?limit|timeout|timed out|interrupted|denied|unauthori[sz]ed|disconnected|cancell?ed/i;

function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

/* ------------------------------------------------------------------ 欢迎 / 空窗格 */

export interface QuickStartOptions {
  modelId?: string;
}

/** 欢迎画布上的直达输入卡片：选好工作目录后输入首句，按 Enter 新建会话并立即发送。 */
function WelcomeQuickComposer({
  slotIndex,
  compact,
  recentCwds,
  defaultCwd,
  onSelectDirectory,
  onQuickStart,
  models = [],
}: {
  slotIndex: number;
  compact: boolean;
  recentCwds: string[];
  defaultCwd: string;
  models?: AcpModelOption[];
  onSelectDirectory?: (defaultPath?: string) => Promise<string | null>;
  onQuickStart: (cwd: string, text: string, slotIndex: number, options?: QuickStartOptions) => Promise<void>;
}): React.ReactElement {
  const { dict } = useI18n();
  const ui = dict.ui;
  const [text, setText] = useState('');
  const [cwd, setCwd] = useState(defaultCwd);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const userPicked = useRef(false);
  const dirs = Array.from(new Set([cwd, ...recentCwds].filter(Boolean))).slice(0, 6);

  // 默认目录在启动快照或会话列表更新后才可知；用户尚未手动选择时跟随最新默认值。
  useEffect(() => {
    if (!userPicked.current && defaultCwd) setCwd(defaultCwd);
  }, [defaultCwd]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, Math.max(compact ? 44 : 64, el.scrollHeight))}px`;
  }, [text, compact]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    function onDown(e: MouseEvent): void {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setModelMenuOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [modelMenuOpen]);

  // 目录刷新后若所选模型已不存在，回到「跟随默认」，避免提交失效模型。
  useEffect(() => {
    if (modelId && models.length > 0 && !models.some((m) => m.modelId === modelId)) setModelId('');
  }, [models, modelId]);

  const modelLabel = modelId ? modelDisplayName(modelId, models) : ui.v034.newSessionModelFollowOfficial;

  async function browse(): Promise<string | null> {
    setMenuOpen(false);
    if (!onSelectDirectory) return null;
    try {
      const picked = await onSelectDirectory(cwd || undefined);
      if (picked) {
        userPicked.current = true;
        setCwd(picked);
        setError(null);
      }
      return picked;
    } catch (err) {
      setError(formatActionError(err, dict));
      return null;
    }
  }

  async function submit(): Promise<void> {
    const prompt = text.trim();
    if (!prompt || starting) return;
    let target = cwd.trim();
    if (!target) target = (await browse())?.trim() || '';
    if (!target) {
      setError(ui.welcomeQuickNoDir);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      await onQuickStart(target, prompt, slotIndex, modelId ? { modelId } : undefined);
      setText('');
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className={`welcome-quick${starting ? ' is-starting' : ''}`} data-testid="welcome-quick-composer">
      <textarea
        ref={inputRef}
        className="welcome-quick-input"
        rows={compact ? 1 : 2}
        value={text}
        disabled={starting}
        placeholder={ui.welcomeQuickPlaceholder}
        aria-label={ui.welcomeQuickPlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) {
            e.preventDefault();
            void submit();
          }
        }}
        data-testid="welcome-quick-composer-input"
      />
      <div className="welcome-quick-foot">
        <div className="menu-anchor" ref={menuRef}>
          <button
            type="button"
            className={`welcome-dir-pill${cwd ? '' : ' is-empty'}`}
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={cwd || ui.welcomeQuickChooseDir}
            data-testid="welcome-dir-pill"
          >
            <Icon icon={FolderOpen} size="sm" />
            <span className="truncate">{cwd ? folderName(cwd) : ui.welcomeQuickChooseDir}</span>
            <Icon icon={ChevronDown} size="xs" />
          </button>
          {menuOpen && (
            <div className="popover welcome-dir-menu" role="menu" data-testid="welcome-dir-menu">
              {dirs.length > 0 && <div className="menu-label">{ui.welcomeRecentDirs}</div>}
              {dirs.map((dir) => (
                <button
                  key={dir}
                  type="button"
                  role="menuitemradio"
                  aria-checked={dir === cwd}
                  className={`menu-item ${dir === cwd ? 'is-checked' : ''}`}
                  title={dir}
                  onClick={() => {
                    userPicked.current = true;
                    setCwd(dir);
                    setMenuOpen(false);
                    setError(null);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="menu-check">{dir === cwd ? <Icon icon={Check} size="sm" /> : null}</span>
                  <span className="welcome-dir-item">
                    <span className="welcome-dir-name truncate">{folderName(dir)}</span>
                    <span className="welcome-dir-path mono truncate">{dir}</span>
                  </span>
                </button>
              ))}
              {onSelectDirectory && (
                <>
                  {dirs.length > 0 && <div className="menu-sep" />}
                  <button type="button" role="menuitem" className="menu-item" onClick={() => void browse()}
                    data-testid="welcome-dir-browse">
                    <span className="menu-check"><Icon icon={FolderOpen} size="sm" /></span>
                    <span>{ui.welcomeQuickBrowse}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="menu-anchor" ref={modelMenuRef}>
          <button
            type="button"
            className={`welcome-dir-pill welcome-model-pill${modelId ? ' is-set' : ''}`}
            onClick={() => setModelMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={modelMenuOpen}
            aria-label={`${ui.v034.welcomeModelPillTitle}: ${modelLabel}`}
            title={ui.v034.welcomeModelPillTitle}
            disabled={starting}
            data-testid="welcome-model-pill"
          >
            <Icon icon={Cpu} size="sm" />
            <span className="truncate">{modelLabel}</span>
            <Icon icon={ChevronDown} size="xs" />
          </button>
          {modelMenuOpen && (
            <div className="popover welcome-dir-menu welcome-model-menu" role="menu" data-testid="welcome-model-menu">
              <div className="menu-label">{ui.v034.newSessionModelLabel}</div>
              {[{ modelId: '', name: ui.v034.newSessionModelFollowOfficial }, ...models].map((m) => (
                <button
                  key={m.modelId || '__default'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m.modelId === modelId}
                  className={`menu-item ${m.modelId === modelId ? 'is-checked' : ''}`}
                  onClick={() => {
                    setModelId(m.modelId);
                    setModelMenuOpen(false);
                    inputRef.current?.focus();
                  }}
                  data-testid={`welcome-model-option-${m.modelId || 'default'}`}
                >
                  <span className="menu-check">{m.modelId === modelId ? <Icon icon={Check} size="sm" /> : null}</span>
                  <span className="truncate">{m.name}</span>
                </button>
              ))}
              {models.length === 0 && (
                <div className="menu-foot" role="note" data-testid="welcome-model-pending">
                  {ui.v034.newSessionModelCatalogPending}
                </div>
              )}
            </div>
          )}
        </div>
        <span className="welcome-quick-hint">{starting ? ui.welcomeQuickStarting : ui.welcomeQuickHint}</span>
        <button
          type="button"
          className="welcome-quick-send"
          disabled={!text.trim() || starting}
          onClick={() => void submit()}
          aria-label={ui.welcomeQuickSend}
          title={ui.welcomeQuickSend}
          data-testid="welcome-quick-send"
        >
          <Icon icon={ArrowUp} size="md" />
        </button>
      </div>
      {error && (
        <div role="alert" className="welcome-quick-error">
          {error}
        </div>
      )}
    </div>
  );
}

function WelcomePane({
  slotIndex,
  compact,
  appIcon,
  sessions,
  recentCwds = [],
  defaultCwd = '',
  onOpenNewSession,
  onBindSlotSession,
  onSelectDirectory,
  onQuickStart,
  models,
  theme,
  customTheme,
}: {
  slotIndex: number;
  compact: boolean;
  appIcon: GravityIconPreference;
  models?: AcpModelOption[];
  theme?: ThemePreference;
  customTheme?: CustomThemeConfig;
  sessions: ManagedSessionSummary[];
  recentCwds?: string[];
  defaultCwd?: string;
  onOpenNewSession: () => void;
  onBindSlotSession: (slotIndex: number, sessionId: string) => void;
  onSelectDirectory?: (defaultPath?: string) => Promise<string | null>;
  onQuickStart?: (cwd: string, text: string, slotIndex: number, options?: QuickStartOptions) => Promise<void>;
}): React.ReactElement {
  const { dict, shortcut } = useI18n();
  const icon = resolveGravityIconVariant(appIcon, theme, customTheme);
  const recent = [...sessions]
    .filter((s) => !s.parentBranchId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, compact ? 3 : 5);
  return (
    <div className="pane" data-testid={`empty-pane-${slotIndex}`}>
      <div className={`welcome ${compact ? 'welcome-compact' : ''}${onQuickStart ? ' has-quick' : ''}`}>
        <div className="welcome-hero">
          <div className="welcome-logo-wrap">
            <img className="welcome-logo" src={icon.publicSvgUrl} alt="" />
          </div>
          <h1 className="welcome-title">{compact ? dict.emptyPaneTitle : dict.welcomeTitle}</h1>
          {!onQuickStart && (
            <button type="button" className="btn btn-primary welcome-cta" onClick={onOpenNewSession}>
              <Icon icon={Plus} size="md" />
              <span>{dict.newSession}</span>
              {!compact && <span className="kbd welcome-cta-kbd">{shortcut('N', 'keycap')}</span>}
            </button>
          )}
        </div>
        {onQuickStart && (
          <>
            <WelcomeQuickComposer
              slotIndex={slotIndex}
              compact={compact}
              recentCwds={recentCwds}
              defaultCwd={defaultCwd}
              onSelectDirectory={onSelectDirectory}
              onQuickStart={onQuickStart}
              models={models}
            />
            <div className="welcome-actions">
              <button type="button" className="btn btn-ghost btn-sm welcome-cta" onClick={onOpenNewSession}>
                <Icon icon={Plus} size="sm" />
                <span>{dict.newSession}</span>
                {!compact && <span className="kbd welcome-cta-kbd">{shortcut('N', 'keycap')}</span>}
              </button>
            </div>
          </>
        )}
        {recent.length > 0 && (
          <div className="recent-list">
            <div className="recent-label">{dict.recentThreadsTitle}</div>
            {recent.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                className="recent-item"
                onClick={() => onBindSlotSession(slotIndex, s.activeBranchId || s.sessionId)}
                title={s.cwd}
                data-testid={`recent-thread-${slotIndex}-${s.sessionId}`}
              >
                <span className={`status-dot is-${s.status}`} />
                <span className="thread-title truncate recent-title">
                  {s.title}
                </span>
                <span className="recent-folder mono truncate">
                  {folderName(s.cwd)}
                </span>
                <span className="thread-time">{formatRelativeTime(s.updatedAt, dict)}</span>
              </button>
            ))}
          </div>
        )}
        {!compact && (
          <div className="welcome-shortcuts" aria-hidden="true">
            <span><kbd className="kbd">{shortcut('B', 'keycap')}</kbd> {dict.shortcutLabels.sidebar}</span>
            <span><kbd className="kbd">{shortcut('\\', 'keycap')}</kbd> {dict.shortcutLabels.split}</span>
            <span><kbd className="kbd">{shortcut('J', 'keycap')}</kbd> {dict.shortcutLabels.inspector}</span>
            <span><kbd className="kbd">{shortcut(',', 'keycap')}</kbd> {dict.shortcutLabels.settings}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 单条消息 */

/** 按消息角色选择展示组件。用户附件、系统提示与助手的正文和工具活动各自使用对应布局。 */
const MessageTurn = React.memo(function MessageTurn({
  message,
  defaultThoughtTrack,
  turnStartedAt,
  onRevise,
  onContinueInterrupted,
  forkControl,
  switchingBranch,
  onSwitchBranch,
  onOpenTreeInspector,
  editRequest, latest,
  busy,
  onInspectDiff,
  diagnosticHandlers,
  isLatestAssistant,
  sessionStatus,
  dismissedDiagnostics,
  suppressDiagnostic,
}: {
  message: ChatMessageItem;
  defaultThoughtTrack: ThoughtDisplayTrack;
  turnStartedAt?: string;
  latest?: boolean; editRequest?: number;
  onRevise?: SessionPaneProps['onReviseMessage'];
  onContinueInterrupted?: () => Promise<void>;
  diagnosticHandlers?: (stop: TurnStopState) => DiagnosticHandlers;
  isLatestAssistant?: boolean;
  sessionStatus?: ManagedSessionSummary['status'];
  dismissedDiagnostics?: Set<string>;
  /** 紧随其后的助手消息（中间无用户回合）已显示同类诊断卡时隐藏本条，避免两张卡片叠放。 */
  suppressDiagnostic?: boolean;
  forkControl?: MessageForkControl | null;
  switchingBranch?: boolean;
  onSwitchBranch?: (rootSessionId: string, targetBranchId: string) => void;
  onOpenTreeInspector?: (sessionId: string) => void;
  busy: boolean;
  onInspectDiff: (filePath: string) => void;
}): React.ReactElement | null {
  const { dict } = useI18n();
  if (message.question) {
    const q = message.question;
    if (q.state === 'open') return null;
    return <div className="question-history" data-message-id={message.id}><strong>{q.message}</strong>
      <div>{q.answer || (q.state === 'declined' ? dict.ui.v034.questionSkipped : dict.ui.v034.questionCancelled)}</div>
      {message.questionFollowup && <QuestionFollowupStatus sessionId={message.sessionId} followup={message.questionFollowup} />}</div>;
  }
  if (message.role === 'user') {
    const body = (
      <div className="cc-user-prompt" data-testid={`user-msg-${message.id}`} data-message-id={message.id}>
        <span className="cc-user-chevron">&gt;</span>
        <div className="cc-user-body" data-message-body="true">
          {message.references?.length ? (
            <div className="cc-user-chips">
              {message.references?.map((r) => (
                <span key={`${r.kind}-${r.value}`} className="badge badge-accent badge-mono">
                  @{r.label}
                </span>
              ))}
            </div>
          ) : null}
          <SentAnnotations items={message.annotations} />
          <Markdown text={message.content} attachments={message.attachments} />
          {message.questionFollowup && <QuestionFollowupStatus sessionId={message.sessionId} followup={message.questionFollowup} />}
        </div>
      </div>
    );
    const branchBar = forkControl ? (
      <div className="branch-switcher" data-testid={`branch-switcher-${message.id}`}>
        <button
          type="button"
          className="branch-switch-btn"
          disabled={busy || switchingBranch || !forkControl.prevBranchId}
          onClick={() => forkControl.prevBranchId && onSwitchBranch?.(forkControl.rootSessionId, forkControl.prevBranchId)}
          aria-label={dict.ui.v034.prevBranch}
          title={dict.ui.v034.prevBranchTitle}
          data-testid={`branch-prev-${message.id}`}
        >
          <Icon icon={ChevronLeft} size="xs" />
        </button>
        <span className="branch-switch-counter" data-testid={`branch-counter-${message.id}`}>
          {forkControl.currentIndex + 1} / {forkControl.totalCount}
        </span>
        <button
          type="button"
          className="branch-switch-btn"
          disabled={busy || switchingBranch || !forkControl.nextBranchId}
          onClick={() => forkControl.nextBranchId && onSwitchBranch?.(forkControl.rootSessionId, forkControl.nextBranchId)}
          aria-label={dict.ui.v034.nextBranch}
          title={dict.ui.v034.nextBranchTitle}
          data-testid={`branch-next-${message.id}`}
        >
          <Icon icon={ChevronRight} size="xs" />
        </button>
        {onOpenTreeInspector && (
          <button
            type="button"
            className="branch-tree-jump-btn"
            onClick={() => onOpenTreeInspector(message.sessionId)}
            title={dict.ui.v034.viewTreeTitle}
            data-testid={`branch-open-tree-${message.id}`}
          >
            <Icon icon={GitBranch} size="xs" />
            <span>{dict.ui.v034.treeShort}</span>
          </button>
        )}
      </div>
    ) : null;
    if (onRevise) {
      return (
        <div className="editable-turn">
          <EditUserMessage message={message} editRequest={editRequest} latest={latest} busy={busy} submit={onRevise}>
            {body}
          </EditUserMessage>
          {branchBar}
        </div>
      );
    }
    return branchBar ? <div className="editable-turn is-readonly">{body}{branchBar}</div> : body;
  }

  if (message.role === 'system') {
    const tone = SYSTEM_WARNING_RE.test(message.content) ? 'warning' : 'info';
    return (
      <div className={`cc-system tone-${tone}`}>
        {tone === 'warning' ? <Icon icon={AlertTriangle} size="sm" /> : <Icon icon={Info} size="sm" />}
        <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
      </div>
    );
  }

  const hasBody =
    message.content ||
    message.attachments?.length ||
    message.thoughts?.length ||
    message.toolCalls?.length ||
    message.todos?.length ||
    message.autoResumeFailure ||
    message.turnStop;
  if (!hasBody) return null;

  const { content: cleanContent, trailing: interrupted } = inspectStreamInterruption(message.content || '');
  // 结构化诊断优先；旧消息只有中断标记或自动续接失败记录时，按同一张卡片呈现。
  let stop: TurnStopState | undefined = message.isStreaming ? undefined : message.turnStop;
  let legacyLead: string | undefined;
  const stamp = message.completedAt || message.createdAt;
  if (!message.isStreaming && message.autoResumeFailure && (!stop || stop.code === 'auto_resume_failed' || stop.code === 'stream_interrupted')) {
    stop = stop ?? buildDiagnosticBanner('auto_resume_failed', { technicalDetail: message.autoResumeFailure.detail, occurredAt: stamp });
    legacyLead = dict.ui.copy.theAutomaticContinuationCouldNot;
  } else if (!stop && interrupted && !message.isStreaming) {
    stop = buildDiagnosticBanner('stream_interrupted', { occurredAt: stamp });
    legacyLead = dict.ui.copy.theStreamWasInterruptedBefore;
  }
  const stopKey = stop ? `${message.id}:${stop.code}` : '';
  const showStop = Boolean(stop) && !suppressDiagnostic && !dismissedDiagnostics?.has(stopKey);
  const streamCompat = stop && (stop.code === 'stream_interrupted' || stop.code === 'auto_resume_failed');
  const handlers: DiagnosticHandlers = stop && isLatestAssistant && diagnosticHandlers ? diagnosticHandlers(stop) : {};
  if (stop && isLatestAssistant && onContinueInterrupted && !handlers.continue_turn && stop.actions.includes('continue_turn')) {
    handlers.continue_turn = onContinueInterrupted;
  }
  const card = stop && showStop ? (
    <TurnDiagnosticCard
      banner={stop}
      handlers={handlers}
      busy={busy}
      compact={!isLatestAssistant}
      legacyLead={legacyLead}
      continueLabel={streamCompat ? (dict.ui.copy.continue) : undefined}
      continueTestId={streamCompat ? `stream-continue-btn-${message.id}` : undefined}
    />
  ) : null;
  const todos = message.todos ?? [];
  const doneTodos = todos.filter((t) => t.status === 'completed').length;
  const unconfirmedTurn = isTurnUnconfirmed(message, { isLatestAssistant, sessionStatus });
  const settledTurn = Boolean(message.turnSettledAt || message.turnStop);
  return (
    <div
      className={`cc-assistant ${message.isStreaming ? 'is-streaming' : 'is-settled'}`}
      data-message-id={message.id}
    >
      {message.thoughts?.map((th) => (
        <ThinkingBlock key={th.id} thought={th} defaultTrack={defaultThoughtTrack} />
      ))}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolActivityStream
          tools={message.toolCalls}
          onInspectDiff={onInspectDiff}
          settled={settledTurn}
          unconfirmed={unconfirmedTurn}
        />
      )}
      {todos.length > 0 && (
        <div className="cc-todos" data-testid={`inline-todos-${message.id}`}>
          <div className="cc-todos-head">
            <span className="cc-tool-dot status-completed">⏺</span>
            <span>Update Todos</span>
            <span className="cc-todos-progress" aria-hidden="true">
              <span style={{ '--fill': doneTodos / todos.length } as React.CSSProperties} />
            </span>
            <span className="muted" style={{ fontWeight: 400 }}>
              {doneTodos}/{todos.length}
            </span>
          </div>
          {todos.map((td) => (
            <div key={td.id} className={`cc-todo is-${td.status}`}>
              <span className="cc-todo-box">
                {td.status === 'completed' ? '☒' : td.status === 'in_progress' ? '◼' : '☐'}
              </span>
              <span>{td.content}</span>
            </div>
          ))}
        </div>
      )}
      {(cleanContent || message.attachments?.length) ? (
        <div className="cc-text" data-message-body="true" data-testid={`assistant-body-${message.id}`}>
          <span className={`cc-bullet ${message.isStreaming ? 'is-streaming' : ''}`}>⏺</span>
          <Markdown text={cleanContent} attachments={message.attachments} streaming={message.isStreaming} />
        </div>
      ) : null}
      {interrupted && message.isStreaming && (
        <div className="stream-interrupted-banner is-waiting" data-testid={`stream-interrupted-${message.id}`}>
          <Icon icon={RotateCw} size="sm" className="stream-interrupted-icon spin" />
          <span className="stream-interrupted-text">
            {dict.ui.copy.streamBrieflyInterruptedWaitingTo}
          </span>
        </div>
      )}
      {card && (streamCompat ? (
        <div className="stream-interrupted-banner is-card" data-testid={`stream-interrupted-${message.id}`}>{card}</div>
      ) : card)}
      {!message.isStreaming && (!message.toolCalls?.length || unconfirmedTurn) && (
        <TurnOutcomeBar
          message={message}
          turnStartedAt={turnStartedAt}
          isLatestAssistant={isLatestAssistant}
          sessionStatus={sessionStatus}
          onInspectDiff={onInspectDiff}
        />
      )}
      {/* v0.3.2：含工具调用的回合已结算、存在失败/被拦截工具却没有 turnStop 时，底部给出明确的结束状态，杜绝「看似卡死」。 */}
      {!card && (
        <TurnSettledStrip
          message={message}
          turnStartedAt={turnStartedAt}
          busy={busy}
          hasReply={Boolean(cleanContent.trim() || message.attachments?.length)}
          onContinue={isLatestAssistant ? onContinueInterrupted : undefined}
        />
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ 会话窗格 */

function SessionPaneImpl(props: SessionPaneProps): React.ReactElement {
  const {
    slotIndex,
    layoutMode,
    isFocused,
    session,
    availableSessions,
    messages,
    pendingApprovals,
    defaultThoughtTrack,
    telemetryDashboard,
    conversationTree,
    switchingBranch,
    swarmState,
    scrollMemoryRef,
    onFocusPane,
    onBindSlotSession,
    onSubmitApproval,
    onSwitchBranch,
    onOpenTreeInspector,
    onOpenSwarmInspector,
    onInspectDiffFile,
  } = props;
  const { locale, dict } = useI18n();
  const streamRef = useRef<HTMLDivElement | null>(null);
  const selectionRange = useRef<Range | null>(null);
  const stickToBottomRef = useRef(true);
  const { quotes: sessionQuotes, notes: sessionNotations, update: updateDraft, takeSubmitted } =
    useAnnotationDraft(session?.profileId || 'default', session?.sessionId || '');
  const [editRequest, setEditRequest] = useState({ id: '', seq: 0 });
  useLayoutEffect(() => {
    if (streamRef.current) return showAnnotationRanges(streamRef.current, sessionNotations);
  }, [messages, sessionNotations]);
  const [selectionBar, setSelectionBar] = useState<{
    x: number;
    y: number;
    messageId: string;
    text: string;
    start?: number;
    anchorText?: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    detected: DetectedContextTarget;
  } | null>(null);
  const [composerFocusSeq, setComposerFocusSeq] = useState(0);
  const [openTargetError, setOpenTargetError] = useState<string | null>(null);
  const [, setDismissedQuestionSeq] = useState(0);
  const [questionSendError, setQuestionSendError] = useState<{ id: string; message: string }>();
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [hasUnseen, setHasUnseen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [dismissedDiagnostics, setDismissedDiagnostics] = useState<Set<string>>(() => new Set());
  const beforePrepend = useRef<{ height: number; top: number; count: number } | null>(null);
  const skipFollow = useRef(false);
  const restoringScroll = useRef(false);

  useEffect(() => {
    if (!selectionBar && !contextMenu) return;
    function handleGlobalDown(e: MouseEvent): void {
      const target = e.target as HTMLElement | null;
      // 严禁在点击右击菜单或划词悬浮窗内部按钮时提前销毁节点，确保 mousedown -> mouseup -> click 完整触发
      if (target?.closest('.target-context-menu, .selection-floating-bar')) {
        return;
      }
      setContextMenu(null);
      const sel = window.getSelection();
      if (!sel || !sel.toString().trim()) {
        setSelectionBar(null);
      }
    }
    function handleGlobalKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setSelectionBar(null);
      }
    }
    window.addEventListener('mousedown', handleGlobalDown);
    window.addEventListener('keydown', handleGlobalKey);
    return () => {
      window.removeEventListener('mousedown', handleGlobalDown);
      window.removeEventListener('keydown', handleGlobalKey);
    };
  }, [selectionBar, contextMenu]);

  useEffect(() => {
    setSelectionBar(null);
    setContextMenu(null);
    setOpenTargetError(null);
    setHasUnseen(false);
    setQuestionSendError(undefined);
    setStopping(false);
  }, [session?.sessionId]);

  // 「正在停止…」只持续到回合真正结束（会话离开生成 / 待审批 / 待回答状态）。
  const sessionStatus = session?.status;
  useEffect(() => {
    if (sessionStatus !== 'streaming' && sessionStatus !== 'waiting_approval' && sessionStatus !== 'waiting_question') setStopping(false);
  }, [sessionStatus]);

  const onCancelPromptProp = props.onCancelPrompt;
  /** 统一的停止入口：立即显示「正在停止…」，失败时恢复并把错误交给调用方。 */
  const requestStop = useCallback(async (sessionId: string) => {
    setStopping(true);
    try {
      await onCancelPromptProp(sessionId);
    } catch (err) {
      setStopping(false);
      throw err;
    }
  }, [onCancelPromptProp]);

  // 在浏览器绘制前恢复当前会话的滚动位置，并按距离底部的像素数决定要不要继续跟随流式输出。
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !session) return;
    const saved = scrollMemoryRef.current[session.sessionId];
    el.scrollTop = typeof saved === 'number' ? saved : el.scrollHeight;
    stickToBottomRef.current = typeof saved !== 'number' || el.scrollHeight - saved - el.clientHeight < 80;
    // 切回已向上滚动的会话时同步显示「回到底部」，且挂载 / 切换本身不算「有新内容」。
    setAwayFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 240);
    restoringScroll.current = true;
  }, [session?.sessionId, scrollMemoryRef]);

  useLayoutEffect(() => {
    const prior = beforePrepend.current;
    const el = streamRef.current;
    const earlier = props.messagePosition?.earlierCount;
    if (!prior || !el || !session || prior.count === earlier) return;
    beforePrepend.current = null;
    if (earlier === undefined || earlier > prior.count) return;
    el.scrollTop = prior.top + el.scrollHeight - prior.height;
    scrollMemoryRef.current[session.sessionId] = el.scrollTop;
    stickToBottomRef.current = false;
    skipFollow.current = true;
  }, [props.messagePosition?.earlierCount, session, scrollMemoryRef]);

  // Stage 2 复核卡片挂载/卸载时也算新内容。只取本会话复核中请求的 id 组合，
  // 复核耗时等字段刷新不会反复触发跟随或“有新内容”提示。
  const reviewingFollowKey = (props.reviewingApprovals ?? [])
    .filter((r) => r.sessionId === session?.sessionId && r.status === 'reviewing')
    .map((r) => r.requestId)
    .join('|');

  // 只有本窗格的待审卡片组合变化才算新内容；其他会话的审批或本会话元数据（标题、用量）刷新不会误触发提示。
  const approvalFollowKey = pendingApprovals
    .filter((p) => p.sessionId === session?.sessionId)
    .map((p) => p.requestId)
    .join('|');
  const followSessionId = session?.sessionId;

  // 新内容（包括流式增量、新出现的 Guardian 复核卡片）到达时，若用户停留在底部则保持跟随；否则提示有新内容
  useEffect(() => {
    const el = streamRef.current;
    if (!el || !followSessionId) return;
    if (skipFollow.current) { skipFollow.current = false; return; }
    if (restoringScroll.current) {
      restoringScroll.current = false;
      if (!stickToBottomRef.current) return;
    }
    if (selectionBar || !stickToBottomRef.current) {
      setHasUnseen(true);
      return;
    }
    el.scrollTop = el.scrollHeight;
    scrollMemoryRef.current[followSessionId] = el.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, approvalFollowKey, reviewingFollowKey, followSessionId, scrollMemoryRef]);

  // F-09：打字机逐帧显影、图片加载撑高等不改变消息数组的增高同样保持粘底（ResizeObserver + rAF 合批）。
  const selectionBarRef = useRef(selectionBar);
  selectionBarRef.current = selectionBar;
  const pauseFollow = useCallback(() => Boolean(selectionBarRef.current), []);
  const rememberFollow = useCallback(
    (top: number) => {
      if (followSessionId) scrollMemoryRef.current[followSessionId] = top;
    },
    [followSessionId, scrollMemoryRef]
  );
  const markUnseen = useCallback(() => setHasUnseen(true), []);
  useStickToBottom(streamRef, stickToBottomRef, {
    enabled: Boolean(followSessionId),
    contentSelector: '.stream-inner',
    paused: pauseFollow,
    onFollow: rememberFollow,
    onUnseen: markUnseen,
  });

  // F-14：一次遍历预计算全部用户消息的分叉控件，避免逐条 O(n) 扫描（O(n²)）。
  const forkControls = useMemo(
    () =>
      session
        ? buildForkControlMap(conversationTree, session.sessionId, messages, props.messagePosition)
        : new Map<string, MessageForkControl>(),
    [conversationTree, session?.sessionId, messages, props.messagePosition]
  );

  // 窗格级 Esc：焦点在窗格内任意位置（非输入框弹层 / 菜单 / 模态）时中断当前回合，与 WorkingIndicator 的提示一致。
  const paneTurnActive = session?.status === 'streaming' || session?.status === 'waiting_approval';
  useEffect(() => {
    if (!isFocused || !followSessionId || !paneTurnActive || session?.readOnly) return;
    function onKey(e: KeyboardEvent): void {
      // macOS 输入法用 Esc 取消候选时同样派发 keydown（isComposing 或 keyCode 229），不能借此中断回合。
      if (e.key !== 'Escape' || e.defaultPrevented || isImeComposing(e)) return;
      if (document.querySelector('dialog[open], [aria-modal="true"], .popover, [role="menu"], .target-context-menu, .selection-floating-bar')) return;
      const target = e.target instanceof Element ? e.target : null;
      // 批注编辑、窗格会话切换下拉、拒绝反馈框等局部控件的 Esc 只取消自身，绝不连带中止运行中的回合。
      if (target?.closest('.composer-input, .question-bar, .message-editor, .turn-notation-edit-row, .pane-switch, .feedback-box')) return;
      // 任何表单控件（窗格内外，Composer 输入框由其自身处理）里的 Esc 都留给该控件。
      const editable = target instanceof HTMLElement && (/^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
      if (editable) return;
      e.preventDefault();
      void requestStop(followSessionId!).catch((err) => setOpenTargetError(formatActionError(err, dict)));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dict, followSessionId, isFocused, paneTurnActive, requestStop, session?.readOnly]);

  function jumpToLatest(): void {
    const el = streamRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
    else el.scrollTop = el.scrollHeight;
    setAwayFromBottom(false);
    setHasUnseen(false);
  }

  if (!session) {
    return (
      <WelcomePane
        slotIndex={slotIndex}
        compact={layoutMode !== 'single'}
        appIcon={props.appIcon}
        sessions={availableSessions}
        recentCwds={props.recentCwds}
        defaultCwd={props.defaultWorkspaceCwd}
        onOpenNewSession={props.onOpenNewSession}
        onBindSlotSession={onBindSlotSession}
        onSelectDirectory={props.onSelectDirectory}
        onQuickStart={props.onQuickStart}
        models={props.newSessionModels ?? props.availableModels}
        theme={props.theme}
        customTheme={props.customTheme}
      />
    );
  }

  const sessionApprovals = pendingApprovals.filter((p) => p.sessionId === session.sessionId);
  const pendingIds = new Set(sessionApprovals.map((p) => p.requestId));
  // 已转入 Stage 3 的请求不再显示复核中卡片，避免同一请求同时出现两张卡。
  const sessionReviews = (props.reviewingApprovals ?? []).filter(
    (r) => r.sessionId === session.sessionId && r.status === 'reviewing' && !pendingIds.has(r.requestId)
  );
  // 消息内嵌卡片与窗格末尾的待审队列可能指向同一请求，用该集合避免一张卡片出现两次。
  const renderedApprovalIds = new Set<string>();
  // 按渲染顺序，只有第一张待审批卡片响应数字快捷键
  const primaryShortcutRequestId = (() => {
    for (const m of messages) {
      if (m.pendingApprovalId && sessionApprovals.some((a) => a.requestId === m.pendingApprovalId)) {
        return m.pendingApprovalId;
      }
    }
    return sessionApprovals[0]?.requestId ?? null;
  })();

  /** 从当前选区找到所属消息并定位浮动按钮。优先使用选区边界。读不到矩形时使用鼠标坐标。 */
  function handleStreamMouseUp(e: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>): void {
    if ('button' in e && e.button !== 0) return;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    const selectedText = sel?.toString().trim() ?? '';
    if (!selectedText || selectedText.length < 1) {
      setSelectionBar(null);
      return;
    }

    const anchorEl =
      sel?.anchorNode instanceof HTMLElement
        ? sel.anchorNode
        : sel?.anchorNode?.parentElement ?? (e.target as HTMLElement | null);
    const bodyEl = anchorEl?.closest('[data-message-body="true"]') as HTMLElement | null;
    const msgWrap = (bodyEl ?? anchorEl)?.closest('[data-message-id]') as HTMLElement | null;
    const range = sel?.rangeCount ? sel.getRangeAt(0) : undefined;
    if (!bodyEl || !msgWrap || !streamRef.current?.contains(bodyEl) ||
        (range && (!bodyEl.contains(range.startContainer) || !bodyEl.contains(range.endContainer)))) {
      setSelectionBar(null);
      return;
    }

    const messageId = msgWrap.getAttribute('data-message-id') || '';
    if (!messageId) return;

    selectionRange.current = range?.cloneRange() || null;
    const prefix = range?.cloneRange();
    if (prefix && range) { prefix.selectNodeContents(bodyEl); prefix.setEnd(range.startContainer, range.startOffset); }
    let x = 'clientX' in e ? e.clientX : 120;
    let y = Math.max(16, ('clientY' in e ? e.clientY : 120) - 44);
    try {
      if (sel && sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect && (rect.width > 0 || rect.height > 0)) {
          x = rect.left + Math.min(rect.width / 2, 120);
          y = Math.max(14, rect.top - 42);
        }
      }
    } catch {
      /* fallback to pointer coords */
    }

    setContextMenu(null);
    setSelectionBar({ x, y, messageId, text: selectedText, start: prefix?.toString().length, anchorText: range?.toString() });
  }

  function handleStreamContextMenu(e: React.MouseEvent<HTMLDivElement>): void {
    const detected = detectContextTargetFromElement(e.target as HTMLElement | null);
    if (!detected) return;
    e.preventDefault();
    setSelectionBar(null);
    setContextMenu({
      x: e.clientX || 140,
      y: e.clientY || 140,
      detected,
    });
  }

  /** 引用按会话存放，并保留来源消息的 ID。加入引用后将焦点交给输入框，便于继续填写问题。 */
  function addQuoteFromSelection(): void {
    if (!selectionBar || !session) return;
    const item: TextQuoteItem = {
      id: `qt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      messageId: selectionBar.messageId,
      text: selectionBar.text,
    };
    updateDraft(d => ({ ...d, quotes: [...d.quotes, item] }));
    window.getSelection()?.removeAllRanges();
    setSelectionBar(null);
    setComposerFocusSeq((n) => n + 1);
  }

  function addNotationFromSelection(comment: string): void {
    if (!selectionBar || !session) return;
    const item: TextNotationItem = {
      id: `nt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      messageId: selectionBar.messageId,
      selectedText: selectionBar.text,
      messageNumber: (props.messagePosition?.earlierVisibleCount || 0) + messages.filter(m => m.content && (m.role === 'user' || m.role === 'assistant')).findIndex(m => m.id === selectionBar.messageId) + 1,
      start: selectionBar.start, anchorText: selectionBar.anchorText,
      comment,
      createdAt: new Date().toISOString(),
    };
    updateDraft(d => ({ ...d, notes: [...d.notes, item] }));
    window.getSelection()?.removeAllRanges();
    setSelectionBar(null);
  }

  // 生成状态可能先于助手的首个分片抵达。只有末条消息还未显示流式回复时才额外展示等待状态。
  const last = messages[messages.length - 1];
  let questionIndex = messages.length - 1;
  while (questionIndex >= 0 && messages[questionIndex].sendFailed) questionIndex--;
  const lastDelivered = messages[questionIndex];
  const nativeQuestion = messages.find(m => m.question?.state === 'open');
  const questionSource = nativeQuestion || (lastDelivered?.role === 'assistant' && !lastDelivered.question && !lastDelivered.isStreaming &&
    (session.status === 'idle' || session.status === 'error') && !lastDelivered.revisionHistory &&
    !isQuestionDismissed(session.profileId, session.sessionId, lastDelivered.id) ? lastDelivered : undefined);
  const question = questionSource?.question || (questionSource ? writtenQuestion(questionSource.content) : undefined);
  const dismissActiveProseQuestion = (targetId?: string) => {
    const idToDismiss = targetId || (!nativeQuestion && questionSource ? questionSource.id : undefined);
    if (!idToDismiss) return;
    markQuestionDismissed(session.profileId, session.sessionId, idToDismiss);
    setDismissedQuestionSeq((v) => v + 1);
  };
  const showWorking =
    session.status === 'streaming' && !(last && last.role === 'assistant' && last.isStreaming);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user' && !m.sendFailed);
  const paneBusy = session.status === 'streaming' || session.status === 'waiting_approval' || stopping;
  const continueText = dict.ui.v031.continuePrompt;

  function focusFirstApproval(): void {
    const card = streamRef.current?.querySelector<HTMLElement>('.inline-request, [data-testid^="inline-request"]');
    if (!card) throw new Error(dict.ui.v031.noApprovalPending);
    card.scrollIntoView?.({ block: 'center', behavior: scrollBehavior() });
    card.querySelector<HTMLElement>('button')?.focus();
  }

  function focusQuestionBar(): void {
    const bar = document.querySelector<HTMLElement>(`[data-testid="session-pane-${session!.sessionId}"] .question-bar`);
    bar?.scrollIntoView?.({ block: 'nearest' });
    bar?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
  }

  /** 诊断卡片的一键恢复动作。只做导航与用户明确发起的重试，从不自动切换账号。 */
  const diagnosticHandlers = (stop: TurnStopState | SessionDiagnosticBanner, dismissKey?: string): DiagnosticHandlers => {
    const id = session.sessionId;
    const handlers: DiagnosticHandlers = {};
    if (!session.readOnly) {
      handlers.continue_turn = () => props.onSendPrompt({ sessionId: id, text: continueText });
      handlers.retry_turn = () => lastUserMessage?.content && !lastUserMessage.attachments?.length
        ? props.onSendPrompt({ sessionId: id, text: lastUserMessage.content, references: lastUserMessage.references })
        : props.onSendPrompt({ sessionId: id, text: continueText });
      handlers.compact_context = () => props.onCompactContext(id);
      if (lastUserId && props.onReviseMessage) {
        handlers.edit_last_message = () => setEditRequest((e) => ({ id: lastUserId!, seq: e.seq + 1 }));
      }
    }
    handlers.reconnect_session = props.onReconnectSession
      ? () => props.onReconnectSession!(id)
      : () => onBindSlotSession(slotIndex, id);
    if (props.onLaunchOfficialLogin) handlers.launch_official_login = () => props.onLaunchOfficialLogin!();
    if (props.onOpenAccountSettings) handlers.open_accounts_settings = () => props.onOpenAccountSettings!();
    handlers.open_approval_settings = () => props.onOpenApprovalSettings();
    handlers.new_session = () => props.onOpenNewSession();
    handlers.scroll_to_approval = focusFirstApproval;
    handlers.focus_question_bar = focusQuestionBar;
    handlers.dismiss = () => setDismissedDiagnostics((prev) => new Set(prev).add(dismissKey ?? `session:${stop.code}:${stop.occurredAt}`));
    return handlers;
  };

  // 会话级诊断：后端横幅优先；错误态会话（即便未进入只读）提供重连入口；429/403 冷却来自实时连接状态。
  const sessionBanner: SessionDiagnosticBanner | undefined = (() => {
    if (session.diagnostic) return session.diagnostic;
    if (session.status === 'error') {
      return buildDiagnosticBanner(
        props.connection?.lastErrorCode === 'auth_required_401' ? 'auth_required_401' : 'acp_disconnected',
        { technicalDetail: props.connection?.connected === false ? props.connection.lastError : undefined, occurredAt: session.updatedAt,
          exitCode: props.connection?.lastExitCode, signal: props.connection?.lastSignal }
      );
    }
    const conn = props.connection;
    const until = conn?.cooldownUntil ? Date.parse(conn.cooldownUntil) : NaN;
    if (conn && Number.isFinite(until) && until > Date.now() &&
        (conn.lastErrorCode === 'rate_limited_429' || conn.lastErrorCode === 'permission_denied_403')) {
      return buildDiagnosticBanner(conn.lastErrorCode, { cooldownUntil: conn.cooldownUntil, technicalDetail: conn.lastError, occurredAt: conn.cooldownUntil });
    }
    return undefined;
  })();
  const latestStopCode = messages.find((m) => m.id === lastAssistantId)?.turnStop?.code;
  const sessionBannerKey = sessionBanner ? `session:${session.sessionId}:${sessionBanner.code}:${sessionBanner.occurredAt}` : '';
  const showSessionBanner = Boolean(sessionBanner) && !dismissedDiagnostics.has(sessionBannerKey) &&
    !(latestStopCode && latestStopCode === sessionBanner!.code && !session.diagnostic?.cooldownUntil);

  // 每条助手消息对应的回合起点 = 它之前最近一条用户消息的时间
  const turnStartById = new Map<string, string>();
  let lastUserId: string | undefined;
  let lastUserAt: string | undefined;
  for (const m of messages) {
    if (m.role === 'user') {
      lastUserAt = m.createdAt;
      // 发送失败的消息不能作为「编辑上一条消息」的目标。
      if (!m.sendFailed) lastUserId = m.id;
    } else if (m.role === 'assistant' && lastUserAt) turnStartById.set(m.id, lastUserAt);
  }
  // P3-3：续接后仍以同一原因停止时，相邻两条助手消息会各显示一张诊断卡；只保留后一条。
  const supersededDiagnosticIds = new Set<string>();
  let previousStop: { id: string; code: string } | undefined;
  for (const m of messages) {
    if (m.role === 'user') { previousStop = undefined; continue; }
    if (m.role !== 'assistant') continue;
    const code = m.turnStop?.code;
    if (code && previousStop?.code === code) supersededDiagnosticIds.add(previousStop.id);
    previousStop = code ? { id: m.id, code } : undefined;
  }

  return (
    <div
      className={`pane ${isFocused ? 'is-focused' : ''}`}
      data-pane-state={sessionApprovals.length ? 'waiting_approval' : session.status}
      onMouseDown={() => onFocusPane(session.sessionId)}
      onFocusCapture={() => onFocusPane(session.sessionId)}
      data-testid={`session-pane-${session.sessionId}`}
    >
      <span className="pane-activity-rail" aria-hidden="true"><span /></span>
      <header className="pane-header">
        {/* T2：单栏时顶部标签已显示同一状态点，窗格头不再重复 */}
        {layoutMode !== 'single' && <span className={`status-dot is-${sessionApprovals.length ? 'waiting_approval' : session.status}`} />}
        <span className="pane-title truncate" title={session.title}>
          {session.title}
        </span>
        <span className="pane-sub truncate" title={session.cwd}>
          <Icon icon={FolderGit2} size="xs" />
          <span className="truncate">{folderName(session.cwd)}</span>
        </span>
        <span className="spacer" />
        <PaneStatusChip
          sessionId={session.sessionId}
          status={session.status}
          pendingApprovals={sessionApprovals.length}
          turnStartedAt={lastUserAt}
          stopping={stopping}
        />
        {conversationTree && conversationTree.totalBranches > 1 && (
          <button
            type="button"
            className="badge badge-branch"
            style={{ cursor: 'pointer' }}
            onClick={() => onOpenTreeInspector?.(session.sessionId)}
            title={dict.ui.v034.branchPillTitle}
            data-testid={`pane-branch-pill-${session.sessionId}`}
          >
            <Icon icon={GitBranch} size="xs" />
            <span>
              {dict.ui.copy.fmtBranch(Math.max(1, conversationTree.nodes.findIndex((n) => n.branchId === session.sessionId) + 1), conversationTree.totalBranches)}
            </span>
          </button>
        )}
        {swarmState?.isActive && swarmState.stats.total > 0 && (
          <button
            type="button"
            className="badge badge-accent"
            style={{ cursor: 'pointer' }}
            onClick={() => onOpenSwarmInspector(session.sessionId)}
            data-testid={`swarm-active-pill-${session.sessionId}`}
          >
            <Icon icon={Network} size="xs" />
            <span>{dict.swarmActivePill(swarmState.stats.total, swarmState.stats.working)}</span>
          </button>
        )}
        {layoutMode !== 'single' && availableSessions.filter((s) => !s.parentBranchId).length > 1 && (
          <select
            className="select-chip pane-switch"
            aria-label={dict.switchPaneSession}
            value={session.sessionId}
            onChange={(e) => onBindSlotSession(slotIndex, e.target.value)}
          >
            {availableSessions
              .filter((s) => !s.parentBranchId)
              .map((s) => {
                const currentRootId = session.rootSessionId || session.sessionId;
                const optionValue = s.sessionId === currentRootId ? session.sessionId : (s.activeBranchId || s.sessionId);
                return (
                  <option key={s.sessionId} value={optionValue}>
                    {s.title}
                  </option>
                );
              })}
          </select>
        )}
      </header>

      {props.sessionLoadErrors?.[session.sessionId] && (
        <div className="pane-load-error" role="alert" data-testid={`pane-load-error-${session.sessionId}`}>
          <Icon icon={AlertTriangle} size="sm" />
          <span className="truncate" title={props.sessionLoadErrors[session.sessionId]}>
            {dict.ui.v034.paneLoadFailed} · {props.sessionLoadErrors[session.sessionId]}
          </span>
          {props.onRetrySessionLoad && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => props.onRetrySessionLoad?.(session.sessionId)}
              data-testid={`pane-load-retry-${session.sessionId}`}
            >
              <Icon icon={RotateCw} size="xs" />
              <span>{dict.ui.v034.paneLoadRetry}</span>
            </button>
          )}
        </div>
      )}

      <div className="stream-viewport">
        <div
          ref={streamRef}
          className="stream"
          onMouseUp={handleStreamMouseUp}
          onKeyUp={e => { if (e.shiftKey) handleStreamMouseUp(e); }}
          onContextMenu={handleStreamContextMenu}
          onScroll={(e) => {
            const el = e.currentTarget;
            scrollMemoryRef.current[session.sessionId] = el.scrollTop;
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            stickToBottomRef.current = nearBottom;
            const away = el.scrollHeight - el.scrollTop - el.clientHeight > 240;
            if (away !== awayFromBottom) setAwayFromBottom(away);
            if (nearBottom && hasUnseen) setHasUnseen(false);
            const anchor = selectionRange.current;
            if (selectionBar && anchor && typeof anchor.getBoundingClientRect === 'function') {
              const rect = anchor.getBoundingClientRect();
              const x = rect.left + Math.min(rect.width / 2, 120);
              const y = Math.max(14, rect.top - 42);
              setSelectionBar(prev => prev && (prev.x !== x || prev.y !== y) ? { ...prev, x, y } : prev);
            }
            if (contextMenu) setContextMenu(null);
          }}
        >
          <div className="stream-inner">
            {props.messagePosition?.historyIndexUnavailable && (
              <div role="status" className="muted">{dict.ui.v034.historyIndexPartial}</div>
            )}
            {Boolean(props.messagePosition?.earlierCount) && props.onLoadEarlier && (
              <button type="button" className="btn btn-ghost" data-testid="load-earlier-messages" onClick={async () => {
                const el = streamRef.current;
                if (!el || beforePrepend.current) return;
                const anchor = { height: el.scrollHeight, top: el.scrollTop, count: props.messagePosition!.earlierCount };
                beforePrepend.current = anchor;
                const loaded = await props.onLoadEarlier!(session.sessionId);
                if (!loaded && beforePrepend.current === anchor) beforePrepend.current = null;
              }}>{dict.ui.v034.loadEarlier}</button>
            )}
            {openTargetError && (
              <div role="alert" className="alert" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{openTargetError}</span>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  onClick={() => setOpenTargetError(null)}
                  aria-label={dict.closeAction}
                >
                  <Icon icon={X} size="xs" />
                </button>
              </div>
            )}
            {messages.map((msg) => {
              const linked = msg.pendingApprovalId
                ? sessionApprovals.find((a) => a.requestId === msg.pendingApprovalId)
                : undefined;
              if (linked) renderedApprovalIds.add(linked.requestId);
              const turnNotations = sessionNotations.filter((n) => n.messageId === msg.id);
              const forkControl = msg.role === 'user' ? forkControls.get(msg.id) ?? null : null;
              const turn = (
                <ImageSessionContext.Provider value={session.sessionId}><ImageWorkspace.Provider value={session.cwd}><MessageTurn
                  message={msg}
                  latest={msg.id === lastUserId}
                  editRequest={editRequest.id === msg.id ? editRequest.seq : 0}
                  onRevise={session.readOnly ? undefined : props.onReviseMessage}
                  forkControl={forkControl}
                  switchingBranch={switchingBranch}
                  onSwitchBranch={onSwitchBranch}
                  onOpenTreeInspector={onOpenTreeInspector}
                  onContinueInterrupted={
                    session.readOnly || msg.id !== lastAssistantId
                      ? undefined
                      : () => props.onSendPrompt({ sessionId: session.sessionId, text: continueText })
                  }
                  diagnosticHandlers={(stop) => diagnosticHandlers(stop, `${msg.id}:${stop.code}`)}
                  isLatestAssistant={msg.id === lastAssistantId}
                  sessionStatus={session.status}
                  dismissedDiagnostics={dismissedDiagnostics}
                  suppressDiagnostic={supersededDiagnosticIds.has(msg.id)}
                  busy={paneBusy}
                  defaultThoughtTrack={defaultThoughtTrack}
                  turnStartedAt={turnStartById.get(msg.id)}
                  onInspectDiff={(fp) => onInspectDiffFile(session.sessionId, fp)}
                /></ImageWorkspace.Provider></ImageSessionContext.Provider>
              );
              return (
                <div key={msg.id} className={`turn turn-${msg.role}`}>
                  {turn}
                  {turnNotations.length > 0 && (
                    <TurnNotationPins
                      items={turnNotations}
                      allNotations={sessionNotations}
                      locale={locale}
                      onUpdate={(id, comment) => updateDraft(d => ({ ...d, notes: d.notes.map(n => n.id === id ? { ...n, comment } : n) }))}
                      onRemove={id => updateDraft(d => ({ ...d, notes: d.notes.filter(n => n.id !== id) }))}
                    />
                  )}
                  {linked && (
                    <InlineRequestView
                      key={linked.requestId}
                      request={linked}
                      enableNumericShortcuts={isFocused && linked.requestId === primaryShortcutRequestId}
                      onSubmitDecision={onSubmitApproval}
                    />
                  )}
                </div>
              );
            })}

            {sessionApprovals
              .filter((req) => !renderedApprovalIds.has(req.requestId))
              .map((req) => (
                <InlineRequestView
                  key={req.requestId}
                  request={req}
                  enableNumericShortcuts={isFocused && req.requestId === primaryShortcutRequestId}
                  onSubmitDecision={onSubmitApproval}
                />
              ))}

            {sessionReviews.map((review) => (
              <GuardianReviewingCard key={review.requestId} event={review} onTakeOver={props.onCancelStage2Review} />
            ))}

            {showSessionBanner && sessionBanner && (
              <div className="session-diagnostic" data-testid={`session-diagnostic-${session.sessionId}`}>
                <TurnDiagnosticCard
                  banner={sessionBanner}
                  handlers={diagnosticHandlers(sessionBanner, sessionBannerKey)}
                  busy={paneBusy}
                />
              </div>
            )}

            {(showWorking || (stopping && paneTurnActive)) && sessionReviews.length === 0 && (
              <WorkingIndicator startedAt={lastUserAt} stopping={stopping} />
            )}
          </div>
        </div>

        {awayFromBottom && (
          <button
            type="button"
            className={`jump-latest ${hasUnseen ? 'has-unseen' : ''}`}
            onClick={jumpToLatest}
            data-testid={`jump-latest-${session.sessionId}`}
          >
            <Icon icon={ArrowDown} size="sm" />
            <span>{hasUnseen ? dict.ui.newActivity : dict.ui.backToLatest}</span>
          </button>
        )}
      </div>

      {selectionBar && (
        <SelectionFloatingBar
          x={selectionBar.x}
          y={selectionBar.y}
          selectedText={selectionBar.text}
          locale={locale}
          onQuote={addQuoteFromSelection}
          onAddNotation={addNotationFromSelection}
          onDismiss={() => setSelectionBar(null)}
        />
      )}

      {contextMenu && (
        <TargetContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          detected={contextMenu.detected}
          cwd={session.cwd}
          sessionId={session.sessionId}
          locale={locale}
          onClose={() => setContextMenu(null)}
          onError={(msg) => setOpenTargetError(msg)}
        />
      )}

      {!session.readOnly && question && questionSource && <QuestionBar key={questionSource.id} question={question}
        draftKey={JSON.stringify([session.profileId, session.sessionId, questionSource.id])} native={Boolean(nativeQuestion)}
        sendError={questionSendError?.id === questionSource.id ? questionSendError.message : undefined}
        submit={async reply => {
          if (nativeQuestion) {
            // v2 主进程返回幂等回执；旧主进程返回 void，两者均兼容
            return await getDesktopBridge().answerQuestion({ sessionId: session.sessionId, messageId: nativeQuestion.id, ...reply });
          } else {
            if (reply.action === 'accept') {
              setQuestionSendError(undefined);
              try {
                await props.onSendPrompt({ sessionId: session.sessionId, text: reply.customReply! });
              } catch (err) {
                // A provisional outgoing message can unmount this form before the send fails.
                setQuestionSendError({ id: questionSource.id, message: formatActionError(err, dict) });
                throw err;
              }
            }
            dismissActiveProseQuestion(questionSource.id);
          }
        }} />}
      {session.readOnly ? <div className="composer-dock">
        <div className="composer-wrap">
          <div className="offline-conversation">
            <span>{dict.ui.v034.viewingSaved}</span>
            <button type="button" className="btn btn-sm" onClick={() => onBindSlotSession(slotIndex, session.sessionId)}>
              {dict.ui.v034.reconnect}
            </button>
            {session.hasApprovalGrants && props.onClearSessionApprovals && (
              <button type="button" className="btn btn-sm" onClick={() => {
                void props.onClearSessionApprovals!(session.sessionId).catch(error => setOpenTargetError(formatActionError(error, dict)));
              }}>{dict.clearSessionApprovals}</button>
            )}
          </div>
          <AccountQuotaFooter
            key={session.profileId}
            profileId={session.profileId}
            isIsolatedProfile={props.isIsolatedProfile}
            connection={props.connection}
          />
        </div>
      </div> : <Composer
        session={session}
        isIsolatedProfile={props.isIsolatedProfile}
        connection={props.connection}
        availableSessions={availableSessions}
        availableModels={props.availableModels}
        modelListSource={props.modelListSource}
        approvalConfig={props.approvalConfig}
        latestAudit={props.latestAudit}
        sessionTelemetry={telemetryDashboard.activeSessions[session.sessionId]}
        treeCost={computeConversationTreeTotalCost(session.sessionId, conversationTree, telemetryDashboard)}
        externalReviewerTelemetry={telemetryDashboard.externalReviewer}
        autoFocus={isFocused && sessionApprovals.length === 0}
        quotes={sessionQuotes}
        notations={sessionNotations}
        focusTrigger={composerFocusSeq}
        onEditLast={lastUserId && props.onReviseMessage ? () => setEditRequest(e => ({ id: lastUserId!, seq: e.seq + 1 })) : undefined}
        onRemoveQuote={id => updateDraft(d => ({ ...d, quotes: d.quotes.filter(q => q.id !== id) }))}
        onRemoveNotation={id => updateDraft(d => ({ ...d, notes: d.notes.filter(n => n.id !== id) }))}
        onSubmitAnnotations={takeSubmitted}
        onSendPrompt={async (input) => {
          await props.onSendPrompt(input);
          if (!nativeQuestion && question && questionSource) dismissActiveProseQuestion(questionSource.id);
        }}
        onCancelPrompt={requestStop}
        stopping={stopping}
        onCompactContext={props.onCompactContext}
        onSetSessionMode={props.onSetSessionMode}
        onSetSessionEffort={props.onSetSessionEffort}
        onSetSessionModel={props.onSetSessionModel}
        onQueryWorkspaceFiles={props.onQueryWorkspaceFiles}
        onCycleApprovalMode={props.onCycleApprovalMode}
        onClearSessionApprovals={props.onClearSessionApprovals}
        onOpenApprovalSettings={props.onOpenApprovalSettings}
        onOpenExternalReviewerSettings={props.onOpenExternalReviewerSettings}
        onOpenReviewerStats={props.onOpenReviewerStats ? () => props.onOpenReviewerStats!(session.sessionId) : undefined}
        onOpenContextInspector={() => props.onOpenContextInspector(session.sessionId)}
      />}
    </div>
  );
}

function areSessionPanePropsEqual(prev: SessionPaneProps, next: SessionPaneProps): boolean {
  const keys = Object.keys(next) as Array<keyof SessionPaneProps>;
  if (keys.length !== Object.keys(prev).length) return false;
  for (const key of keys) {
    const a = prev[key];
    const b = next[key];
    if (Object.is(a, b)) continue;
    // Empty inline arrays (e.g. `availableModels={[]}` / `pendingApprovals={[]}`) carry identical semantics.
    if (Array.isArray(a) && Array.isArray(b) && a.length === 0 && b.length === 0) continue;
    return false;
  }
  return true;
}

/** F-08：浅比较 props，其它会话流式更新时本窗格跳过提交（父级已稳定回调与派生数组）。 */
export const SessionPane = React.memo(SessionPaneImpl, areSessionPanePropsEqual);
