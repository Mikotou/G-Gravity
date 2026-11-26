/**
 * Gravity v0.2.3 — 会话树状分支（Codex 风格原地分叉、多级嵌套与上下文同步）共享契约与纯函数算法
 */

import type {
  ChatMessageItem,
  MessagePagePosition,
  ManagedSessionStatus,
} from './session-contract';

/** 持久化存储的单个分支节点记录 */
export interface ConversationBranchRecord {
  branchId: string;
  /** 拓扑父分支 ID（根节点为 null） */
  parentBranchId: string | null;
  /** 分叉点之前最后一条非系统消息的稳定 originMessageId；null 表示根节点或第 0 轮分叉 */
  forkAfterMessageId: string | null;
  /** 分叉发生在第几条用户消息（0-based；根节点固定为 -1） */
  forkUserTurnIndex: number;
  /** 分叉处的用户提示词摘要（根节点为首条用户消息摘要） */
  forkPromptPreview: string;
  createdAt: string;
  updatedAt: string;
}

/** 持久化存储的一棵主对话树 */
export interface StoredConversationTree {
  rootSessionId: string;
  activeBranchId: string;
  branches: Record<string, ConversationBranchRecord>;
  updatedAt: string;
}

/** 渲染层展示用的富化分支节点（包含树深度、同级序号、摘要与该分支实时 Context 占用） */
export interface ConversationTreeNode extends ConversationBranchRecord {
  rootSessionId: string;
  childrenIds: string[];
  depth: number;
  /** 同一分叉点下同级分支序号（1-based） */
  siblingIndex: number;
  /** 同一分叉点下同级分支总数 */
  siblingCount: number;
  isActiveBranch: boolean;
  isOnActivePath: boolean;
  userTurnCount: number;
  ownMessageCount: number;
  latestUserPreview: string;
  latestAssistantPreview: string;
  status: ManagedSessionStatus;
  modelId: string;
  usedContextTokens: number;
  maxContextTokens: number;
  usageRatio: number;
  totalCostUsd: number;
}

/** 一条主对话的完整树状视图快照 */
export interface ConversationTreeState {
  rootSessionId: string;
  rootTitle: string;
  activeBranchId: string;
  totalBranches: number;
  /** 按拓扑深度优先前序排列的节点列表（根节点位于索引 0） */
  nodes: ConversationTreeNode[];
  nodesById: Record<string, ConversationTreeNode>;
  updatedAt: string;
}

/** 渲染在分叉用户消息下方的内联切换控件（‹ 2 / 3 ›） */
export interface MessageForkControl {
  rootSessionId: string;
  forkKey: string;
  forkUserTurnIndex: number;
  /** 0-based 当前激活选项下标 */
  currentIndex: number;
  /** 同级选项总数（>= 2） */
  totalCount: number;
  /** 顺序：[原分叉所属分支, 子分支1, 子分支2, ...] */
  branchIds: string[];
  prevBranchId: string | null;
  nextBranchId: string | null;
}

export interface SwitchConversationBranchInput {
  /** 当前会话 ID 或主对话 rootSessionId */
  sessionId: string;
  /** 目标分支会话 ID */
  targetBranchId: string;
}

/** 提取单行紧凑消息摘要，供分支节点预览使用 */
export function summarizeBranchSnippet(text: string | undefined, maxLen = 72): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

/**
 * 纯函数：根据当前活跃分支的消息列表与会话树状态，计算指定用户消息是否处于分叉点，
 * 若处于分叉点则返回同级分支切换控件（‹ currentIndex+1 / totalCount ›）。
 *
 * 约定：与 prepareRevision 保持一致，计算分叉前驱时过滤 system 消息，使用稳定 originMessageId || id。
 */
export function getMessageForkControl(
  tree: ConversationTreeState | undefined,
  activeBranchId: string,
  messages: ChatMessageItem[],
  messageId: string,
  position?: MessagePagePosition
): MessageForkControl | null {
  if (!tree || tree.totalBranches <= 1) return null;

  const nonSystem = messages.filter((m) => m.role !== 'system');
  const pos = nonSystem.findIndex((m) => m.id === messageId);
  if (pos < 0 || nonSystem[pos].role !== 'user') return null;

  let userTurnIndex = position?.earlierUserCount || 0;
  for (let i = 0; i < pos; i++) {
    if (nonSystem[i].role === 'user') userTurnIndex++;
  }

  const prevMsg = pos > 0 ? nonSystem[pos - 1] : null;
  const prevOriginId = prevMsg ? prevMsg.originMessageId || prevMsg.id : position?.precedingOriginId ?? null;

  const childrenAtFork = tree.nodes
    .filter(
      (n) =>
        n.parentBranchId !== null &&
        n.forkUserTurnIndex === userTurnIndex &&
        (n.forkAfterMessageId ?? null) === prevOriginId
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.branchId.localeCompare(b.branchId));

  if (childrenAtFork.length === 0) return null;

  const ownerBranchId = childrenAtFork[0].parentBranchId!;
  const branchIds = [ownerBranchId, ...childrenAtFork.map((c) => c.branchId)];

  const activeAncestors = new Set<string>();
  let cur: string | null | undefined = activeBranchId;
  while (cur && !activeAncestors.has(cur)) {
    activeAncestors.add(cur);
    cur = tree.nodesById[cur]?.parentBranchId ?? null;
  }

  const matchedChildIdx = childrenAtFork.findIndex((c) => activeAncestors.has(c.branchId));
  const currentIndex = matchedChildIdx >= 0 ? matchedChildIdx + 1 : 0;

  return {
    rootSessionId: tree.rootSessionId,
    forkKey: `${prevOriginId ?? 'ROOT'}:${userTurnIndex}`,
    forkUserTurnIndex: userTurnIndex,
    currentIndex,
    totalCount: branchIds.length,
    branchIds,
    prevBranchId: currentIndex > 0 ? branchIds[currentIndex - 1] : null,
    nextBranchId: currentIndex < branchIds.length - 1 ? branchIds[currentIndex + 1] : null,
  };
}

/**
 * 纯函数：为单个分支生成拓扑前序排序与树形连接轨信息（用于右侧「分支树」面板可视化渲染）。
 */
export interface TreeRenderRow {
  node: ConversationTreeNode;
  /** 每一层缩进是否需要绘制贯穿竖线（depth-1 个元素） */
  ancestorHasMore: boolean[];
  /** 是否是当前父节点下的最后一个子节点 */
  isLastChild: boolean;
}

export function buildConversationTreeRenderRows(tree: ConversationTreeState): TreeRenderRow[] {
  const rows: TreeRenderRow[] = [];
  const root = tree.nodesById[tree.rootSessionId] || tree.nodes[0];
  if (!root) return rows;

  const visited = new Set<string>();
  const walk = (node: ConversationTreeNode, ancestorHasMore: boolean[], isLastChild: boolean): void => {
    if (visited.has(node.branchId)) return;
    visited.add(node.branchId);
    rows.push({ node, ancestorHasMore, isLastChild });
    const children = node.childrenIds
      .map((id) => tree.nodesById[id])
      .filter((child): child is ConversationTreeNode => Boolean(child))
      .sort((a, b) => {
        if (a.forkUserTurnIndex !== b.forkUserTurnIndex) return a.forkUserTurnIndex - b.forkUserTurnIndex;
        return a.createdAt.localeCompare(b.createdAt) || a.branchId.localeCompare(b.branchId);
      });
    children.forEach((child, idx) => {
      const childIsLast = idx === children.length - 1;
      const nextTrail = node.depth === 0 ? [] : [...ancestorHasMore, !isLastChild];
      walk(child, nextTrail, childIsLast);
    });
  };

  walk(root, [], true);
  // 兜底：若存在孤立节点（异常损坏数据恢复）也一并挂在末尾可见
  for (const node of tree.nodes) {
    if (!visited.has(node.branchId)) {
      rows.push({ node, ancestorHasMore: [], isLastChild: true });
    }
  }
  return rows;
}
