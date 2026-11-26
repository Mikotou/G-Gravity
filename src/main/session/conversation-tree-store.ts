import {
  summarizeBranchSnippet, type ConversationBranchRecord, type ConversationTreeNode,
  type ConversationTreeState, type StoredConversationTree,
} from '../../shared/conversation-tree';
import type { ChatMessageItem, ManagedSessionSummary } from '../../shared/session-contract';
import { resolveModelCompactionLimit, type SessionContextTelemetry } from '../../shared/telemetry-contract';
import type { ClientStore } from '../storage/client-store';

interface RecordBranchInput {
  rootSessionId: string;
  rootPromptPreview?: string;
  rootCreatedAt?: string;
  branchId: string;
  parentBranchId: string;
  forkAfterMessageId: string | null;
  forkUserTurnIndex: number;
  forkPromptPreview: string;
  nowIso?: string;
}

interface BuildTreeContext {
  getSession(id: string): ManagedSessionSummary | undefined;
  getMessageStats(id: string): BranchMessageStats;
  getTelemetry(id: string): SessionContextTelemetry | undefined;
  getRootTitle(rootId: string): string;
}

export interface BranchMessageStats {
  users: number;
  own: number;
  firstUser?: string;
  firstOwnUser?: string;
  latestUser?: string;
  latestAssistant?: string;
}

export function summarizeBranchMessages(messages: ChatMessageItem[]): BranchMessageStats {
  const stats: BranchMessageStats = { users: 0, own: 0 };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (!m.revisionHistory) stats.own++;
    if (m.role === 'user') {
      stats.users++;
      const preview = summarizeBranchSnippet(m.content, 72);
      const fork = preview || summarizeBranchSnippet(m.annotations?.[0]?.comment || m.annotations?.[0]?.excerpt, 72);
      stats.firstUser ??= fork;
      if (!m.revisionHistory) stats.firstOwnUser ??= fork;
      stats.latestUser = preview;
    } else if (m.content?.trim()) stats.latestAssistant = summarizeBranchSnippet(m.content, 84);
  }
  return stats;
}

export function mergeBranchMessageStats(first: BranchMessageStats, last: BranchMessageStats): BranchMessageStats {
  return { users: first.users + last.users, own: first.own + last.own,
    firstUser: first.firstUser ?? last.firstUser, firstOwnUser: first.firstOwnUser ?? last.firstOwnUser,
    latestUser: last.latestUser ?? first.latestUser, latestAssistant: last.latestAssistant ?? first.latestAssistant };
}

/**
 * Profile 隔离的会话分支树持久化存储（`conversation-trees-${profileId}.json`）。
 * 负责维护主对话与所有编辑分叉子分支的 N 叉树拓扑、当前活跃分支指针，以及渲染视图快照构建。
 */
export class ConversationTreeStore {
  private profileId = 'default';
  private trees = new Map<string, StoredConversationTree>();
  private branchToRoot = new Map<string, string>();

  constructor(private store: ClientStore) {}

  private fileName(): string {
    return `conversation-trees-${this.profileId}.json`;
  }

  setProfile(profileId: string, ownedSessionIds?: ReadonlySet<string>): void {
    this.profileId = profileId;
    this.trees.clear();
    this.branchToRoot.clear();
    const raw = this.store.read<Record<string, StoredConversationTree>>(this.fileName(), {});
    let mutated = false;

    for (const [rootId, entry] of Object.entries(raw || {})) {
      if (!entry || typeof entry !== 'object' || !entry.branches || typeof entry.branches !== 'object') {
        mutated = true;
        continue;
      }
      const cleanBranches: Record<string, ConversationBranchRecord> = {};
      for (const [bid, rec] of Object.entries(entry.branches)) {
        if (!rec || typeof rec !== 'object' || typeof rec.branchId !== 'string' || !rec.branchId) {
          mutated = true;
          continue;
        }
        if (ownedSessionIds && !ownedSessionIds.has(bid)) {
          mutated = true;
          continue;
        }
        cleanBranches[bid] = {
          branchId: bid,
          parentBranchId: bid === rootId ? null : (typeof rec.parentBranchId === 'string' && rec.parentBranchId ? rec.parentBranchId : rootId),
          forkAfterMessageId: typeof rec.forkAfterMessageId === 'string' && rec.forkAfterMessageId ? rec.forkAfterMessageId : null,
          forkUserTurnIndex: bid === rootId ? -1 : (typeof rec.forkUserTurnIndex === 'number' && Number.isFinite(rec.forkUserTurnIndex) ? Math.max(0, Math.round(rec.forkUserTurnIndex)) : 0),
          forkPromptPreview: typeof rec.forkPromptPreview === 'string' ? rec.forkPromptPreview : '',
          createdAt: typeof rec.createdAt === 'string' && rec.createdAt ? rec.createdAt : new Date().toISOString(),
          updatedAt: typeof rec.updatedAt === 'string' && rec.updatedAt ? rec.updatedAt : new Date().toISOString(),
        };
      }

      if (!cleanBranches[rootId]) {
        mutated = true;
        continue;
      }
      // 修复悬空父节点指向根
      for (const rec of Object.values(cleanBranches)) {
        if (rec.parentBranchId && !cleanBranches[rec.parentBranchId]) {
          rec.parentBranchId = rootId;
          mutated = true;
        }
      }
      if (Object.keys(cleanBranches).length <= 1) {
        mutated = true;
        continue;
      }
      const activeBranchId = cleanBranches[entry.activeBranchId] ? entry.activeBranchId : rootId;
      if (activeBranchId !== entry.activeBranchId) mutated = true;

      const tree: StoredConversationTree = {
        rootSessionId: rootId,
        activeBranchId,
        branches: cleanBranches,
        updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt ? entry.updatedAt : new Date().toISOString(),
      };
      this.trees.set(rootId, tree);
      for (const bid of Object.keys(cleanBranches)) {
        this.branchToRoot.set(bid, rootId);
      }
    }

    if (mutated) this.save();
  }

  private save(): void {
    const out: Record<string, StoredConversationTree> = {};
    for (const [rootId, tree] of this.trees) {
      out[rootId] = tree;
    }
    this.store.write(this.fileName(), out);
  }

  resolveRootId(sessionId: string): string {
    return this.branchToRoot.get(sessionId) || sessionId;
  }

  hasTree(sessionId: string): boolean {
    const rootId = this.resolveRootId(sessionId);
    const tree = this.trees.get(rootId);
    return Boolean(tree && Object.keys(tree.branches).length > 1);
  }

  getStoredTree(sessionId: string): StoredConversationTree | undefined {
    const rootId = this.resolveRootId(sessionId);
    const tree = this.trees.get(rootId);
    return tree ? structuredClone(tree) : undefined;
  }

  listBranchIds(sessionId: string): string[] {
    const rootId = this.resolveRootId(sessionId);
    const tree = this.trees.get(rootId);
    return tree ? Object.keys(tree.branches) : [sessionId];
  }

  isChildBranch(sessionId: string): boolean {
    const rootId = this.branchToRoot.get(sessionId);
    return Boolean(rootId && rootId !== sessionId);
  }

  recordBranch(input: RecordBranchInput): StoredConversationTree {
    const now = input.nowIso || new Date().toISOString();
    const rootId = input.rootSessionId;
    let tree = this.trees.get(rootId);
    if (!tree) {
      tree = {
        rootSessionId: rootId,
        activeBranchId: rootId,
        branches: {
          [rootId]: {
            branchId: rootId,
            parentBranchId: null,
            forkAfterMessageId: null,
            forkUserTurnIndex: -1,
            forkPromptPreview: summarizeBranchSnippet(input.rootPromptPreview, 72),
            createdAt: input.rootCreatedAt || now,
            updatedAt: now,
          },
        },
        updatedAt: now,
      };
      this.trees.set(rootId, tree);
      this.branchToRoot.set(rootId, rootId);
    } else if (input.rootPromptPreview && !tree.branches[rootId]?.forkPromptPreview) {
      tree.branches[rootId].forkPromptPreview = summarizeBranchSnippet(input.rootPromptPreview, 72);
    }

    const parentId = tree.branches[input.parentBranchId] ? input.parentBranchId : rootId;
    tree.branches[input.branchId] = {
      branchId: input.branchId,
      parentBranchId: parentId,
      forkAfterMessageId: input.forkAfterMessageId ?? null,
      forkUserTurnIndex: Math.max(0, Math.round(input.forkUserTurnIndex)),
      forkPromptPreview: summarizeBranchSnippet(input.forkPromptPreview, 72),
      createdAt: now,
      updatedAt: now,
    };
    tree.activeBranchId = input.branchId;
    tree.updatedAt = now;
    this.branchToRoot.set(input.branchId, rootId);
    this.save();
    return structuredClone(tree);
  }

  setActiveBranch(sessionId: string, targetBranchId: string, nowIso?: string): StoredConversationTree {
    const rootId = this.resolveRootId(sessionId);
    const tree = this.trees.get(rootId);
    if (!tree || !tree.branches[targetBranchId]) {
      throw new Error('目标分支不属于当前会话树');
    }
    const now = nowIso || new Date().toISOString();
    tree.activeBranchId = targetBranchId;
    tree.updatedAt = now;
    tree.branches[targetBranchId].updatedAt = now;
    this.save();
    return structuredClone(tree);
  }

  touchBranch(branchId: string, nowIso?: string): void {
    const rootId = this.branchToRoot.get(branchId);
    if (!rootId) return;
    const tree = this.trees.get(rootId);
    const rec = tree?.branches[branchId];
    if (!tree || !rec) return;
    const now = nowIso || new Date().toISOString();
    rec.updatedAt = now;
    tree.updatedAt = now;
    this.save();
  }

  /** 移除指定分支（若为根则整棵树清除）；返回所有从树中移除的分支 ID */
  removeBranchOrTree(sessionId: string): string[] {
    const rootId = this.branchToRoot.get(sessionId);
    if (!rootId) return [sessionId];
    const tree = this.trees.get(rootId);
    if (!tree) return [sessionId];

    if (sessionId === rootId) {
      const removed = Object.keys(tree.branches);
      for (const bid of removed) this.branchToRoot.delete(bid);
      this.trees.delete(rootId);
      this.save();
      return removed;
    }

    // 删除某个子分支及其所有后代
    const toRemove = new Set<string>([sessionId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rec of Object.values(tree.branches)) {
        if (!toRemove.has(rec.branchId) && rec.parentBranchId && toRemove.has(rec.parentBranchId)) {
          toRemove.add(rec.branchId);
          grew = true;
        }
      }
    }
    for (const bid of toRemove) {
      delete tree.branches[bid];
      this.branchToRoot.delete(bid);
    }
    if (Object.keys(tree.branches).length <= 1) {
      for (const bid of Object.keys(tree.branches)) this.branchToRoot.delete(bid);
      this.trees.delete(rootId);
    } else if (!tree.branches[tree.activeBranchId]) {
      tree.activeBranchId = rootId;
      tree.updatedAt = new Date().toISOString();
    }
    this.save();
    return [...toRemove];
  }

  applyMetadata(session: ManagedSessionSummary, rootTitle?: string): ManagedSessionSummary {
    const rootId = this.branchToRoot.get(session.sessionId);
    if (!rootId) return session;
    const tree = this.trees.get(rootId);
    if (!tree) return session;
    const node = tree.branches[session.sessionId];
    const branchCount = Object.keys(tree.branches).length;
    if (!node || branchCount <= 1) return session;

    return {
      ...session,
      title: rootTitle || session.title,
      rootSessionId: tree.rootSessionId,
      parentBranchId: node.parentBranchId,
      forkAfterMessageId: node.forkAfterMessageId,
      branchCount,
      activeBranchId: tree.activeBranchId,
    };
  }

  buildTreeState(sessionId: string, ctx: BuildTreeContext): ConversationTreeState {
    const rootId = this.resolveRootId(sessionId);
    const stored = this.trees.get(rootId);
    const rootTitle = ctx.getRootTitle(rootId);

    const records: Record<string, ConversationBranchRecord> = stored
      ? structuredClone(stored.branches)
      : {
          [rootId]: {
            branchId: rootId,
            parentBranchId: null,
            forkAfterMessageId: null,
            forkUserTurnIndex: -1,
            forkPromptPreview: ctx.getMessageStats(rootId).firstUser || '',
            createdAt: ctx.getSession(rootId)?.updatedAt || new Date().toISOString(),
            updatedAt: ctx.getSession(rootId)?.updatedAt || new Date().toISOString(),
          },
        };

    const activeBranchId = stored?.activeBranchId && records[stored.activeBranchId]
      ? stored.activeBranchId
      : rootId;

    // 计算子分支映射
    const childrenMap = new Map<string, string[]>();
    for (const id of Object.keys(records)) childrenMap.set(id, []);
    for (const rec of Object.values(records)) {
      if (rec.parentBranchId && childrenMap.has(rec.parentBranchId)) {
        childrenMap.get(rec.parentBranchId)!.push(rec.branchId);
      }
    }
    for (const list of childrenMap.values()) {
      list.sort((a, b) => {
        const ra = records[a];
        const rb = records[b];
        if (ra.forkUserTurnIndex !== rb.forkUserTurnIndex) return ra.forkUserTurnIndex - rb.forkUserTurnIndex;
        return ra.createdAt.localeCompare(rb.createdAt) || a.localeCompare(b);
      });
    }

    // 计算从当前活跃分支回溯到根的活跃路径集合
    const activePath = new Set<string>();
    let cursor: string | null | undefined = activeBranchId;
    while (cursor && !activePath.has(cursor)) {
      activePath.add(cursor);
      cursor = records[cursor]?.parentBranchId ?? null;
    }

    // 同一分叉点分组（计算 siblingIndex / siblingCount）
    const forkGroupMap = new Map<string, string[]>();
    for (const rec of Object.values(records)) {
      if (!rec.parentBranchId) continue;
      const key = `${rec.parentBranchId}\x00${rec.forkAfterMessageId ?? 'ROOT'}\x00${rec.forkUserTurnIndex}`;
      const list = forkGroupMap.get(key) || [];
      list.push(rec.branchId);
      forkGroupMap.set(key, list);
    }
    for (const list of forkGroupMap.values()) {
      list.sort((a, b) => records[a].createdAt.localeCompare(records[b].createdAt) || a.localeCompare(b));
    }

    const depthOf = (id: string): number => {
      let d = 0;
      const seen = new Set<string>([id]);
      let cur = records[id]?.parentBranchId ?? null;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        d++;
        cur = records[cur]?.parentBranchId ?? null;
      }
      return d;
    };

    const nodesById: Record<string, ConversationTreeNode> = {};
    for (const rec of Object.values(records)) {
      const sess = ctx.getSession(rec.branchId);
      const stats = ctx.getMessageStats(rec.branchId);
      const tele = ctx.getTelemetry(rec.branchId);

      let siblingIndex = 1;
      let siblingCount = 1;
      if (rec.parentBranchId) {
        const key = `${rec.parentBranchId}\x00${rec.forkAfterMessageId ?? 'ROOT'}\x00${rec.forkUserTurnIndex}`;
        const siblings = forkGroupMap.get(key) || [rec.branchId];
        siblingCount = siblings.length + 1;
        siblingIndex = Math.max(0, siblings.indexOf(rec.branchId)) + 2;
      } else {
        const rootTurn0 = forkGroupMap.get(`${rootId}\x00ROOT\x000`) || [];
        siblingCount = rootTurn0.length + 1;
        siblingIndex = 1;
      }

      const modelId = tele?.modelId || sess?.modelId || '';
      const maxContextTokens = tele?.maxContextTokens || resolveModelCompactionLimit(modelId);
      const usedContextTokens = tele?.usedContextTokens || 0;
      const usageRatio = tele?.usageRatio ?? Math.min(1, usedContextTokens / Math.max(1, maxContextTokens));

      const forkPreview =
        rec.forkPromptPreview ||
        stats.firstOwnUser || stats.firstUser || '';

      nodesById[rec.branchId] = {
        ...rec,
        forkPromptPreview: forkPreview,
        rootSessionId: rootId,
        childrenIds: childrenMap.get(rec.branchId) || [],
        depth: depthOf(rec.branchId),
        siblingIndex,
        siblingCount,
        isActiveBranch: rec.branchId === activeBranchId,
        isOnActivePath: activePath.has(rec.branchId),
        userTurnCount: stats.users,
        ownMessageCount: stats.own,
        latestUserPreview: stats.latestUser || '',
        latestAssistantPreview: stats.latestAssistant || '',
        status: sess?.status || 'closed',
        modelId,
        usedContextTokens,
        maxContextTokens,
        usageRatio,
        totalCostUsd: tele?.costSummary?.totalCostUsd || 0,
      };
    }

    // 按拓扑 DFS 前序构建 nodes 数组
    const ordered: ConversationTreeNode[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id) || !nodesById[id]) return;
      visited.add(id);
      ordered.push(nodesById[id]);
      for (const childId of nodesById[id].childrenIds) visit(childId);
    };
    visit(rootId);
    for (const id of Object.keys(nodesById)) visit(id);

    return {
      rootSessionId: rootId,
      rootTitle,
      activeBranchId,
      totalBranches: ordered.length,
      nodes: ordered,
      nodesById,
      updatedAt: stored?.updatedAt || nodesById[activeBranchId]?.updatedAt || new Date().toISOString(),
    };
  }
}
