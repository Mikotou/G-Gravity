import React, { useEffect, useMemo, useRef, useState } from 'react';
import { clampSplitRatio, LAYOUT_LIMITS, workspaceSlots } from '@shared';
import { droppedSession, isSessionDrag } from '../lib/session-drag';
import { useI18n } from '../i18n/I18nContext';
import { ResizeHandle } from './ResizeHandle';
import type {
  ApprovalAuditEntry,
  ChatMessageItem,
  ConversationTreeState,
  ManagedSessionSummary,
  MessagePagePosition,
  SessionInspectorData,
  SwarmTopologyState,
  WorkspaceLayoutState,
} from '@shared';
import { SessionPane, type SessionPaneProps } from './SessionPane';

type SharedPaneProps = Omit<
  SessionPaneProps,
  'slotIndex' | 'layoutMode' | 'isFocused' | 'session' | 'messages' | 'messagePosition' | 'latestAudit' | 'swarmState' | 'conversationTree' | 'inspectorData'
>;

export interface SessionWorkspaceGridProps extends Omit<SharedPaneProps, 'availableSessions'> {
  layout: WorkspaceLayoutState;
  historyIds?: string[];
  renderHistory?: (id: string, slot: number) => React.ReactNode;
  focusedSessionId: string | null;
  sessions: ManagedSessionSummary[];
  messagesBySession: Record<string, ChatMessageItem[]>;
  messagePositions?: Record<string, MessagePagePosition>;
  auditLog: ApprovalAuditEntry[];
  swarmBySession: Record<string, SwarmTopologyState>;
  treeByRoot?: Record<string, ConversationTreeState>;
  inspectorBySession?: Record<string, SessionInspectorData>;
  onCommitSplitRatio?: (ratio: number) => void;
}

const EMPTY_MESSAGES: ChatMessageItem[] = [];

/** 窗格只控制正在显示的会话。其余会话由后台继续管理。 */
export function SessionWorkspaceGrid({
  layout,
  focusedSessionId,
  sessions,
  messagesBySession,
  messagePositions,
  auditLog,
  historyIds = [], renderHistory,
  swarmBySession,
  treeByRoot,
  inspectorBySession,
  onCommitSplitRatio,
  ...paneProps
}: SessionWorkspaceGridProps): React.ReactElement {
  // 可供选择的历史会话与可以放进窗格的活动会话范围不同，后者还须属于当前标签列表且处于打开状态。
  // F-08：派生数组按输入记忆，配合 SessionPane 的 React.memo，让未受影响的窗格在其它会话流式时跳过提交。
  const visibleSessions = useMemo(() => sessions.filter((s) => !s.isLegacyApprovalPollution), [sessions]);
  const active = useMemo(
    () => visibleSessions.filter(s => !s.archivedAt && (s.status !== 'closed' || s.readOnly)),
    [visibleSessions]
  );
  const slots = workspaceSlots(layout, [...active.map(s => s.sessionId), ...historyIds]);
  const [dragSlot, setDragSlot] = useState<number | null>(null);
  const { dict } = useI18n();
  const gridRef = useRef<HTMLElement | null>(null);
  const [ratio, setRatio] = useState(clampSplitRatio(layout.splitRatio));
  useEffect(() => { setRatio(clampSplitRatio(layout.splitRatio)); }, [layout.splitRatio]);
  const split = layout.layoutMode === 'split-2';

  return (
    <main
      ref={gridRef}
      className={`workspace mode-${layout.layoutMode}`}
      data-testid="workspace-grid"
      data-layout-mode={layout.layoutMode}
      style={split ? { gridTemplateColumns: `minmax(0, ${ratio}fr) minmax(0, ${1 - ratio}fr)` } : undefined}
    >
      {slots.map((id, idx) => {
        const slot = active.find(s => s.sessionId === id);
        const history = id && historyIds.includes(id) ? id : null;
        return (
        <div key={idx} className={'workspace-slot' + (dragSlot === idx ? ' drag-target' : '')} data-testid={'workspace-slot-' + idx}
          onPointerDownCapture={() => { if (history) paneProps.onFocusPane(history); }}
          onFocusCapture={() => { if (history) paneProps.onFocusPane(history); }}
          onDragOver={e => {
            if (!isSessionDrag(e.dataTransfer)) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragSlot(idx);
          }}
          onDragLeave={e => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragSlot(null); }}
          onDrop={e => {
            if (!isSessionDrag(e.dataTransfer)) return;
            e.preventDefault(); setDragSlot(null);
            const id = droppedSession(e.dataTransfer);
            if (historyIds.includes(id) || visibleSessions.some(s => s.sessionId === id && !s.archivedAt)) paneProps.onBindSlotSession(idx, id);
          }}>
        {history && renderHistory ? renderHistory(history, idx) : <SessionPane
          key={slot?.sessionId || 'empty'}
          {...paneProps}
          slotIndex={idx}
          layoutMode={layout.layoutMode}
          isFocused={slot ? focusedSessionId === slot.sessionId || (!focusedSessionId && idx === 0) : false}
          session={slot ?? null}
          availableSessions={visibleSessions}
          messages={slot ? messagesBySession[slot.sessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES}
          messagePosition={slot ? messagePositions?.[slot.sessionId] : undefined}
          latestAudit={slot ? auditLog.find((entry) => entry.sessionId === slot.sessionId) : undefined}
          swarmState={slot ? swarmBySession[slot.sessionId] : undefined}
          conversationTree={slot && treeByRoot ? treeByRoot[slot.rootSessionId || slot.sessionId] : undefined}
          inspectorData={slot && inspectorBySession ? inspectorBySession[slot.sessionId] : undefined}
        />}
        {split && idx === 0 && onCommitSplitRatio && (
          // 分隔条挂在左栏右缘，网格仍只有两个子节点。
          <ResizeHandle
            value={ratio}
            min={LAYOUT_LIMITS.splitRatio.min}
            max={LAYOUT_LIMITS.splitRatio.max}
            defaultValue={0.5}
            unitPx={() => gridRef.current?.clientWidth || 1000}
            label={dict.ui.resizeSplit}
            className="edge-right split-handle"
            testId="split-resize-handle"
            onPreview={setRatio}
            onCommit={(r) => onCommitSplitRatio(Math.round(r * 1000) / 1000)}
          />
        )}
        </div>
        );
      })}
    </main>
  );
}
