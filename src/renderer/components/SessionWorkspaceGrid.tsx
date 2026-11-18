import React, { useState } from 'react';
import { workspaceSlots } from '@shared';
import { droppedSession, isSessionDrag } from '../lib/session-drag';
import type {
  ApprovalAuditEntry,
  ChatMessageItem,
  ManagedSessionSummary,
  SwarmTopologyState,
  WorkspaceLayoutState,
} from '@shared';
import { SessionPane, type SessionPaneProps } from './SessionPane';

type SharedPaneProps = Omit<
  SessionPaneProps,
  'slotIndex' | 'layoutMode' | 'isFocused' | 'session' | 'messages' | 'latestAudit' | 'swarmState'
>;

export interface SessionWorkspaceGridProps extends Omit<SharedPaneProps, 'availableSessions'> {
  layout: WorkspaceLayoutState;
  historyIds?: string[];
  renderHistory?: (id: string, slot: number) => React.ReactNode;
  focusedSessionId: string | null;
  sessions: ManagedSessionSummary[];
  messagesBySession: Record<string, ChatMessageItem[]>;
  auditLog: ApprovalAuditEntry[];
  swarmBySession: Record<string, SwarmTopologyState>;
}

/** 窗格只控制正在显示的会话。其余会话由后台继续管理。 */
export function SessionWorkspaceGrid({
  layout,
  focusedSessionId,
  sessions,
  messagesBySession,
  auditLog,
  historyIds = [], renderHistory,
  swarmBySession,
  ...paneProps
}: SessionWorkspaceGridProps): React.ReactElement {
  // 可供选择的历史会话与可以放进窗格的活动会话范围不同，后者还须属于当前标签列表且处于打开状态。
  const visibleSessions = sessions.filter((s) => !s.isLegacyApprovalPollution);
  const active = visibleSessions.filter(s => !s.archivedAt && (s.status !== 'closed' || s.readOnly));
  const slots = workspaceSlots(layout, [...active.map(s => s.sessionId), ...historyIds]);
  const [dragSlot, setDragSlot] = useState<number | null>(null);

  return (
    <main
      className={`workspace mode-${layout.layoutMode}`}
      data-testid="workspace-grid"
      data-layout-mode={layout.layoutMode}
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
          messages={slot ? messagesBySession[slot.sessionId] ?? [] : []}
          latestAudit={slot ? auditLog.find((entry) => entry.sessionId === slot.sessionId) : undefined}
          swarmState={slot ? swarmBySession[slot.sessionId] : undefined}
        />}
        </div>
        );
      })}
    </main>
  );
}
