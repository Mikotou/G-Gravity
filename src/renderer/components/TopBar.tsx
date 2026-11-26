import React from 'react';
import { Columns2, PanelRight, Square, X } from 'lucide-react';
import {
  type ManagedSessionSummary,
  type PendingApprovalRequest,
  type WorkspaceLayoutState,
  type WorkspaceSplitMode,
} from '@shared';
import { startSessionDrag } from '../lib/session-drag';
import { useI18n } from '../i18n/I18nContext';
import { Icon as UiIcon } from './ui/Icon';

type TabSession = Pick<ManagedSessionSummary, 'sessionId' | 'title' | 'cwd' | 'status' | 'readOnly'>;
export interface TopBarProps {
  sessions: TabSession[];
  layout: WorkspaceLayoutState;
  focusedSessionId: string | null;
  pendingApprovals: PendingApprovalRequest[];
  onToggleRightInspector: () => void;
  onSelectTab: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  /** D3：TopBar「+」已移除（新建入口收敛到 Rail、项目组悬停与欢迎卡），保留可选签名兼容调用方 */
  onOpenNewSessionModal?: () => void;
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
  onToggleRightInspector,
  onSelectTab,
  onCloseTab,
  onChangeLayoutMode,
}: TopBarProps): React.ReactElement {
  const { dict, shortcut } = useI18n();
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
              onMouseDown={(e) => {
                // 中键按下时阻止浏览器自动滚动光标，松开后由 auxclick 关闭标签。
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(tab.sessionId);
                }
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectTab(tab.sessionId);
                } else if (e.key === 'Delete') {
                  e.preventDefault();
                  onCloseTab(tab.sessionId);
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
                  // 标签条内的方向键漫游焦点（WAI-ARIA tablist）
                  e.preventDefault();
                  const tabs = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
                  const index = tabs.indexOf(e.currentTarget);
                  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
                    : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                  tabs[next]?.focus();
                }
              }}
              tabIndex={active ? 0 : -1}
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
                <UiIcon icon={X} size="xs" />
              </button>
            </div>
          );
        })}
      </nav>

      <div className="segmented" data-testid="layout-mode-switcher">
        {LAYOUTS.map(({ mode, Icon }) => (
          <button
            key={mode}
            type="button"
            className={`segmented-btn ${layout.layoutMode === mode ? 'is-active' : ''}`}
            onClick={() => onChangeLayoutMode(mode)}
            title={`${layoutLabels[mode]} (${shortcut('\\')})`}
            aria-label={layoutLabels[mode]}
            aria-pressed={layout.layoutMode === mode}
            data-testid={`layout-btn-${mode}`}
          >
            <UiIcon icon={Icon} size="sm" />
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`icon-btn ${layout.rightInspectorCollapsed ? '' : 'is-active'}`}
        onClick={onToggleRightInspector}
        title={layout.rightInspectorCollapsed ? dict.inspectorToggleShow : dict.inspectorToggleHide}
        aria-label={layout.rightInspectorCollapsed ? dict.inspectorToggleShow : dict.inspectorToggleHide}
        aria-pressed={!layout.rightInspectorCollapsed}
        data-testid="toggle-right-inspector-btn"
      >
        <UiIcon icon={PanelRight} size="md" />
      </button>
    </header>
  );
}
