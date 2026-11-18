import React from 'react';
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
  focusedSessionId: string | null;
  sessions: ManagedSessionSummary[];
  messagesBySession: Record<string, ChatMessageItem[]>;
  auditLog: ApprovalAuditEntry[];
  swarmBySession: Record<string, SwarmTopologyState>;
}

/** 根据布局模式把最多 4 个已打开会话分配到窗格；grid 直接子元素即窗格 */
export function SessionWorkspaceGrid({
  layout,
  focusedSessionId,
  sessions,
  messagesBySession,
  auditLog,
  swarmBySession,
  ...paneProps
}: SessionWorkspaceGridProps): React.ReactElement {
  // 可供选择的历史会话与可以放进窗格的活动会话范围不同，后者还须属于当前标签列表且处于打开状态。
  const visibleSessions = sessions.filter((s) => !s.isLegacyApprovalPollution);
  const openSet = new Set(layout.openTabSessionIds);
  const openActive = visibleSessions.filter((s) => openSet.has(s.sessionId) && (s.status !== 'closed' || s.readOnly));
  const slotCount = layout.layoutMode === 'grid-4' ? 4 : layout.layoutMode === 'split-2' ? 2 : 1;
  const rawSlotIds = [
    layout.activePrimarySessionId,
    layout.splitSecondarySessionId,
    layout.tertiarySessionId,
    layout.quaternarySessionId,
  ];

  // 按槽位依次取已保存的会话，失效或重复绑定时从剩余活动会话补位。没有可用会话的位置交给欢迎窗格。
  const used = new Set<string>();
  const slots: Array<ManagedSessionSummary | null> = [];
  for (let i = 0; i < slotCount; i += 1) {
    const candidate = rawSlotIds[i];
    let picked = candidate ? openActive.find((s) => s.sessionId === candidate) ?? null : null;
    if (picked && used.has(picked.sessionId)) picked = null;
    if (!picked) {
      picked =
        layout.openTabSessionIds
          .map((id) => openActive.find((s) => s.sessionId === id))
          .find((s): s is ManagedSessionSummary => Boolean(s && !used.has(s.sessionId))) ?? null;
    }
    if (picked) used.add(picked.sessionId);
    slots.push(picked);
  }

  return (
    <main
      className={`workspace mode-${layout.layoutMode}`}
      data-testid="workspace-grid"
      data-layout-mode={layout.layoutMode}
    >
      {slots.map((slot, idx) => (
        <SessionPane
          key={slot ? `pane-${idx}-${slot.sessionId}` : `pane-empty-${idx}`}
          {...paneProps}
          slotIndex={idx}
          layoutMode={layout.layoutMode}
          isFocused={slot ? focusedSessionId === slot.sessionId || (!focusedSessionId && idx === 0) : false}
          session={slot}
          availableSessions={visibleSessions}
          messages={slot ? messagesBySession[slot.sessionId] ?? [] : []}
          latestAudit={slot ? auditLog.find((entry) => entry.sessionId === slot.sessionId) : undefined}
          swarmState={slot ? swarmBySession[slot.sessionId] : undefined}
        />
      ))}
    </main>
  );
}
