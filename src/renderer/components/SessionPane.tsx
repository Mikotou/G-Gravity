import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, FolderGit2, Info, Network, Plus, X } from 'lucide-react';
import {
  type AcpModelOption,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type ApprovalAuditEntry,
  type ApprovalDecisionSubmission,
  type ApprovalMode,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type GravityIconId,
  type ManagedSessionSummary,
  type PendingApprovalRequest,
  type SendPromptInput,
  type SwarmTopologyState,
  type TelemetryDashboardSnapshot,
  type ThoughtDisplayTrack,
  type WorkspaceSplitMode,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatRelativeTime } from '../i18n/locales';
import { resolveGravityIconVariant } from '../styles/theme';
import { Composer } from './Composer';
import { InlineRequestView } from './InlineRequestView';
import type { ReviseMessageInput } from '@shared';
import { useAnnotationDraft, showAnnotationRanges } from '../lib/annotation-drafts';
import { EditUserMessage } from './EditUserMessage';
import { ImageWorkspace } from './MessageImage';
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
import { SentAnnotations } from './SentAnnotations';
import { ThinkingBlock } from './ThinkingBlock';
import { AccountQuotaFooter } from './AccountQuotaView';
import { PaneStatusChip, ToolActivityStream, TurnOutcomeBar } from './TurnActivity';
import { WorkingIndicator } from './WorkingIndicator';

export interface SessionPaneProps {
  slotIndex: number;
  layoutMode: WorkspaceSplitMode;
  isFocused: boolean;
  session: ManagedSessionSummary | null;
  availableSessions: ManagedSessionSummary[];
  availableModels: AcpModelOption[];
  messages: ChatMessageItem[];
  pendingApprovals: PendingApprovalRequest[];
  latestAudit?: ApprovalAuditEntry;
  approvalConfig: ApproveForMeConfig;
  defaultThoughtTrack: ThoughtDisplayTrack;
  telemetryDashboard: TelemetryDashboardSnapshot;
  swarmState?: SwarmTopologyState;
  scrollMemoryRef: React.MutableRefObject<Record<string, number>>;
  canTriggerDemoApproval: boolean;
  appIcon: GravityIconId;
  onFocusPane: (sessionId: string | null) => void;
  onBindSlotSession: (slotIndex: number, sessionId: string) => void;
  onOpenNewSession: () => void;
  onReviseMessage?: (input: ReviseMessageInput) => Promise<void>;
  onSendPrompt: (input: SendPromptInput) => Promise<void>;
  onCancelPrompt: (sessionId: string) => Promise<void>;
  onCompactContext: (sessionId: string) => Promise<void>;
  onSetSessionMode: (sessionId: string, mode: AgentExecutionMode) => Promise<void>;
  onSetSessionEffort: (sessionId: string, effort: AgentReasoningEffort) => Promise<void>;
  onSetSessionModel: (sessionId: string, modelId: string) => Promise<void>;
  onQueryWorkspaceFiles: (cwd: string, query?: string) => Promise<string[]>;
  onSubmitApproval: (submission: ApprovalDecisionSubmission) => Promise<void>;
  onCycleApprovalMode: (nextMode: ApprovalMode) => Promise<void>;
  onOpenApprovalSettings: () => void;
  onOpenSwarmInspector: (sessionId: string) => void;
  onOpenContextInspector: (sessionId: string) => void;
  onInspectDiffFile: (sessionId: string, filePath: string) => void;
  onTriggerDemoApproval: (sessionId: string) => void;
}

function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

/* ------------------------------------------------------------------ 欢迎 / 空窗格 */

function WelcomePane({
  slotIndex,
  compact,
  appIcon,
  sessions,
  onOpenNewSession,
  onBindSlotSession,
}: {
  slotIndex: number;
  compact: boolean;
  appIcon: GravityIconId;
  sessions: ManagedSessionSummary[];
  onOpenNewSession: () => void;
  onBindSlotSession: (slotIndex: number, sessionId: string) => void;
}): React.ReactElement {
  const { dict } = useI18n();
  const icon = resolveGravityIconVariant(appIcon);
  const recent = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, compact ? 3 : 5);
  return (
    <div className="pane" data-testid={`empty-pane-${slotIndex}`}>
      <div className={`welcome ${compact ? 'welcome-compact' : ''}`}>
        <img className="welcome-logo" src={icon.publicSvgUrl} alt="" />
        <h1 className="welcome-title">{compact ? dict.emptyPaneTitle : dict.welcomeTitle}</h1>
        <button type="button" className="btn btn-primary" onClick={onOpenNewSession}>
          <Plus size={14} />
          <span>{dict.newSession}</span>
        </button>
        {recent.length > 0 && (
          <div className="recent-list">
            <div className="recent-label">{dict.recentThreadsTitle}</div>
            {recent.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                className="recent-item"
                onClick={() => onBindSlotSession(slotIndex, s.sessionId)}
                title={s.cwd}
                data-testid={`recent-thread-${slotIndex}-${s.sessionId}`}
              >
                <span className={`status-dot is-${s.status}`} />
                <span className="thread-title truncate" style={{ flex: 1 }}>
                  {s.title}
                </span>
                <span className="muted mono truncate" style={{ fontSize: 11, maxWidth: 120 }}>
                  {folderName(s.cwd)}
                </span>
                <span className="thread-time">{formatRelativeTime(s.updatedAt, dict)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 单条消息 */

/** 按消息角色选择展示组件。用户附件、系统提示与助手的正文和工具活动各自使用对应布局。 */
function MessageTurn({
  message,
  defaultThoughtTrack,
  turnStartedAt,
  onRevise,
  editRequest, latest,
  busy,
  onInspectDiff,
}: {
  message: ChatMessageItem;
  defaultThoughtTrack: ThoughtDisplayTrack;
  turnStartedAt?: string;
  latest?: boolean; editRequest?: number;
  onRevise?: SessionPaneProps['onReviseMessage'];
  busy: boolean;
  onInspectDiff: (filePath: string) => void;
}): React.ReactElement | null {
  const { locale } = useI18n();
  if (message.question) {
    const q = message.question;
    if (q.state === 'open') return null;
    return <div className="question-history" data-message-id={message.id}><strong>{q.message}</strong>
      <div>{q.answer || (locale === 'zh-CN' ? (q.state === 'declined' ? '已跳过' : '已取消') :
        (q.state === 'declined' ? 'Skipped' : 'Cancelled'))}</div></div>;
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
        </div>
      </div>
    );
    return onRevise ? <div className="editable-turn"><EditUserMessage message={message} editRequest={editRequest} latest={latest} busy={busy} submit={onRevise}>{body}</EditUserMessage></div> : body;
  }

  if (message.role === 'system') {
    const tone = /拒绝|失败|错误|限流|429|403|rejected|failed|error|rate.?limit/i.test(message.content)
      ? 'warning'
      : 'info';
    return (
      <div className={`cc-system tone-${tone}`}>
        {tone === 'warning' ? <AlertTriangle size={13} /> : <Info size={13} />}
        <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
      </div>
    );
  }

  const hasBody =
    message.content ||
    message.attachments?.length ||
    message.thoughts?.length ||
    message.toolCalls?.length ||
    message.todos?.length;
  if (!hasBody) return null;

  const todos = message.todos ?? [];
  const doneTodos = todos.filter((t) => t.status === 'completed').length;
  return (
    <div
      className={`cc-assistant ${message.isStreaming ? 'is-streaming' : 'is-settled'}`}
      data-message-id={message.id}
    >
      {message.thoughts?.map((th) => (
        <ThinkingBlock key={th.id} thought={th} defaultTrack={defaultThoughtTrack} />
      ))}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolActivityStream tools={message.toolCalls} onInspectDiff={onInspectDiff} />
      )}
      {todos.length > 0 && (
        <div className="cc-todos" data-testid={`inline-todos-${message.id}`}>
          <div className="cc-todos-head">
            <span className="cc-tool-dot status-completed">⏺</span>
            <span>Update Todos</span>
            <span className="cc-todos-progress" aria-hidden="true">
              <span style={{ width: `${(doneTodos / todos.length) * 100}%` }} />
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
      {(message.content || message.attachments?.length) ? (
        <div className="cc-text" data-message-body="true" data-testid={`assistant-body-${message.id}`}>
          <span className={`cc-bullet ${message.isStreaming ? 'is-streaming' : ''}`}>⏺</span>
          <Markdown text={message.content} attachments={message.attachments} streaming={message.isStreaming} />
        </div>
      ) : null}
      {!message.isStreaming && !message.toolCalls?.length && (
        <TurnOutcomeBar message={message} turnStartedAt={turnStartedAt} onInspectDiff={onInspectDiff} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 会话窗格 */

export function SessionPane(props: SessionPaneProps): React.ReactElement {
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
    swarmState,
    scrollMemoryRef,
    onFocusPane,
    onBindSlotSession,
    onSubmitApproval,
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
  const [dismissedQuestion, setDismissedQuestion] = useState<string>();
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [hasUnseen, setHasUnseen] = useState(false);

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
    setAwayFromBottom(false);
    setHasUnseen(false);
  }, [session?.sessionId]);

  // 在浏览器绘制前恢复当前会话的滚动位置，并按距离底部的像素数决定要不要继续跟随流式输出。
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !session) return;
    const saved = scrollMemoryRef.current[session.sessionId];
    el.scrollTop = typeof saved === 'number' ? saved : el.scrollHeight;
    stickToBottomRef.current = typeof saved !== 'number' || el.scrollHeight - saved - el.clientHeight < 80;
  }, [session?.sessionId, scrollMemoryRef]);

  // 新内容（包括流式增量）到达时，若用户停留在底部则保持跟随；否则提示有新内容
  useEffect(() => {
    const el = streamRef.current;
    if (!el || !session) return;
    if (selectionBar || !stickToBottomRef.current) {
      setHasUnseen(true);
      return;
    }
    el.scrollTop = el.scrollHeight;
    scrollMemoryRef.current[session.sessionId] = el.scrollTop;
  }, [messages, pendingApprovals, session, scrollMemoryRef]);

  function jumpToLatest(): void {
    const el = streamRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
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
        onOpenNewSession={props.onOpenNewSession}
        onBindSlotSession={onBindSlotSession}
      />
    );
  }

  const sessionApprovals = pendingApprovals.filter((p) => p.sessionId === session.sessionId);
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
      messageNumber: messages.filter(m => m.content && (m.role === 'user' || m.role === 'assistant')).findIndex(m => m.id === selectionBar.messageId) + 1,
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
  const nativeQuestion = messages.find(m => m.question?.state === 'open');
  const questionSource = nativeQuestion || (last?.role === 'assistant' && !last.question && !last.isStreaming &&
    session.status === 'idle' && !last.revisionHistory && last.id !== dismissedQuestion ? last : undefined);
  const question = questionSource?.question || (questionSource ? writtenQuestion(questionSource.content) : undefined);
  const showWorking =
    session.status === 'streaming' && !(last && last.role === 'assistant' && last.isStreaming);

  // 每条助手消息对应的回合起点 = 它之前最近一条用户消息的时间
  const turnStartById = new Map<string, string>();
  let lastUserId: string | undefined;
  let lastUserAt: string | undefined;
  for (const m of messages) {
    if (m.role === 'user') { lastUserAt = m.createdAt; lastUserId = m.id; }
    else if (m.role === 'assistant' && lastUserAt) turnStartById.set(m.id, lastUserAt);
  }

  return (
    <div
      className={`pane ${isFocused ? 'is-focused' : ''}`}
      data-pane-state={sessionApprovals.length ? 'waiting_approval' : session.status}
      onMouseDown={() => onFocusPane(session.sessionId)}
      data-testid={`session-pane-${session.sessionId}`}
    >
      <header className="pane-header">
        <span className={`status-dot is-${sessionApprovals.length ? 'waiting_approval' : session.status}`} />
        <span className="pane-title truncate" title={session.title}>
          {session.title}
        </span>
        <span className="pane-sub truncate" title={session.cwd}>
          <FolderGit2 size={11} />
          <span className="truncate">{folderName(session.cwd)}</span>
        </span>
        <span className="spacer" />
        <PaneStatusChip
          sessionId={session.sessionId}
          status={session.status}
          pendingApprovals={sessionApprovals.length}
          turnStartedAt={lastUserAt}
        />
        {swarmState?.isActive && (
          <button
            type="button"
            className="badge badge-accent"
            style={{ cursor: 'pointer' }}
            onClick={() => onOpenSwarmInspector(session.sessionId)}
            data-testid={`swarm-active-pill-${session.sessionId}`}
          >
            <Network size={11} />
            <span>{dict.swarmActivePill(swarmState.stats.total, swarmState.stats.working)}</span>
          </button>
        )}
        {layoutMode !== 'single' && availableSessions.length > 1 && (
          <select
            className="select-chip pane-switch"
            aria-label={dict.switchPaneSession}
            value={session.sessionId}
            onChange={(e) => onBindSlotSession(slotIndex, e.target.value)}
          >
            {availableSessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.title}
              </option>
            ))}
          </select>
        )}
      </header>

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
            {openTargetError && (
              <div role="alert" className="alert" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{openTargetError}</span>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  onClick={() => setOpenTargetError(null)}
                  aria-label={dict.closeAction}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {messages.map((msg) => {
              const linked = msg.pendingApprovalId
                ? sessionApprovals.find((a) => a.requestId === msg.pendingApprovalId)
                : undefined;
              if (linked) renderedApprovalIds.add(linked.requestId);
              const turnNotations = sessionNotations.filter((n) => n.messageId === msg.id);
              const turn = (
                <ImageWorkspace.Provider value={session.cwd}><MessageTurn
                  message={msg}
                  latest={msg.id === lastUserId}
                  editRequest={editRequest.id === msg.id ? editRequest.seq : 0}
                  onRevise={session.readOnly ? undefined : props.onReviseMessage}
                  busy={session.status === 'streaming' || session.status === 'waiting_approval'}
                  defaultThoughtTrack={defaultThoughtTrack}
                  turnStartedAt={turnStartById.get(msg.id)}
                  onInspectDiff={(fp) => onInspectDiffFile(session.sessionId, fp)}
                /></ImageWorkspace.Provider>
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

            {showWorking && <WorkingIndicator startedAt={lastUserAt} />}
          </div>
        </div>

        {awayFromBottom && (
          <button
            type="button"
            className={`jump-latest ${hasUnseen ? 'has-unseen' : ''}`}
            onClick={jumpToLatest}
            data-testid={`jump-latest-${session.sessionId}`}
          >
            <ArrowDown size={13} />
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
        submit={async reply => {
          if (nativeQuestion) {
            await getDesktopBridge().answerQuestion({ sessionId: session.sessionId, messageId: nativeQuestion.id, ...reply });
          } else {
            if (reply.action === 'accept') await props.onSendPrompt({ sessionId: session.sessionId, text: reply.customReply! });
            setDismissedQuestion(questionSource.id);
          }
        }} />}
      {session.readOnly ? <div className="composer-dock">
        <div className="composer-wrap">
          <div className="offline-conversation">
            <span>{locale === 'zh-CN' ? '正在查看本机保存的对话' : 'Viewing the saved conversation'}</span>
            <button type="button" className="btn btn-sm" onClick={() => onBindSlotSession(slotIndex, session.sessionId)}>
              {locale === 'zh-CN' ? '重新连接' : 'Reconnect'}
            </button>
          </div>
          <AccountQuotaFooter key={session.profileId} profileId={session.profileId} />
        </div>
      </div> : <Composer
        session={session}
        availableSessions={availableSessions}
        availableModels={props.availableModels}
        approvalConfig={props.approvalConfig}
        latestAudit={props.latestAudit}
        sessionTelemetry={telemetryDashboard.activeSessions[session.sessionId]}
        canTriggerDemoApproval={props.canTriggerDemoApproval}
        autoFocus={isFocused && sessionApprovals.length === 0}
        quotes={sessionQuotes}
        notations={sessionNotations}
        focusTrigger={composerFocusSeq}
        onEditLast={lastUserId && props.onReviseMessage ? () => setEditRequest(e => ({ id: lastUserId!, seq: e.seq + 1 })) : undefined}
        onRemoveQuote={id => updateDraft(d => ({ ...d, quotes: d.quotes.filter(q => q.id !== id) }))}
        onRemoveNotation={id => updateDraft(d => ({ ...d, notes: d.notes.filter(n => n.id !== id) }))}
        onSubmitAnnotations={takeSubmitted}
        onSendPrompt={props.onSendPrompt}
        onCancelPrompt={props.onCancelPrompt}
        onCompactContext={props.onCompactContext}
        onSetSessionMode={props.onSetSessionMode}
        onSetSessionEffort={props.onSetSessionEffort}
        onSetSessionModel={props.onSetSessionModel}
        onQueryWorkspaceFiles={props.onQueryWorkspaceFiles}
        onCycleApprovalMode={props.onCycleApprovalMode}
        onOpenApprovalSettings={props.onOpenApprovalSettings}
        onOpenContextInspector={() => props.onOpenContextInspector(session.sessionId)}
        onTriggerDemoApproval={props.onTriggerDemoApproval}
      />}
    </div>
  );
}
