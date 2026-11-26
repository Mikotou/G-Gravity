import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getCanonicalToolName, isToolCallFailure } from '@shared';
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Square,
  SquareCheck,
  SquareDot,
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
  SwarmHistoryCursor,
  TelemetryDashboardSnapshot,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { ContextCostInspectorView, type ContextInspectorViewMode } from './ContextCostInspectorView';
import { ConversationTreePanel } from './ConversationTreePanel';
import { ResizeHandle } from './ResizeHandle';
import { SwarmDrafts, SwarmPanel } from './SwarmPanel';
import { UnifiedDiffBlock } from './UnifiedDiffBlock';

import { terminalCommand } from '../../shared/session-contract';
import { Icon as UiIcon } from './ui/Icon';

export interface RightInspectorProps {
  collapsed: boolean;
  width: number;
  floating?: boolean;
  activeTab: RightInspectorTab;
  contextViewMode?: ContextInspectorViewMode;
  onChangeContextViewMode?: (mode: ContextInspectorViewMode) => void;
  reviewerConnected?: boolean;
  onOpenExternalReviewerSettings?: () => void;
  translatorConnected?: boolean;
  onOpenExternalTranslatorSettings?: () => void;
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
  swarmDrafts?: SwarmDrafts;
  onSelectTab: (tab: RightInspectorTab) => void;
  onFocusDiffFile: (filePath: string) => void;
  onCommitWidth: (width: number) => void;
  onToggleFloating?: (floating: boolean) => void;
  onCollapse?: () => void;
  onLaunchSwarmTask?: (sessionId: string, taskBrief: string) => Promise<void>;
  onLoadSwarmPage?: (sessionId: string, before: SwarmHistoryCursor) => Promise<SwarmTopologyState>;
  onOpenRateCardsSettings: () => void;
}

const INSPECTOR_FLOAT_KEY = 'gravity.inspector.floating';
export function readInspectorFloating(): boolean {
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
  { id: 'swarm', Icon: Network },
];

const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 380;
/** 常规屏幕上限 680px；宽屏（如 2K / 4K）允许拉到窗口一半，最高 1000px。 */
function maxInspectorWidth(): number {
  const viewport = typeof window !== 'undefined' ? window.innerWidth : 1280;
  return Math.max(680, Math.min(1000, Math.round(viewport * 0.5)));
}

function RightInspectorImpl({
  collapsed,
  width,
  floating: floatingProp,
  activeTab,
  contextViewMode,
  onChangeContextViewMode,
  reviewerConnected,
  onOpenExternalReviewerSettings,
  translatorConnected,
  onOpenExternalTranslatorSettings,
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
  swarmDrafts,
  onSelectTab,
  onFocusDiffFile,
  onCommitWidth,
  onToggleFloating,
  onCollapse,
  onLaunchSwarmTask,
  onLoadSwarmPage,
  onOpenRateCardsSettings,
}: RightInspectorProps): React.ReactElement {
  const { dict } = useI18n();
  const localSwarmDrafts = useMemo(() => new SwarmDrafts(), [profileId]);
  const ui = dict.ui;
  const [liveWidth, setLiveWidth] = useState<number>(width || DEFAULT_WIDTH);
  const [floating, setFloating] = useState<boolean>(() =>
    floatingProp !== undefined ? floatingProp : readInspectorFloating()
  );
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 切换页签不再强制卸载整个检视器主体：各页签的滚动位置按视图记忆，切回时恢复。
  const bodyScrollRef = useRef<Record<string, number>>({});
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

  // React 的 onWheel 是被动监听，调用 preventDefault() 会报警告且无效；改用原生 { passive: false } 监听。
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent): void {
      const node = tabsRef.current;
      if (!node || node.scrollWidth <= node.clientWidth + 2) return;
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      e.preventDefault();
      node.scrollLeft += delta;
      syncTabScroll();
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [syncTabScroll, collapsed, floating]);

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

  // 持久化与上报放在 setState 更新函数之外，StrictMode 双调用更新函数时不会重复写入 / 重复发起 IPC。
  function toggleFloating(): void {
    const next = !floating;
    setFloating(next);
    saveInspectorFloating(next);
    onToggleFloating?.(next);
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
        if (getCanonicalToolName(tc.canonicalToolName || tc.rawToolName) !== 'Bash' && getCanonicalToolName(tc.rawToolName) !== 'Bash') continue;
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
    // K4：后端提供单调递增修订号时直接使用，避免逐字符哈希大段输出。
    if (typeof entry.revision === 'number') {
      return [entry.toolCallId, entry.status, entry.exitCode, entry.timestamp, `r${entry.revision}`].join('/');
    }
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
  // 与工具卡片同一判定：失败、策略拒绝（rejected）或非零退出码都标红并置顶。
  const failedTerminals = unread.filter(isToolCallFailure).length;
  // 失败命令优先展示，其余按时间倒序，最新的在最上面
  const orderedTerminals = useMemo(() => {
    return [...terminals].sort((a, b) => {
      const fa = isToolCallFailure(a) ? 1 : 0;
      const fb = isToolCallFailure(b) ? 1 : 0;
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
    swarm: swarmTopology?.isActive ? swarmTopology.stats.working : 0,
  };
  const countTone: Partial<Record<RightInspectorTab, 'danger' | 'accent' | 'muted'>> = {
    diff: 'accent',
    plan: 'muted',
    terminal: failedTerminals ? 'danger' : 'muted',
    swarm: 'accent',
  };
  const doneTodos = todos.filter((t) => t.status === 'completed').length;
  // “变更”是一级页签，差异与文件清单是它的二级视图，共用同一份统计与焦点文件。
  const changesView = activeTab === 'files' ? 'files' : 'diff';
  const isChanges = activeTab === 'diff' || activeTab === 'files';
  // D1：分支树是 Context 的二级视图；外部以 'tree' 打开时自动选中 Context 一级页签。
  const isContextGroup = activeTab === 'context' || activeTab === 'tree';
  const treeBranchCount = conversationTree && conversationTree.totalBranches > 1 ? conversationTree.totalBranches : 0;
  const bodyViewKey = `${sessionId ?? ''}:${activeTab}`;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = bodyScrollRef.current[bodyViewKey] ?? 0;
  }, [bodyViewKey]);

  const changeSummary = diffs.length > 0 && (
    <div className="inspector-summary" data-testid="inspector-change-summary">
      <UiIcon icon={FileCode2} size="xs" />
      <span>{diffs.length}</span>
      <span className="muted">{dict.ui.v033.inspectorFilesUnit}</span>
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
          {view === 'diff' ? <UiIcon icon={FileDiff} size="xs" /> : <UiIcon icon={FileCode2} size="xs" />}
          <span>{view === 'diff' ? ui.viewDiff : ui.viewFiles}</span>
        </button>
      ))}
    </div>
  );

  const contextSwitch = (
    <div className="segmented segmented-sm inspector-subnav" role="tablist" aria-label={ui.v034.contextViewSwitch}>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'context'}
        className={`segmented-btn ${activeTab === 'context' ? 'is-active' : ''}`}
        onClick={() => onSelectTab('context')}
        data-testid="inspector-subtab-context"
      >
        <UiIcon icon={BarChart3} size="xs" />
        <span>{ui.v034.contextViewUsage}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'tree'}
        className={`segmented-btn ${activeTab === 'tree' ? 'is-active' : ''}`}
        onClick={() => onSelectTab('tree')}
        data-testid="inspector-tab-tree"
      >
        <UiIcon icon={GitBranch} size="xs" />
        <span>{ui.v034.contextViewTree}</span>
        {treeBranchCount > 0 && <span className="tab-count tone-accent">{treeBranchCount}</span>}
      </button>
    </div>
  );

  return (
    <aside
      className={`inspector ${collapsed ? 'is-collapsed' : ''} ${floating ? 'is-floating' : ''}`}
      style={{ width: collapsed ? 0 : liveWidth }}
      data-inspector-mode={floating ? 'floating' : 'docked'}
      data-testid="right-inspector"
      aria-hidden={collapsed}
      // F-12：收起态整体 inert 且不渲染内部控件，键盘焦点不会落入不可见的检视器。
      inert={collapsed || undefined}
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
      {!collapsed && (
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
                aria-label={ui.v034.scrollTabsLeft}
                title={ui.v034.scrollTabsLeft}
                data-testid="inspector-tabs-scroll-left"
              >
                <UiIcon icon={ChevronLeft} size="xs" />
              </button>
            )}
            <div
              ref={tabsRef}
              className="inspector-head"
              role="tablist"
              onScroll={syncTabScroll}
            >
              {TABS.map(({ id, Icon }) => {
                const selected = id === 'diff' ? isChanges : id === 'context' ? isContextGroup : activeTab === id;
                const label = id === 'diff' ? ui.changesTab : dict.inspectorTabs[id];
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`inspector-tab ${selected ? 'is-active' : ''}`}
                    onClick={() =>
                      // Changes 记住二级视图；Context 一级页签始终回到「用量与费用」主视图，分支树经二级切换进入。
                      onSelectTab(id === 'diff' && isChanges ? activeTab : id)
                    }
                    aria-label={label}
                    title={label}
                    data-testid={`inspector-tab-${id}`}
                  >
                    <UiIcon icon={Icon} size="sm" />
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
                aria-label={ui.v034.scrollTabsRight}
                title={ui.v034.scrollTabsRight}
                data-testid="inspector-tabs-scroll-right"
              >
                <UiIcon icon={ChevronRight} size="xs" />
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
              {floating ? <UiIcon icon={PanelRight} size="sm" /> : <UiIcon icon={Layers} size="sm" />}
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
                <UiIcon icon={PanelRightClose} size="sm" />
              </button>
            )}
          </div>
        </div>

        <div
          className="inspector-body"
          ref={bodyRef}
          onScroll={(e) => { bodyScrollRef.current[bodyViewKey] = e.currentTarget.scrollTop; }}
        >
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
                      <UiIcon icon={FileCode2} size="sm" />
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
                    <span className="gauge" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={doneTodos}>
                      <span style={{ '--fill': doneTodos / todos.length } as React.CSSProperties} />
                    </span>
                  </div>
                  {todos.map((td) => (
                    <div key={td.id} className={`plan-item ${td.status === 'completed' ? 'is-completed' : ''}`}>
                      {td.status === 'completed' ? (
                        <UiIcon icon={SquareCheck} size="sm" className="plan-item-icon is-completed" label={ui.v034.todoCompleted} />
                      ) : td.status === 'in_progress' ? (
                        <UiIcon icon={SquareDot} size="sm" className="plan-item-icon is-in-progress" label={ui.v034.todoInProgress} />
                      ) : (
                        <UiIcon icon={Square} size="sm" className="plan-item-icon is-pending" label={ui.v034.todoPending} />
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
              <div className="inspector-toolbar">{contextSwitch}</div>
              {conversationTree && conversationTree.totalBranches > 1 && sessionId && (
                <div className="ctx-branch-banner" data-testid="context-branch-banner">
                  <UiIcon icon={GitBranch} size="xs" />
                  <span className="truncate">
                    {(() => {
                      const activeNode = conversationTree.nodesById[sessionId];
                      if (!activeNode || activeNode.parentBranchId === null) {
                        return ui.v034.activeBranchMain;
                      }
                      return ui.v034.activeBranchTurn(activeNode.forkUserTurnIndex + 1, activeNode.siblingIndex, activeNode.siblingCount);
                    })()}
                  </span>
                  <button
                    type="button"
                    className="ctx-branch-banner-btn"
                    onClick={() => onSelectTab('tree')}
                    data-testid="context-banner-open-tree"
                  >
                    {ui.v034.treeShort}
                  </button>
                </div>
              )}
              <ContextCostInspectorView
                sessionId={sessionId}
                dashboard={telemetry}
                conversationTree={conversationTree}
                viewMode={contextViewMode}
                onChangeViewMode={onChangeContextViewMode}
                reviewerConnected={reviewerConnected}
                onOpenExternalReviewerSettings={onOpenExternalReviewerSettings}
                translatorConnected={translatorConnected}
                onOpenExternalTranslatorSettings={onOpenExternalTranslatorSettings}
                onOpenRateCardsSettings={onOpenRateCardsSettings}
              />
            </>
          )}

          {activeTab === 'tree' && (
            <>
            <div className="inspector-toolbar">{contextSwitch}</div>
            <ConversationTreePanel
              sessionId={sessionId}
              tree={conversationTree}
              telemetry={telemetry}
              busy={sessionBusy}
              switchingBranch={switchingBranch}
              onSwitchBranch={onSwitchBranch}
              onOpenContextTab={() => onSelectTab('context')}
            />
            </>
          )}

          {activeTab === 'swarm' && (
            <SwarmPanel
              key={profileId}
              sessionId={sessionId}
              topology={swarmTopology}
              onLaunchSwarmTask={onLaunchSwarmTask}
              onLoadPage={onLoadSwarmPage}
              drafts={swarmDrafts ?? localSwarmDrafts}
              busy={sessionBusy}
            />
          )}
        </div>
      </div>
      )}
    </aside>
  );
}

/** F-08：浅比较 props，未改动检视数据与当前会话消息引用时跳过提交。 */
export const RightInspector = React.memo(RightInspectorImpl);

function TerminalRow({ term }: { term: SessionTerminalEntry }): React.ReactElement {
  const { dict } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const long = term.command.length > 96 || /[\r\n]/.test(term.command) ||
    term.output.length > 600 || term.output.split('\n').length > 6;
  const failed = isToolCallFailure(term);
  return <article className={'term' + (failed ? ' is-failed' : '')}>
    <div className="term-head">
      <span className="term-prompt">$</span>
      <code className={long && !expanded ? 'truncate' : 'term-command'}>{term.command}</code>
      <span className="spacer" />
      {term.exitCode !== undefined && <span className={'badge ' + (failed ? 'badge-danger' : 'badge-success')}>exit {term.exitCode}</span>}
      {term.status === 'rejected' && term.exitCode === undefined && <span className="badge badge-danger">{dict.ui.v033.terminalRejected}</span>}
      {long && <button type="button" className="btn btn-sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? dict.ui.v034.collapseAction : dict.ui.v034.expandAction}
      </button>}
    </div>
    {(!long || expanded) && term.output && <pre>{term.output}</pre>}
  </article>;
}
