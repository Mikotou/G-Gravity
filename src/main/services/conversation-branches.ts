import { prepareAttachments } from '../session/message-images';
import { modelMessage } from '../session/annotation-prompt';
import { randomUUID } from 'node:crypto';
import type { ReviseMessageInput, SwitchConversationBranchResult } from '../../shared/ipc-channels';
import type { ManagedSessionSummary, ChatMessageItem } from '../../shared/session-contract';
import { MAX_PARALLEL_ACTIVE_SESSIONS } from '../../shared/session-contract';
import { diagnosticDetail } from './session-diagnostics';
import { prepareRevision } from '../../shared/message-revision';
import {
  summarizeBranchSnippet, type ConversationTreeState, type SwitchConversationBranchInput,
} from '../../shared/conversation-tree';
import type { ConversationMessages } from '../storage/conversation-messages';
import type { BranchHost } from '../core-contracts';
import type { WorkspaceSettings } from './workspace-settings';


interface BranchContext {
  messages(): ConversationMessages;
  branchTelemetry(ids: ReadonlySet<string>): SwitchConversationBranchResult['telemetry'];
  enrich(session: ManagedSessionSummary): ManagedSessionSummary;
  isSessionTurnActive(sessionId: string): boolean;
  isManaging(sessionId: string): boolean;
  isDisposed(): boolean;
  upsert(message: ChatMessageItem): void;
  discardNewBranch(id: string): Promise<void>;
}

export class ConversationBranches {
  readonly revising = new Set<string>();

  private switching = new Set<string>();
  constructor(private app: BranchHost, private settings: WorkspaceSettings, private context: BranchContext) {}
  private findCanonicalBranchForMessage(rootId: string, originMessageId: string | null, fallbackBranchId: string): string {
    if (!originMessageId) return rootId;
    for (const bid of this.app.trees.listBranchIds(rootId)) {
      if (this.context.messages().findWhere(bid, m => !m.revisionHistory && (m.originMessageId === originMessageId || m.id === originMessageId))) {
        return bid;
      }
    }
    return fallbackBranchId;
  }
  private buildTreeState(sessionId: string): ConversationTreeState {
    const rootId = this.app.trees.resolveRootId(sessionId);
    for (const bid of this.app.trees.listBranchIds(rootId)) {
      const sess = this.app.sessions.sessions.get(bid);
      if (sess && !this.app.telemetry.hasSessionTelemetry(bid)) {
        this.app.telemetry.hydrateFromMessages(bid, sess.modelId, () => this.context.messages().forStatistics(bid));
      }
    }
    return this.app.trees.buildTreeState(rootId, {
      getSession: id => this.app.sessions.sessions.get(id),
      getMessageStats: id => this.context.messages().branchStats(id),
      getTelemetry: id => this.app.telemetry.getSessionTelemetry(id),
      getRootTitle: id => {
        const root = this.app.sessions.sessions.get(id);
        return root ? this.app.titles.apply(root).title : '新建对话';
      },
    });
  }
  emitTreeUpdate(sessionId: string): void {
    const rootId = this.app.trees.resolveRootId(sessionId);
    if (this.switching.has(rootId)) return;
    if (!this.app.sessions.sessions.has(rootId) && !this.app.trees.hasTree(rootId)) return;
    this.app.emit('tree-updated', this.buildTreeState(rootId));
  }
  async reviseMessage(input: ReviseMessageInput): Promise<ManagedSessionSummary> {
    this.app.accounts.assertReady();
    const origin = this.app.sessions.get(input.sessionId);
    const profile = this.app.accounts.activeProfileId;
    if (origin.profileId !== profile || origin.readOnly || !this.app.sessions.isActive(origin.sessionId) ||
        this.context.isSessionTurnActive(origin.sessionId) || this.revising.has(origin.sessionId) || this.context.isManaging(origin.sessionId)) {
      throw new Error('请等当前回合结束后再编辑');
    }
    const originMessages = this.context.messages().get(origin.sessionId) || [];
    const { prefix, references, attachments, annotations } = prepareRevision(originMessages, input);
    const original = originMessages.find(m => m.id === input.messageId)!;
    const selected = original.attachments?.filter(a => !input.attachmentIds || input.attachmentIds.includes(a.id));
    if (input.attachmentIds?.some(id => !selected?.some(a => a.id === id))) throw new Error('选中的附件不存在');
    if (modelMessage(input.text, annotations).length > 1_000_000) throw new Error('修订内容超过上限');
    const rootId = this.app.trees.resolveRootId(origin.sessionId);
    const rootSession = this.app.sessions.sessions.get(rootId) || origin;
    const rootTitle = this.app.titles.apply(rootSession).title;
    const forkUserTurnIndex = prefix.filter(m => m.role === 'user').length;
    const lastPrefix = prefix.at(-1);
    const forkAfterMessageId = lastPrefix ? (lastPrefix.originMessageId || lastPrefix.id) : null;
    const canonicalParentBranchId = this.findCanonicalBranchForMessage(rootId, forkAfterMessageId, origin.sessionId);
    const rootFirstUser = this.context.messages().firstTurns(rootId).find(m => m.role === 'user');
    const rootPromptPreview = summarizeBranchSnippet(
      rootFirstUser?.content || rootFirstUser?.annotations?.[0]?.comment || rootFirstUser?.annotations?.[0]?.excerpt,
      72
    );
    const forkPromptPreview = summarizeBranchSnippet(
      input.text.trim() || annotations?.[0]?.comment || annotations?.[0]?.excerpt || attachments?.[0]?.name || '',
      72
    );
    let replacedLayout: WorkspaceSettings['layout'] | undefined;
    let originalLayout: WorkspaceSettings['layout'] | undefined;
    let branch: ManagedSessionSummary | undefined;
    this.revising.add(origin.sessionId);
    try {
      // The edited branch replaces this live tab. Release the official worker first and restore it on failure.
      const prepared = attachments.length ? await prepareAttachments(attachments, origin.cwd) : [];
      this.app.accounts.assertReady();
      if (profile !== this.app.accounts.activeProfileId || !this.app.sessions.isActive(origin.sessionId) ||
          this.context.isSessionTurnActive(origin.sessionId)) throw new Error('原会话状态已改变');
      await this.app.closeSession(origin.sessionId);
      this.app.accounts.assertReady();
      if (profile !== this.app.accounts.activeProfileId) throw new Error('账号资料已切换');
      branch = await this.app.createSession({
        cwd: origin.cwd,
        title: rootTitle,
        executionMode: origin.executionMode,
        reasoningEffort: origin.availableEfforts?.length === 0 ? undefined : origin.reasoningEffort,
        modelId: origin.modelId || undefined,
      });
      const id = branch.sessionId;
      if (profile !== this.app.accounts.activeProfileId) throw new Error('账号资料已切换');
      // 保留前缀消息的稳定 originMessageId，以便同一分叉点多次修订及更深层嵌套分支精确归组。
      const history = prefix.map(m => {
        const copy = structuredClone(m);
        copy.originMessageId = m.originMessageId || m.id;
        copy.id = randomUUID(); copy.sessionId = id; copy.revisionHistory = true; copy.isStreaming = false;
        delete copy.pendingApprovalId;
        for (const thought of copy.thoughts || []) { thought.id = randomUUID(); thought.isStreaming = false; thought.isTranslating = false; }
        return copy;
      });
      this.context.messages().set(id, [...history, ...(this.context.messages().get(id) || [])]);
      this.context.messages().save();
      this.app.trees.recordBranch({
        rootSessionId: rootId,
        rootPromptPreview,
        rootCreatedAt: rootSession.updatedAt,
        branchId: id,
        parentBranchId: canonicalParentBranchId,
        forkAfterMessageId,
        forkUserTurnIndex,
        forkPromptPreview,
      });
      if (this.settings.layout.openTabSessionIds.includes(origin.sessionId)) {
        const replaceId = (val: string | null) => (val === origin.sessionId ? id : val);
        originalLayout = this.settings.layout;
        this.settings.saveWorkspaceLayout({
          openTabSessionIds: [...new Set(this.settings.layout.openTabSessionIds.map(t => (t === origin.sessionId ? id : t)))],
          activePrimarySessionId: replaceId(this.settings.layout.activePrimarySessionId),
          splitSecondarySessionId: replaceId(this.settings.layout.splitSecondarySessionId),
        });
        replacedLayout = this.settings.layout;
      }
      this.app.telemetry.hydrateFromMessages(id, branch.modelId, () => this.context.messages().forStatistics(id));
      const enrichedRoot = this.app.sessions.sessions.get(rootId) ? this.context.enrich(this.app.sessions.get(rootId)) : undefined;
      if (enrichedRoot) this.app.emit('session-updated', enrichedRoot);
      const enrichedBranch = this.context.enrich(this.app.sessions.get(id));
      this.app.emit('session-updated', enrichedBranch);
      this.emitTreeUpdate(rootId);
      const revision = { sessionId: id, text: input.text, references, attachments: prepared, annotations };
      void this.app.sendPrompt(revision).catch(error => {
        if (this.context.isDisposed() || this.app.accounts.activeProfileId !== profile || !this.app.sessions.sessions.has(id)) return;
        if (!(this.context.messages().get(id) || []).some(m => m.role === 'user' && !m.revisionHistory)) {
          const messageId = randomUUID();
          this.context.upsert({ id: messageId, originMessageId: messageId, sessionId: id, role: 'user', content: revision.text,
            annotations, references, attachments: structuredClone(selected), createdAt: new Date().toISOString(), sendFailed: true });
        }
        this.context.upsert({ id: randomUUID(), sessionId: id, role: 'system', createdAt: new Date().toISOString(),
          content: '修订消息发送失败。' + (diagnosticDetail(error) ?? '未知错误') });
        this.context.messages().save();
        this.emitTreeUpdate(rootId);
      }).catch(error => { this.app.emit('diagnostic', diagnosticDetail(error)); });
      return enrichedBranch;
    } catch (error) {
      if (profile === this.app.accounts.activeProfileId) {
        if (branch) {
          const id = branch.sessionId;
          try {
            if (originalLayout && replacedLayout) {
              const current = this.settings.layout;
              const undo = (value: string | null) => value === id ? origin.sessionId : value;
              this.settings.saveWorkspaceLayout(current === replacedLayout ? {
                openTabSessionIds: originalLayout.openTabSessionIds,
                activePrimarySessionId: originalLayout.activePrimarySessionId,
                splitSecondarySessionId: originalLayout.splitSecondarySessionId,
              } : {
                openTabSessionIds: [...new Set(current.openTabSessionIds.map(tab => undo(tab)!))],
                activePrimarySessionId: undo(current.activePrimarySessionId),
                splitSecondarySessionId: undo(current.splitSecondarySessionId),
              });
            }
          } catch (layoutError) { this.app.emit('diagnostic', diagnosticDetail(layoutError)); }
          try {
            await this.context.discardNewBranch(id);
          } catch (cleanupError) {
            this.app.emit('diagnostic', diagnosticDetail(cleanupError));
          }
        }
        if (!this.app.sessions.isActive(origin.sessionId)) await this.app.resumeSession(origin.sessionId, origin.cwd).catch(() => {});
        const restoredRoot = this.app.sessions.sessions.get(rootId);
        if (restoredRoot) this.app.emit('session-updated', this.context.enrich(restoredRoot));
        const restoredOrigin = origin.sessionId !== rootId ? this.app.sessions.sessions.get(origin.sessionId) : undefined;
        if (restoredOrigin) this.app.emit('session-updated', this.context.enrich(restoredOrigin));
        this.emitTreeUpdate(rootId);
      }
      throw error;
    } finally { this.revising.delete(origin.sessionId); }
  }
  async getConversationTree(sessionId: string): Promise<ConversationTreeState> {
    this.app.accounts.assertReady();
    return this.buildTreeState(sessionId);
  }
  async switchConversationBranch(input: SwitchConversationBranchInput): Promise<SwitchConversationBranchResult> {
    this.app.accounts.assertReady();
    const profile = this.app.accounts.activeProfileId;
    const rootId = this.app.trees.resolveRootId(input.sessionId);
    const targetBranchId = input.targetBranchId;
    const treeBranches = this.app.trees.listBranchIds(rootId);
    if (!treeBranches.includes(targetBranchId)) {
      throw new Error('目标分支不属于当前会话树');
    }
    const targetSession = this.app.sessions.get(targetBranchId);
    if (targetSession.profileId !== profile || targetSession.archivedAt) {
      throw new Error('目标分支不可用或已归档');
    }
    for (const bid of treeBranches) {
      if (this.context.isSessionTurnActive(bid) || this.revising.has(bid) || this.context.isManaging(bid)) {
        throw new Error('请等当前分支回合结束后再切换分支');
      }
    }
    const previousActive = treeBranches.find(bid => bid !== targetBranchId && this.app.sessions.isActive(bid)) || null;
    const previousSession = previousActive ? this.app.sessions.sessions.get(previousActive) : undefined;
    const targetWasActive = this.app.sessions.isActive(targetBranchId);
    const previousSelection = this.app.trees.getStoredTree(rootId)?.activeBranchId;
    let previousLayout: WorkspaceSettings['layout'] | undefined;
    let changedSelection = false;
    this.switching.add(rootId);
    for (const bid of treeBranches) this.revising.add(bid);
    try {
      // Keep the current branch available throughout a failed resume whenever a slot is free.
      if (previousActive && !targetWasActive && this.app.sessions.activeSessionCount >= MAX_PARALLEL_ACTIVE_SESSIONS) {
        if (this.app.sessions.client.isRateLimited) throw new Error('官方服务正在冷却，请稍后切换分支');
        await this.app.closeSession(previousActive);
      }
      const activeSession = targetWasActive ? this.context.enrich(targetSession)
        : await this.app.resumeSession(targetBranchId, targetSession.cwd);
      if (previousActive && activeSession.readOnly) throw new Error(activeSession.diagnostic?.technicalDetail || '目标分支仅可离线查看');
      if (previousActive && this.app.sessions.isActive(previousActive)) await this.app.closeSession(previousActive);
      if (profile !== this.app.accounts.activeProfileId) throw new Error('账号资料已切换');
      if (this.app.trees.hasTree(rootId)) {
        changedSelection = true;
        this.app.trees.setActiveBranch(rootId, targetBranchId);
      }
      this.app.telemetry.hydrateFromMessages(targetBranchId, activeSession.modelId, () => this.context.messages().forStatistics(targetBranchId));
      for (const bid of treeBranches) {
        if (bid === targetBranchId) continue;
        const branchSess = this.app.sessions.sessions.get(bid);
        if (branchSess && !this.app.telemetry.hasSessionTelemetry(bid)) {
          this.app.telemetry.hydrateFromMessages(bid, branchSess.modelId, () => this.context.messages().forStatistics(bid));
        }
      }

      // 原地替换工作台布局中属于同一对话树的旧分支 ID，保持标签位与分屏位稳定不变。
      const treeSet = new Set(treeBranches);
      const hasTreeTab = this.settings.layout.openTabSessionIds.some(id => treeSet.has(id));
      if (hasTreeTab) {
        const replaceId = (id: string | null) => (id && treeSet.has(id) ? targetBranchId : id);
        const nextTabs = [...new Set(this.settings.layout.openTabSessionIds.map(id => (treeSet.has(id) ? targetBranchId : id)))];
        const nextPrimary = replaceId(this.settings.layout.activePrimarySessionId);
        previousLayout = this.settings.layout;
        const rawSecondary = replaceId(this.settings.layout.splitSecondarySessionId);
        const nextSecondary = rawSecondary && rawSecondary !== nextPrimary ? rawSecondary : null;
        this.settings.saveWorkspaceLayout({
          openTabSessionIds: nextTabs,
          activePrimarySessionId: nextPrimary,
          splitSecondarySessionId: nextSecondary,
        });
      }

      const [swarm, inspector] = await Promise.all([
        this.app.swarm.readState(targetBranchId), this.app.getSessionInspector(targetBranchId),
      ]);
      if (profile !== this.app.accounts.activeProfileId) throw new Error('账号资料已切换');
      const enrichedActive = this.context.enrich(activeSession);
      const enrichedRoot = this.app.sessions.sessions.get(rootId) ? this.context.enrich(this.app.sessions.get(rootId)) : undefined;
      if (enrichedRoot) this.app.emit('session-updated', enrichedRoot);
      if (previousActive && this.app.sessions.sessions.has(previousActive)) {
        this.app.emit('session-updated', this.context.enrich(this.app.sessions.get(previousActive)));
      }
      this.app.emit('session-updated', enrichedActive);

      const tree = this.buildTreeState(rootId);
      const { messages, ...messagePosition } = this.context.messages().page(targetBranchId);
      return {
        session: enrichedActive,
        previousBranchId: previousActive,
        messages: structuredClone(messages),
        messagePosition,
        inspector,
        swarm,
        tree,
        telemetry: this.context.branchTelemetry(treeSet),
        layout: structuredClone(this.settings.layout),
      };
    } catch (error) {
      if (profile !== this.app.accounts.activeProfileId) throw error;
      const rollbackErrors: unknown[] = [];
      if (previousLayout && previousLayout !== this.settings.layout) {
        try {
          this.settings.saveWorkspaceLayout({
            openTabSessionIds: previousLayout.openTabSessionIds,
            activePrimarySessionId: previousLayout.activePrimarySessionId,
            splitSecondarySessionId: previousLayout.splitSecondarySessionId,
          });
        } catch (err) { rollbackErrors.push(err); }
      }
      if (changedSelection && previousSelection) {
        try { this.app.trees.setActiveBranch(rootId, previousSelection); } catch (err) { rollbackErrors.push(err); }
      }
      if (!targetWasActive && this.app.sessions.isActive(targetBranchId)) {
        try { await this.app.closeSession(targetBranchId); } catch (err) { rollbackErrors.push(err); }
      }
      if (previousSession && !this.app.sessions.isActive(previousSession.sessionId)) {
        try {
          const restored = await this.app.resumeSession(previousSession.sessionId, previousSession.cwd);
          if (restored.readOnly) rollbackErrors.push(restored.diagnostic?.technicalDetail || '上一分支仅可离线查看');
        } catch (err) { rollbackErrors.push(err); }
      }
      this.switching.delete(rootId);
      this.emitTreeUpdate(rootId);
      if (rollbackErrors.length) throw new Error(`分支切换失败（${diagnosticDetail(error)}），恢复原分支失败（${diagnosticDetail(rollbackErrors[0])}）`, { cause: error });
      throw error;
    } finally {
      this.switching.delete(rootId);
      for (const bid of treeBranches) this.revising.delete(bid);
    }
  }
}
