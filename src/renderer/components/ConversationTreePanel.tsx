import React, { useMemo } from 'react';
import {
  ArrowRight,
  BarChart3,
  Check,
  GitBranch,
  GitCommitHorizontal,
  MessageSquare,
} from 'lucide-react';
import {
  buildConversationTreeRenderRows,
  type ConversationTreeState,
  type TelemetryDashboardSnapshot,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatRelativeTime } from '../i18n/locales';
import { formatTokenShort, formatUsd } from './ContextStatusBar';
import { Icon } from './ui/Icon';

export interface ConversationTreePanelProps {
  sessionId: string | null;
  tree?: ConversationTreeState;
  telemetry: TelemetryDashboardSnapshot;
  busy?: boolean;
  switchingBranch?: boolean;
  onSwitchBranch?: (rootSessionId: string, targetBranchId: string) => void;
  onOpenContextTab?: () => void;
}

/**
 * 右侧检视器专属「分支树」页面：
 * 以 N 叉树形拓扑可视化呈现当前主对话下的全部编辑分叉、多级嵌套子分支、
 * 各分支实时 Context 窗口占用与最新回复摘要，支持一键切换分支并联动 Context 面板。
 */
export function ConversationTreePanel({
  sessionId,
  tree,
  telemetry,
  busy = false,
  switchingBranch = false,
  onSwitchBranch,
  onOpenContextTab,
}: ConversationTreePanelProps): React.ReactElement {
  const { dict } = useI18n();

  const rows = useMemo(() => (tree ? buildConversationTreeRenderRows(tree) : []), [tree]);

  if (!sessionId || !tree || rows.length === 0) {
    return (
      <div className="inspector-stack" data-testid="conversation-tree-panel">
        <div className="empty-state">
          {dict.ui.copy.selectAConversationToView}
        </div>
      </div>
    );
  }

  const activeNode = tree.nodesById[tree.activeBranchId] || tree.nodes[0];
  const activeLiveTele = activeNode ? telemetry.activeSessions[activeNode.branchId] : undefined;
  const activeUsed = activeLiveTele?.usedContextTokens ?? activeNode?.usedContextTokens ?? 0;
  const rawActiveMax = activeLiveTele?.maxContextTokens ?? activeNode?.maxContextTokens;
  const activeMax = typeof rawActiveMax === 'number' && Number.isFinite(rawActiveMax) && rawActiveMax > 0 ? rawActiveMax : null;
  const activeRatio = activeMax ? Math.min(1, activeUsed / activeMax) : 0;
  const switchDisabled = busy || switchingBranch;

  return (
    <div className="inspector-stack conv-tree-panel" data-testid="conversation-tree-panel">
      <section className="conv-tree-summary" data-testid="conversation-tree-summary">
        <div className="conv-tree-summary-head">
          <div className="conv-tree-summary-title">
            <Icon icon={GitBranch} size="sm" className="conv-tree-icon" />
            <span className="truncate" title={tree.rootTitle}>
              {tree.rootTitle || (dict.ui.copy.mainThread)}
            </span>
          </div>
          <span className="badge badge-accent" data-testid="conversation-tree-branch-count">
            {dict.ui.v035.treeBranchCount(tree.totalBranches)}
          </span>
        </div>

        <div className="conv-tree-active-context">
          <div className="conv-tree-active-context-meta">
            <span className="muted">
              {dict.ui.copy.activeBranchContext}
            </span>
            <span className="mono" data-testid="conversation-tree-active-context">
              {activeMax
                ? `${formatTokenShort(activeUsed)} / ${formatTokenShort(activeMax)} · ${(activeRatio * 100).toFixed(1)}%`
                : `${formatTokenShort(activeUsed)} · ${dict.ui.v035.treeContextLimitUnknown}`}
            </span>
          </div>
          <div className="conv-tree-progress-bar" aria-hidden="true">
            <span style={{ '--fill': activeMax ? Math.max(activeUsed > 0 ? 3 : 0, Math.min(100, activeRatio * 100)) / 100 : 0 } as React.CSSProperties} />
          </div>
          {onOpenContextTab && (
            <button
              type="button"
              className="conv-tree-context-link"
              onClick={onOpenContextTab}
              data-testid="conversation-tree-open-context"
            >
              <Icon icon={BarChart3} size="xs" />
              <span>{dict.ui.copy.inspectThisBranchInContext}</span>
              <Icon icon={ArrowRight} size="xs" />
            </button>
          )}
        </div>
      </section>

      <div className="conv-tree-list" role="list" aria-label={dict.ui.v035.treeTitle} data-testid="conversation-tree-nodes">
        {rows.map(({ node, ancestorHasMore, isLastChild }) => {
          const liveTele = telemetry.activeSessions[node.branchId];
          const usedTokens = liveTele?.usedContextTokens ?? node.usedContextTokens;
          const rawMaxTokens = liveTele?.maxContextTokens ?? node.maxContextTokens;
          const maxTokens = typeof rawMaxTokens === 'number' && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : null;
          const costUsd = liveTele?.costSummary?.totalCostUsd ?? node.totalCostUsd;
          const ratio = maxTokens ? Math.min(1, usedTokens / maxTokens) : 0;
          const isRoot = node.parentBranchId === null;
          const isActive = node.isActiveBranch;
          const hasChildren = node.childrenIds.length > 0;
          const branchTitle = isRoot
            ? (dict.ui.copy.main)
            : dict.ui.copy.fmtTurnFork(node.forkUserTurnIndex + 1, node.siblingIndex, node.siblingCount);

          return (
            <div
              key={node.branchId}
              className={`conv-tree-row ${isActive ? 'is-active' : ''} ${node.isOnActivePath ? 'is-on-path' : ''}`}
              role="listitem"
              aria-current={isActive ? 'true' : undefined}
              data-depth={node.depth}
              data-has-children={hasChildren || undefined}
            >
              {node.depth > 0 && (
                <div className="conv-tree-rails" aria-hidden="true">
                  {ancestorHasMore.map((hasMore, idx) => (
                    <span
                      key={idx}
                      className={`conv-tree-rail-col ${hasMore ? 'has-line' : ''}`}
                    />
                  ))}
                  <span
                    className={`conv-tree-rail-elbow ${isLastChild ? 'is-last' : ''} ${node.isOnActivePath ? 'is-active-path' : ''}`}
                  />
                </div>
              )}

              <button
                type="button"
                className={`conv-tree-card ${isActive ? 'is-active' : ''} ${node.isOnActivePath ? 'is-on-path' : ''}`}
                disabled={switchDisabled && !isActive}
                aria-current={isActive ? 'true' : undefined}
                title={
                  isActive
                    ? (dict.ui.copy.currentlyActiveBranch)
                    : switchDisabled
                      ? (dict.ui.copy.waitForTheCurrentTurn)
                      : (dict.ui.copy.clickToSwitchToThis)
                }
                onClick={() => {
                  if (!isActive && !switchDisabled && onSwitchBranch) {
                    onSwitchBranch(tree.rootSessionId, node.branchId);
                  }
                }}
                data-testid={`tree-node-${node.branchId}`}
              >
                <div className="conv-tree-card-head">
                  <span className="conv-tree-node-kind">
                    {isRoot ? <Icon icon={GitCommitHorizontal} size="sm" /> : <Icon icon={GitBranch} size="xs" />}
                    <span>{branchTitle}</span>
                  </span>
                  <span className="spacer" />
                  {isActive ? (
                    <span className="conv-tree-active-badge" data-testid={`tree-node-active-${node.branchId}`}>
                      <Icon icon={Check} size="xs" />
                      <span>{dict.ui.copy.active}</span>
                    </span>
                  ) : node.status === 'streaming' || node.status === 'waiting_approval' ? (
                    <span className={`status-dot is-${node.status}`} />
                  ) : null}
                  <span className="conv-tree-time">{formatRelativeTime(node.updatedAt, dict)}</span>
                </div>

                {node.forkPromptPreview && (
                  <div className="conv-tree-prompt" title={node.forkPromptPreview}>
                    <span className="conv-tree-prompt-chevron">&gt;</span>
                    <span className="conv-tree-prompt-text">{node.forkPromptPreview}</span>
                  </div>
                )}

                {node.latestAssistantPreview && (
                  <div className="conv-tree-reply" title={node.latestAssistantPreview}>
                    <span className="conv-tree-reply-dot" aria-hidden="true">⏺</span>
                    <span className="conv-tree-reply-text">{node.latestAssistantPreview}</span>
                  </div>
                )}

                <div className="conv-tree-card-foot">
                  <span className="conv-tree-stat">
                    <Icon icon={MessageSquare} size="xs" />
                    <span>{dict.ui.copy.fmtTurns(node.userTurnCount)}</span>
                  </span>
                  <span
                    className="conv-tree-stat mono"
                    data-testid={`tree-node-context-${node.branchId}`}
                  >
                    <span className="conv-tree-mini-bar" aria-hidden="true">
                      <span style={{ '--fill': maxTokens ? Math.max(usedTokens > 0 ? 6 : 0, Math.min(100, ratio * 100)) / 100 : 0 } as React.CSSProperties} />
                    </span>
                    <span>{formatTokenShort(usedTokens)}</span>
                  </span>
                  {node.modelId && (
                    <span
                      className="conv-tree-stat mono truncate"
                      title={dict.ui.copy.branchModel}
                      data-testid={`tree-node-model-${node.branchId}`}
                    >
                      {node.modelId}
                    </span>
                  )}
                  {costUsd > 0 && (
                    <span className="conv-tree-stat mono" data-testid={`tree-node-cost-${node.branchId}`}>
                      {formatUsd(costUsd)}
                    </span>
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>

      {tree.totalBranches === 1 && (
        <div className="conv-tree-tip" data-testid="conversation-tree-linear-tip">
          {dict.ui.copy.tipHoverAnyUserMessage}
        </div>
      )}
    </div>
  );
}
