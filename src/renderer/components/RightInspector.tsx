import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  FileCode2,
  FileDiff,
  GitBranch,
  Layers,
  ListTodo,
  Network,
  PanelRight,
  PanelRightClose,
  SquareTerminal,
} from 'lucide-react';
import type {
  ChatMessageItem,
  ConversationTreeState,
  FileDiffEntry,
  RightInspectorTab,
  SessionInspectorData,
  SessionTerminalEntry,
  SessionTodoItem,
  SwarmTopologyState,
  TelemetryDashboardSnapshot,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { ContextCostInspectorView, type ContextInspectorViewMode } from './ContextCostInspectorView';
import { ConversationTreePanel } from './ConversationTreePanel';
import { ResizeHandle } from './ResizeHandle';
import { SwarmPanel } from './SwarmPanel';
import { UnifiedDiffBlock } from './UnifiedDiffBlock';

import { terminalCommand } from '../../shared/session-contract';

export interface RightInspectorProps {
  collapsed: boolean;
  width: number;
  floating?: boolean;
  activeTab: RightInspectorTab;
  contextViewMode?: ContextInspectorViewMode;
  onChangeContextViewMode?: (mode: ContextInspectorViewMode) => void;
  reviewerConnected?: boolean;
  onOpenExternalReviewerSettings?: () => void;
  focusedDiffFile: string | null;
  sessionId: string | null;
  profileId?: string;
  inspectorData?: SessionInspectorData;
  sessionMessages: ChatMessageItem[];
  telemetry: TelemetryDashboardSnapshot;
  conversationTree?: ConversationTreeState;
  sessionBusy?: boolean;
  switchingBranch?: boolean;
  onSwitchBranch?: (rootSessionId: string, targetBranchId: string) => void;
  swarmTopology?: SwarmTopologyState;
  onSelectTab: (tab: RightInspectorTab) => void;
  onFocusDiffFile: (filePath: string) => void;
  onCommitWidth: (width: number) => void;
  onToggleFloating?: (floating: boolean) => void;
  onCollapse?: () => void;
  onLaunchSwarmTask?: (sessionId: string, taskBrief: string) => Promise<void>;
  onOpenRateCardsSettings: () => void;
}

const INSPECTOR_FLOAT_KEY = 'gravity.inspector.floating';
function readInspectorFloating(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_FLOAT_KEY) === 'true';
  } catch {
    return false;
  }
}
function saveInspectorFloating(floating: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_FLOAT_KEY, floating ? 'true' : 'false');
  } catch {
    /* 本次会话内保持即可 */
  }
}

const TABS: ReadonlyArray<{ id: RightInspectorTab; Icon: typeof FileDiff }> = [
  { id: 'diff', Icon: FileDiff },
  { id: 'plan', Icon: ListTodo },
  { id: 'terminal', Icon: SquareTerminal },
  { id: 'context', Icon: BarChart3 },
  { id: 'tree', Icon: GitBranch },
  { id: 'swarm', Icon: Network },
];

const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 380;
/** 常规屏幕上限 680px；宽屏（如 2K / 4K）允许拉到窗口一半，最高 1000px。 */
function maxInspectorWidth(): number {
  const viewport = typeof window !== 'undefined' ? window.innerWidth : 1280;
  return Math.max(680, Math.min(1000, Math.round(viewport * 0.5)));
}

export function RightInspector({
  collapsed,
  width,
  floating: floatingProp,
  activeTab,
  contextViewMode,
  onChangeContextViewMode,
  reviewerConnected,
  onOpenExternalReviewerSettings,
  focusedDiffFile,
  sessionId,
  profileId = 'default',
  inspectorData,
  sessionMessages,
  telemetry,
  conversationTree,
  sessionBusy,
  switchingBranch,
  onSwitchBranch,
  swarmTopology,
  onSelectTab,
  onFocusDiffFile,
  onCommitWidth,
  onToggleFloating,
  onCollapse,
  onLaunchSwarmTask,
  onOpenRateCardsSettings,
}: RightInspectorProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const ui = dict.ui;
  const [liveWidth, setLiveWidth] = useState<number>(width || DEFAULT_WIDTH);
  const [floating, setFloating] = useState<boolean>(() =>
    floatingProp !== undefined ? floatingProp : readInspectorFloating()
  );
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabScroll, setTabScroll] = useState({ overflow: false, canLeft: false, canRight: false });

  const syncTabScroll = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 2;
    const canLeft = overflow && el.scrollLeft > 1;
    const canRight = overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setTabScroll((prev) =>
      prev.overflow === overflow && prev.canLeft === canLeft && prev.canRight === canRight
        ? prev
        : { overflow, canLeft, canRight }
    );
  }, []);

  const scrollTabsBy = useCallback(
    (delta: number) => {
      const el = tabsRef.current;
      if (!el) return;
      el.scrollLeft = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, el.scrollLeft + delta));
      syncTabScroll();
    },
    [syncTabScroll]
  );

  const handleTabsWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const el = tabsRef.current;
      if (!el || el.scrollWidth <= el.clientWidth + 2) return;
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      e.preventDefault();
      el.scrollLeft += delta;
      syncTabScroll();
    },
    [syncTabScroll]
  );

  useEffect(() => {
    syncTabScroll();
    const el = tabsRef.current;
    if (!el) return;
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => syncTabScroll());
      ro.observe(el);
    }
    window.addEventListener('resize', syncTabScroll);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', syncTabScroll);
    };
  }, [liveWidth, floating, collapsed, syncTabScroll]);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const activeEl = el.querySelector<HTMLElement>('.inspector-tab.is-active');
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    syncTabScroll();
  }, [activeTab, syncTabScroll]);

  useEffect(() => {
    if (width) setLiveWidth(width);
  }, [width]);

  useEffect(() => {
    if (floatingProp !== undefined) {
      setFloating(floatingProp);
      saveInspectorFloating(floatingProp);
    }
  }, [floatingProp]);

  function toggleFloating(): void {
    setFloating((prev) => {
      const next = !prev;
      saveInspectorFloating(next);
      onToggleFloating?.(next);
      return next;
    });
  }

  // 只统计已完成的文件改动，挂起 / 失败的工具调用不算变更
  const diffs = useMemo<FileDiffEntry[]>(() => {
    // 先读检视快照，再按路径合并消息中的已完成补丁。同一文件只显示最后放入的版本。
    const map = new Map<string, FileDiffEntry>();
    for (const d of inspectorData?.diffs ?? []) map.set(d.filePath, d);
    for (const m of sessionMessages) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.diffPatch && tc.status === 'completed') map.set(tc.diffPatch.filePath, tc.diffPatch);
      }
    }
    return Array.from(map.values());
  }, [inspectorData?.diffs, sessionMessages]);

  // 计划优先使用检视快照。早期记录缺少该快照时，从最近的消息向前找已有的待办列表。
  const todos = useMemo<SessionTodoItem[]>(() => {
    if (inspectorData?.todos?.length) return inspectorData.todos;
    for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
      const list = sessionMessages[i].todos;
      if (list?.length) return list;
    }
    return [];
  }, [inspectorData?.todos, sessionMessages]);

  const terminals = useMemo<SessionTerminalEntry[]>(() => {
    // 用现有终端快照中的工具调用号识别已收录条目，再从消息中的 Bash 输出补齐缺项。
    const list: SessionTerminalEntry[] = [...(inspectorData?.terminals ?? [])];
    const byTool = new Map(list.map((t, index) => [t.toolCallId, index]));
    for (const m of sessionMessages) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.canonicalToolName !== 'Bash') continue;
        const command = terminalCommand(tc);
        const index = byTool.get(tc.toolCallId);
        if (index !== undefined) {
          if (command.length > list[index].command.length) list[index] = { ...list[index], command };
        } else if (tc.status !== 'pending') {
          byTool.set(tc.toolCallId, list.length);
          list.push({
            id: `term-${tc.toolCallId}`,
            toolCallId: tc.toolCallId,
            command,
            output: tc.outputPreview || '',
            status: tc.status,
            exitCode: tc.exitCode,
            timestamp: tc.completedAt || tc.startedAt,
          });
        }
      }
    }
    return list;
  }, [inspectorData?.terminals, sessionMessages]);

  const readKey = 'gravity.terminal.read.' + profileId + '.' + sessionId;
  const seen = useMemo(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem(readKey) || '[]')); }
    catch { return new Set<string>(); }
  }, [readKey]);
  const visibleTerminal = !collapsed && activeTab === 'terminal';
  const terminalKeys = useMemo(() => terminals.map(entry => {
    // Incremental output can replace a line without changing its length.
    let hash = 0;
    for (let i = 0; i < entry.output.length; i++) hash = (Math.imul(31, hash) + entry.output.charCodeAt(i)) | 0;
    return [entry.toolCallId, entry.status, entry.exitCode, entry.timestamp, hash].join('/');
  }), [terminals]);
  const unread = visibleTerminal ? [] : terminals.filter((_, i) => !seen.has(terminalKeys[i]));
  useEffect(() => {
    if (!sessionId || !visibleTerminal || terminalKeys.every(key => seen.has(key))) return;
    seen.clear();
    terminalKeys.forEach(key => seen.add(key));
    try { localStorage.setItem(readKey, JSON.stringify(terminalKeys)); } catch { /* Keep the in-memory read state. */ }
  }, [readKey, seen, sessionId, terminalKeys, visibleTerminal]);
  const failedTerminals = unread.filter(
    (t) => t.status === 'failed' || (t.exitCode !== undefined && t.exitCode !== 0)
  ).length;
  // 失败命令优先展示，其余按时间倒序，最新的在最上面
  const orderedTerminals = useMemo(() => {
    const isFailed = (t: SessionTerminalEntry) =>
      t.status === 'failed' || (t.exitCode !== undefined && t.exitCode !== 0);
    return [...terminals].sort((a, b) => {
      const fa = isFailed(a) ? 1 : 0;
      const fb = isFailed(b) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return (b.timestamp || '').localeCompare(a.timestamp || '');
    });
  }, [terminals]);
  const totalAdded = diffs.reduce((s, d) => s + d.addedLines, 0);
  const totalRemoved = diffs.reduce((s, d) => s + d.removedLines, 0);

  // 标签徽标各自表示不同数量。终端有失败时优先显示失败数，协作面板显示正在工作的成员数，分支树在存在分叉时显示分支总数。
  const counts: Partial<Record<RightInspectorTab, number>> = {
    diff: diffs.length,
    plan: todos.length,
    terminal: unread.length,
    tree: conversationTree && conversationTree.totalBranches > 1 ? conversationTree.totalBranches : 0,
    swarm: swarmTopology?.isActive ? swarmTopology.stats.working : 0,
  };
  const countTone: Partial<Record<RightInspectorTab, 'danger' | 'accent' | 'muted'>> = {
    diff: 'accent',
    plan: 'muted',
    terminal: failedTerminals ? 'danger' : 'muted',
    tree: 'accent',
    swarm: 'accent',
  };
  const doneTodos = todos.filter((t) => t.status === 'completed').length;
  // “变更”是一级页签，差异与文件清单是它的二级视图，共用同一份统计与焦点文件。
  const changesView = activeTab === 'files' ? 'files' : 'diff';
  const isChanges = activeTab === 'diff' || activeTab === 'files';

  const changeSummary = diffs.length > 0 && (
    <div className="inspector-summary" data-testid="inspector-change-summary">
      <FileCode2 size={12} />
      <span>{diffs.length}</span>
      <span className="muted">files</span>
      <span className="cc-add">+{totalAdded}</span>
      <span className="cc-del">−{totalRemoved}</span>
      <span className="inspector-summary-bar" aria-hidden="true">
        <span
          className="is-add"
          style={{ width: `${(totalAdded / Math.max(1, totalAdded + totalRemoved)) * 100}%` }}
        />
        <span
          className="is-del"
          style={{ width: `${(totalRemoved / Math.max(1, totalAdded + totalRemoved)) * 100}%` }}
        />
      </span>
    </div>
  );

  const changesSwitch = (
    <div className="segmented segmented-sm inspector-subnav" role="tablist" aria-label={ui.changesTab}>
      {(['diff', 'files'] as const).map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={changesView === view}
          className={`segmented-btn ${changesView === view ? 'is-active' : ''}`}
          onClick={() => onSelectTab(view)}
          data-testid={view === 'files' ? 'inspector-tab-files' : 'inspector-subtab-diff'}
        >
          {view === 'diff' ? <FileDiff size={12} /> : <FileCode2 size={12} />}
          <span>{view === 'diff' ? ui.viewDiff : ui.viewFiles}</span>
        </button>
      ))}
    </div>
  );

  return (
    <aside
      className={`inspector ${collapsed ? 'is-collapsed' : ''} ${floating ? 'is-floating' : ''}`}
      style={{ width: collapsed ? 0 : liveWidth }}
      data-inspector-mode={floating ? 'floating' : 'docked'}
      data-testid="right-inspector"
      aria-hidden={collapsed}
    >
      {!collapsed && (
        <ResizeHandle
          value={liveWidth}
          min={MIN_WIDTH}
          max={maxInspectorWidth}
          defaultValue={DEFAULT_WIDTH}
          direction={-1}
          label={ui.resizeInspector}
          className="edge-left"
          testId="inspector-resize-handle"
          onPreview={setLiveWidth}
          onCommit={(w) => onCommitWidth(Math.round(w))}
        />
      )}
      <div className="inspector-inner">
        <div className="inspector-bar">
          <div
            className={`inspector-tabs-viewport ${tabScroll.overflow ? 'is-overflowing' : ''}`}
            data-testid="inspector-tabs-viewport"
          >
            {tabScroll.canLeft && (
              <button
                type="button"
                className="inspector-scroll-btn is-left"
                onClick={() => scrollTabsBy(-96)}
                aria-label={locale === 'zh-CN' ? '向左滑动页签' : 'Scroll tabs left'}
                title={locale === 'zh-CN' ? '向左滑动页签' : 'Scroll tabs left'}
                data-testid="inspector-tabs-scroll-left"
              >
                <ChevronLeft size={12} />
              </button>
            )}
            <div
              ref={tabsRef}
              className="inspector-head"
              role="tablist"
              onScroll={syncTabScroll}
              onWheel={handleTabsWheel}
            >
              {TABS.map(({ id, Icon }) => {
                const selected = id === 'diff' ? isChanges : activeTab === id;
                const label = id === 'diff' ? ui.changesTab : dict.inspectorTabs[id];
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`inspector-tab ${selected ? 'is-active' : ''}`}
                    onClick={() => onSelectTab(id === 'diff' && isChanges ? activeTab : id)}
                    aria-label={label}
                    title={label}
                    data-testid={`inspector-tab-${id}`}
                  >
                    <Icon size={13} />
                    <span className="inspector-tab-label">{label}</span>
                    {counts[id] ? (
                      <span className={`tab-count tone-${countTone[id] ?? 'muted'}`}>{counts[id]}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {tabScroll.canRight && (
              <button
                type="button"
                className="inspector-scroll-btn is-right"
                onClick={() => scrollTabsBy(96)}
                aria-label={locale === 'zh-CN' ? '向右滑动页签' : 'Scroll tabs right'}
                title={locale === 'zh-CN' ? '向右滑动页签' : 'Scroll tabs right'}
                data-testid="inspector-tabs-scroll-right"
              >
                <ChevronRight size={12} />
              </button>
            )}
          </div>
          <div className="inspector-head-actions">
            <button
              type="button"
              className={`icon-btn icon-btn-sm ${floating ? 'is-active' : ''}`}
              onClick={toggleFloating}
              aria-pressed={floating}
              title={floating ? ui.dockInspector : ui.floatInspector}
              aria-label={floating ? ui.dockInspector : ui.floatInspector}
              data-testid="inspector-float-toggle"
            >
              {floating ? <PanelRight size={13} /> : <Layers size={13} />}
            </button>
            {onCollapse && (
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={onCollapse}
                title={dict.inspectorToggleHide}
                aria-label={dict.inspectorToggleHide}
                data-testid="inspector-close-btn"
              >
                <PanelRightClose size={13} />
              </button>
            )}
          </div>
        </div>

        <div className="inspector-body" key={isChanges ? 'changes' : activeTab}>
          {activeTab === 'diff' && (
            <div className="inspector-stack" data-testid="inspector-view-diff">
              <div className="inspector-toolbar">{changesSwitch}</div>
              {diffs.length === 0 ? (
                <div className="empty-state">{dict.diffEmpty}</div>
              ) : (
                <>
                  {changeSummary}
                  {diffs.map((entry) => (
                    <UnifiedDiffBlock key={entry.filePath} entry={entry} highlighted={focusedDiffFile === entry.filePath} />
                  ))}
                </>
              )}
            </div>
          )}

          {activeTab === 'files' && (
            <div className="inspector-stack" style={{ gap: 2 }} data-testid="inspector-view-files">
              <div className="inspector-toolbar">{changesSwitch}</div>
              {diffs.length === 0 ? (
                <div className="empty-state">{dict.filesChangedEmpty}</div>
              ) : (
                <>
                  {changeSummary}
                  {diffs.map((entry) => (
                    <button
                      key={entry.filePath}
                      type="button"
                      className="file-row"
                      title={entry.filePath}
                      onClick={() => {
                        onFocusDiffFile(entry.filePath);
                        onSelectTab('diff');
                      }}
                      data-testid={`changed-file-item-${entry.filePath}`}
                    >
                      <FileCode2 size={13} />
                      <span className="truncate">{entry.filePath}</span>
                      <span className="file-row-stats">
                        <span className="cc-add">+{entry.addedLines}</span>
                        <span className="cc-del">-{entry.removedLines}</span>
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}

          {activeTab === 'plan' && (
            <div className="inspector-stack" style={{ gap: 2 }} data-testid="inspector-view-plan">
              {todos.length === 0 ? (
                <div className="empty-state">{dict.planEmpty}</div>
              ) : (
                <>
                  <div className="plan-progress">
                    <span>{dict.planProgress(doneTodos, todos.length)}</span>
                    <span className="gauge">
                      <span style={{ width: `${(doneTodos / todos.length) * 100}%` }} />
                    </span>
                  </div>
                  {todos.map((td) => (
                    <div key={td.id} className={`plan-item ${td.status === 'completed' ? 'is-completed' : ''}`}>
                      {td.status === 'completed' ? (
                        <CheckCircle2 size={14} color="var(--status-success)" />
                      ) : td.status === 'in_progress' ? (
                        <CircleDot size={14} color="var(--accent-primary)" />
                      ) : (
                        <Circle size={14} color="var(--text-muted)" />
                      )}
                      <span>{td.content}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="inspector-stack" data-testid="inspector-view-terminal">
              {terminals.length === 0 ? (
                <div className="empty-state">{dict.terminalEmpty}</div>
              ) : (
                orderedTerminals.map(term => <TerminalRow key={sessionId + '/' + term.id} term={term} />)
              )}
            </div>
          )}

          {activeTab === 'context' && (
            <>
              {conversationTree && conversationTree.totalBranches > 1 && sessionId && (
                <div className="ctx-branch-banner" data-testid="context-branch-banner">
                  <GitBranch size={12} />
                  <span className="truncate">
                    {(() => {
                      const activeNode = conversationTree.nodesById[sessionId];
                      if (!activeNode || activeNode.parentBranchId === null) {
                        return locale === 'zh-CN' ? '当前视角：主对话分支' : 'Active branch: Main';
                      }
                      return locale === 'zh-CN'
                        ? `当前视角：第 ${activeNode.forkUserTurnIndex + 1} 轮分叉 (${activeNode.siblingIndex}/${activeNode.siblingCount})`
                        : `Active branch: Turn ${activeNode.forkUserTurnIndex + 1} (${activeNode.siblingIndex}/${activeNode.siblingCount})`;
                    })()}
                  </span>
                  <button
                    type="button"
                    className="ctx-branch-banner-btn"
                    onClick={() => onSelectTab('tree')}
                    data-testid="context-banner-open-tree"
                  >
                    {locale === 'zh-CN' ? '分支树' : 'Tree'}
                  </button>
                </div>
              )}
              <ContextCostInspectorView
                sessionId={sessionId}
                dashboard={telemetry}
                viewMode={contextViewMode}
                onChangeViewMode={onChangeContextViewMode}
                reviewerConnected={reviewerConnected}
                onOpenExternalReviewerSettings={onOpenExternalReviewerSettings}
                onOpenRateCardsSettings={onOpenRateCardsSettings}
              />
            </>
          )}

          {activeTab === 'tree' && (
            <ConversationTreePanel
              sessionId={sessionId}
              tree={conversationTree}
              telemetry={telemetry}
              busy={sessionBusy}
              switchingBranch={switchingBranch}
              onSwitchBranch={onSwitchBranch}
              onOpenContextTab={() => onSelectTab('context')}
            />
          )}

          {activeTab === 'swarm' && (
            <SwarmPanel
              sessionId={sessionId}
              topology={swarmTopology}
              onLaunchSwarmTask={onLaunchSwarmTask}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

function TerminalRow({ term }: { term: SessionTerminalEntry }): React.ReactElement {
  const { locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const long = term.command.length > 96 || /[\r\n]/.test(term.command) ||
    term.output.length > 600 || term.output.split('\n').length > 6;
  const failed = term.status === 'failed' || (term.exitCode !== undefined && term.exitCode !== 0);
  return <article className={'term' + (failed ? ' is-failed' : '')}>
    <div className="term-head">
      <span className="term-prompt">$</span>
      <code className={long && !expanded ? 'truncate' : 'term-command'}>{term.command}</code>
      <span className="spacer" />
      {term.exitCode !== undefined && <span className={'badge ' + (failed ? 'badge-danger' : 'badge-success')}>exit {term.exitCode}</span>}
      {long && <button type="button" className="btn btn-sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {locale === 'zh-CN' ? (expanded ? '收起' : '展开') : (expanded ? 'Collapse' : 'Expand')}
      </button>}
    </div>
    {(!long || expanded) && term.output && <pre>{term.output}</pre>}
  </article>;
}
