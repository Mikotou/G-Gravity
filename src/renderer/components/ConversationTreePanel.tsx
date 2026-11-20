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
  const { locale, dict } = useI18n();
  const zh = locale === 'zh-CN';

  const rows = useMemo(() => (tree ? buildConversationTreeRenderRows(tree) : []), [tree]);

  if (!sessionId || !tree || rows.length === 0) {
    return (
      <div className="inspector-stack" data-testid="conversation-tree-panel">
        <div className="empty-state">
          {zh ? '选择一个对话后，可在此查看与切换对话分支树' : 'Select a conversation to view and switch its branch tree'}
        </div>
      </div>
    );
  }

  const activeNode = tree.nodesById[tree.activeBranchId] || tree.nodes[0];
  const activeLiveTele = activeNode ? telemetry.activeSessions[activeNode.branchId] : undefined;
  const activeUsed = activeLiveTele?.usedContextTokens ?? activeNode?.usedContextTokens ?? 0;
  const activeMax = activeLiveTele?.maxContextTokens ?? activeNode?.maxContextTokens ?? 512_000;
  const activeRatio = Math.min(1, activeUsed / Math.max(1, activeMax));
  const switchDisabled = busy || switchingBranch;

  return (
    <div className="inspector-stack conv-tree-panel" data-testid="conversation-tree-panel">
      <section className="conv-tree-summary" data-testid="conversation-tree-summary">
        <div className="conv-tree-summary-head">
          <div className="conv-tree-summary-title">
            <GitBranch size={14} className="conv-tree-icon" />
            <span className="truncate" title={tree.rootTitle}>
              {tree.rootTitle || (zh ? '主对话' : 'Main thread')}
            </span>
          </div>
          <span className="badge badge-accent" data-testid="conversation-tree-branch-count">
            {zh ? `${tree.totalBranches} 个分支` : `${tree.totalBranches} ${tree.totalBranches === 1 ? 'branch' : 'branches'}`}
          </span>
        </div>

        <div className="conv-tree-active-context">
          <div className="conv-tree-active-context-meta">
            <span className="muted">
              {zh ? '当前分支 Context' : 'Active branch Context'}
            </span>
            <span className="mono" data-testid="conversation-tree-active-context">
              {formatTokenShort(activeUsed)} / {formatTokenShort(activeMax)} · {(activeRatio * 100).toFixed(1)}%
            </span>
          </div>
          <div className="conv-tree-progress-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(activeUsed > 0 ? 3 : 0, Math.min(100, activeRatio * 100))}%` }} />
          </div>
          {onOpenContextTab && (
            <button
              type="button"
              className="conv-tree-context-link"
              onClick={onOpenContextTab}
              data-testid="conversation-tree-open-context"
            >
              <BarChart3 size={11} />
              <span>{zh ? '在 Context 窗口查看该分支详情' : 'Inspect this branch in Context'}</span>
              <ArrowRight size={11} />
            </button>
          )}
        </div>
      </section>

      <div className="conv-tree-list" role="tree" aria-label={zh ? '对话分支树' : 'Conversation branch tree'} data-testid="conversation-tree-nodes">
        {rows.map(({ node, ancestorHasMore, isLastChild }) => {
          const liveTele = telemetry.activeSessions[node.branchId];
          const usedTokens = liveTele?.usedContextTokens ?? node.usedContextTokens;
          const maxTokens = liveTele?.maxContextTokens ?? node.maxContextTokens;
          const costUsd = liveTele?.costSummary?.totalCostUsd ?? node.totalCostUsd;
          const ratio = Math.min(1, usedTokens / Math.max(1, maxTokens));
          const isRoot = node.parentBranchId === null;
          const isActive = node.isActiveBranch;
          const branchTitle = isRoot
            ? (zh ? '主对话' : 'Main')
            : zh
              ? `第 ${node.forkUserTurnIndex + 1} 轮分叉 · ${node.siblingIndex}/${node.siblingCount}`
              : `Turn ${node.forkUserTurnIndex + 1} fork · ${node.siblingIndex}/${node.siblingCount}`;

          return (
            <div
              key={node.branchId}
              className={`conv-tree-row ${isActive ? 'is-active' : ''} ${node.isOnActivePath ? 'is-on-path' : ''}`}
              role="treeitem"
              aria-selected={isActive}
              data-depth={node.depth}
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
                    ? (zh ? '当前正在查看此分支' : 'Currently active branch')
                    : switchDisabled
                      ? (zh ? '请等待当前回合结束后切换分支' : 'Wait for the current turn to finish before switching')
                      : (zh ? '点击切换至此分支并同步 Context 窗口' : 'Click to switch to this branch and sync Context')
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
                    {isRoot ? <GitCommitHorizontal size={13} /> : <GitBranch size={12} />}
                    <span>{branchTitle}</span>
                  </span>
                  <span className="spacer" />
                  {isActive ? (
                    <span className="conv-tree-active-badge" data-testid={`tree-node-active-${node.branchId}`}>
                      <Check size={10} />
                      <span>{zh ? '当前' : 'Active'}</span>
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
                    <span className="conv-tree-reply-dot">⏺</span>
                    <span className="conv-tree-reply-text">{node.latestAssistantPreview}</span>
                  </div>
                )}

                <div className="conv-tree-card-foot">
                  <span className="conv-tree-stat">
                    <MessageSquare size={10} />
                    <span>{zh ? `${node.userTurnCount} 轮` : `${node.userTurnCount} turns`}</span>
                  </span>
                  <span
                    className="conv-tree-stat mono"
                    data-testid={`tree-node-context-${node.branchId}`}
                  >
                    <span className="conv-tree-mini-bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(usedTokens > 0 ? 6 : 0, Math.min(100, ratio * 100))}%` }} />
                    </span>
                    <span>{formatTokenShort(usedTokens)}</span>
                  </span>
                  {costUsd > 0 && (
                    <span className="conv-tree-stat mono">{formatUsd(costUsd)}</span>
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>

      {tree.totalBranches === 1 && (
        <div className="conv-tree-tip" data-testid="conversation-tree-linear-tip">
          {zh
            ? '提示：悬停任意历史用户消息并点击编辑（或在空输入框按 ↑），即可从该位置分叉并保留原回复；编辑后的分支同样可以继续追问与再次分叉，左侧历史栏始终只保留主对话。'
            : 'Tip: Hover any user message and click Edit (or press ↑ in an empty composer) to branch in place without losing the original reply. You can continue replying and branching inside any branch while the sidebar stays clean.'}
        </div>
      )}
    </div>
  );
}
