import React from 'react';
import { Columns2, PanelLeftOpen, PanelRight, Plus, Square, X } from 'lucide-react';
import {
  type ManagedSessionSummary,
  type PendingApprovalRequest,
  type WorkspaceLayoutState,
  type WorkspaceSplitMode,
} from '@shared';
import { startSessionDrag } from '../lib/session-drag';
import { useI18n } from '../i18n/I18nContext';

type TabSession = Pick<ManagedSessionSummary, 'sessionId' | 'title' | 'cwd' | 'status' | 'readOnly'>;
export interface TopBarProps {
  sessions: TabSession[];
  layout: WorkspaceLayoutState;
  focusedSessionId: string | null;
  pendingApprovals: PendingApprovalRequest[];
  onToggleLeftSidebar: () => void;
  onToggleRightInspector: () => void;
  onSelectTab: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  onOpenNewSessionModal: () => void;
  onChangeLayoutMode: (mode: WorkspaceSplitMode) => void;
}

const LAYOUTS: ReadonlyArray<{ mode: WorkspaceSplitMode; Icon: typeof Square }> = [
  { mode: 'single', Icon: Square },
  { mode: 'split-2', Icon: Columns2 },
];

/** 主区顶部：已打开会话标签 + 布局切换 + Inspector 开关 */
export function TopBar({
  sessions,
  layout,
  focusedSessionId,
  pendingApprovals,
  onToggleLeftSidebar,
  onToggleRightInspector,
  onSelectTab,
  onCloseTab,
  onOpenNewSessionModal,
  onChangeLayoutMode,
}: TopBarProps): React.ReactElement {
  const { dict } = useI18n();
  // 按已保存的标签 ID 顺序重建标签栏。过滤已关闭或缺少摘要的 ID，避免在恢复阶段展示不可用的标签。
  const openTabs = layout.openTabSessionIds
    .map((id) => sessions.find((s) => s.sessionId === id && (s.status !== 'closed' || s.readOnly)))
    .filter((s): s is TabSession => Boolean(s));
  const layoutLabels: Record<WorkspaceSplitMode, string> = {
    single: dict.layoutSingle,
    'split-2': dict.layoutSplit2,
  };

  return (
    <header className="main-header" data-testid="app-topbar">
      {layout.leftSidebarCollapsed && (
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleLeftSidebar}
          title={dict.sidebarToggleShow}
          aria-label={dict.sidebarToggleShow}
          data-testid="toggle-left-sidebar-btn"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}

      <nav className="tab-strip" data-testid="parallel-tab-strip" role="tablist">
        {openTabs.map((tab) => {
          const active =
            focusedSessionId === tab.sessionId || (!focusedSessionId && layout.activePrimarySessionId === tab.sessionId);
          // 待审数按每个标签的会话号独立计算，并优先决定状态颜色，切到其他窗格仍能发现待处理的请求。
          const pendingCount = pendingApprovals.filter((p) => p.sessionId === tab.sessionId).length;
          const pending = pendingCount > 0;
          const tabState = pending ? 'waiting_approval' : tab.status;
          return (
            <div
              key={tab.sessionId}
              className={`tab ${active ? 'is-active' : ''}`}
              data-tab-state={tabState}
              draggable onDragStart={e => startSessionDrag(e.dataTransfer, tab.sessionId)}
              onClick={() => onSelectTab(tab.sessionId)}
              onAuxClick={(e) => {
                if (e.button === 1) onCloseTab(tab.sessionId);
              }}
              role="tab"
              aria-selected={active}
              title={`${tab.title}\n${tab.cwd}`}
              data-testid={`tab-item-${tab.sessionId}`}
            >
              <span className={`status-dot is-${tabState}`} />
              <span className="tab-title">{tab.title}</span>
              {pending && <span className="tab-alert-count" title={dict.pendingApprovalsBadge(pendingCount)}>{pendingCount}</span>}
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={dict.closeAction}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.sessionId);
                }}
                data-testid={`tab-close-${tab.sessionId}`}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenNewSessionModal}
          title={`${dict.newSession} (Ctrl+N)`}
          aria-label={dict.newSession}
          data-testid="topbar-new-session-btn"
        >
          <Plus size={15} />
        </button>
      </nav>

      <div className="segmented" data-testid="layout-mode-switcher">
        {LAYOUTS.map(({ mode, Icon }) => (
          <button
            key={mode}
            type="button"
            className={`segmented-btn ${layout.layoutMode === mode ? 'is-active' : ''}`}
            onClick={() => onChangeLayoutMode(mode)}
            title={`${layoutLabels[mode]} (Ctrl+\\)`}
            aria-label={layoutLabels[mode]}
            data-testid={`layout-btn-${mode}`}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`icon-btn ${layout.rightInspectorCollapsed ? '' : 'is-active'}`}
        onClick={onToggleRightInspector}
        title={layout.rightInspectorCollapsed ? dict.inspectorToggleShow : dict.inspectorToggleHide}
        aria-label={layout.rightInspectorCollapsed ? dict.inspectorToggleShow : dict.inspectorToggleHide}
        data-testid="toggle-right-inspector-btn"
      >
        <PanelRight size={16} />
      </button>
    </header>
  );
}
