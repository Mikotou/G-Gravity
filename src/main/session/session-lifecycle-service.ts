import { homedir } from 'node:os';
import type { AgentExecutionMode, AgentReasoningEffort } from '../../shared/acp-protocol';
import type { CreateSessionInput } from '../../shared/ipc-channels';
import type { ManagedSessionSummary, SessionAction } from '../../shared/session-contract';
import { isLegacyPollutionSessionTitle, withoutSession } from '../../shared/session-contract';
import { AcpRequestNotSentError } from '../acp/acp-client';
import { ConversationMessages } from '../storage/conversation-messages';
import { isSessionExecutionMode } from './session-multiplexer';
import { SwarmWorkerClient } from '../swarm/swarm-worker-client';
import { InspectorStore } from './inspector-store';
import { ConversationTreeStore } from './conversation-tree-store';
import { WorkspaceSettings } from '../services/workspace-settings';
import { diagnosticForError } from '../services/session-diagnostics';
import type { CoreServiceOptions, LifecycleHost, ProfileDataBundle } from '../core-contracts';
import type { TelemetryCoordinator } from '../telemetry/telemetry-coordinator';
import type { TurnOrchestrator } from './turn-orchestrator';

export class SessionLifecycleService {
  readonly managing = new Set<string>();
  profileData!: ProfileDataBundle;
  constructor(private app: LifecycleHost, private turns: TurnOrchestrator, private monitor: TelemetryCoordinator,
    private settings: WorkspaceSettings, private options: CoreServiceOptions) {}
  readProfileData(profileId: string): ProfileDataBundle {
    const messages = new ConversationMessages(this.app.store);
    this.loadMessages(messages, profileId);
    const owned = new Set(this.app.sessions.sessions.keys());
    const inspector = new InspectorStore(this.app.store, profileId, owned);
    const swarm = new SwarmWorkerClient({ directory: this.app.store.dataDir, profile: profileId, owned: [...owned] });
    swarm.on('storage-failed', error => this.app.emit('diagnostic', String(error)));
    const trees = new ConversationTreeStore(this.app.store);
    trees.setProfile(profileId, owned);
    inspector.on('updated', data => {
      if (inspector !== this.app.inspector) return;
      const owner = { profileId, sessionId: data.sessionId };
      const epoch = this.app.epochForSession(owner);
      if (epoch !== undefined) this.app.emit('inspector-updated', { ...data, ...owner, epoch, owner: { ...owner, epoch } });
    });
    swarm.on('updated', state => {
      if (swarm === this.app.swarm) this.app.emit('swarm-updated', state);
    });
    return { messages, inspector, swarm, trees };
  }
  prepareProfileSwitch(profileId: string) {
    // The next store reads the same global ledgers. Checkpoint before loading it.
    this.app.telemetry.flush();
    const data = this.readProfileData(profileId);
    const telemetry = this.monitor.createTelemetryStore(profileId);
    const preferences = { ...this.settings.preferences, activeProfileId: profileId };
    const layout = { ...this.settings.layout, openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null };
    try {
      this.app.store.write('preferences.json', preferences);
      this.app.store.write('layout.json', layout);
    } catch (error) {
      telemetry.dispose(false);
      try { this.app.store.write('preferences.json', this.settings.preferences); } catch { /* profiles.json owns the active selection. */ }
      throw error;
    }
    return {
      discard: () => {
        telemetry.dispose(false);
        // Revert the staged view if the account selection could not be committed.
        try { this.app.store.write('preferences.json', this.settings.preferences); } catch { /* The authoritative account selection stays unchanged. */ }
        try { this.app.store.write('layout.json', this.settings.layout); } catch { /* An empty startup layout is safe. */ }
      },
      activate: () => {
        this.app.telemetry.dispose(false);
        this.profileData = data;
        this.app.telemetry = telemetry;
        this.settings.preferences = preferences;
        this.settings.layout = layout;
        this.app.thoughts.dispose();
        this.monitor.resetProfile();
      },
    };
  }
  enrichSession(session: ManagedSessionSummary): ManagedSessionSummary {
    const titled = {
      ...this.app.titles.apply(session),
      approvalModeOverride: this.app.approval.sessionApprovalOverride(session.sessionId, session.cwd),
      hasApprovalGrants: this.app.approval.hasSessionGrants(session.sessionId, session.cwd),
    };
    const rootId = this.app.trees.resolveRootId(titled.sessionId);
    const rootSession = rootId !== titled.sessionId ? this.app.sessions.sessions.get(rootId) : undefined;
    const rootTitle = rootSession ? this.app.titles.apply(rootSession).title : titled.title;
    return this.app.trees.applyMetadata(titled, rootTitle);
  }
  /** Load recent messages; seed older installations without a session ownership ledger. */
  private loadMessages(messages: ConversationMessages, profileId: string): void {
    const hasLedger = this.app.sessions.hasPersistedLedger();
    messages.load(profileId, hasLedger ? new Set(this.app.sessions.sessions.keys()) : undefined);
    if (hasLedger) return;
    const seedEntries: Array<{ sessionId: string; title: string; cwd: string; updatedAt: string }> = [];
    for (const id of messages.keys()) {
      const normalizedItems = messages.recent(id);
      const firstUser = messages.firstTurns(id).find(m => m.role === 'user')?.content || '';
      if (normalizedItems.length > 0 && !isLegacyPollutionSessionTitle(firstUser)) {
        const plainTitle = firstUser.replace(/\s+/g, ' ').trim().slice(0, 36) || '新建对话';
        seedEntries.push({
          sessionId: id,
          title: plainTitle,
          cwd: this.options.homeDir || homedir(),
          updatedAt: normalizedItems.at(-1)?.createdAt || new Date().toISOString(),
        });
      }
    }
    // 已有归属清单时以清单为准，避免根据遗留消息重新加入先前移出的会话。
    this.app.sessions.seedOwnedFromLocalMessages(seedEntries);
  }
  async createSession(input: CreateSessionInput) {
    this.app.accounts.assertReady();
    if (input.executionMode && !isSessionExecutionMode(input.executionMode) || input.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoningEffort)) throw new Error('会话 Mode 或 Effort 无效');
    const session = await this.app.sessions.createSession(input, async candidate => {
      if (input.modelId && input.modelId !== this.app.sessions.reportedChoice(candidate.sessionId, 'model')) await this.app.sessions.setSessionModel(candidate.sessionId, input.modelId);
      if (input.executionMode && input.executionMode !== candidate.executionMode) await this.app.sessions.setSessionMode(candidate.sessionId, input.executionMode);
      if (input.reasoningEffort && candidate.availableEfforts?.length !== 0 && input.reasoningEffort !== this.app.sessions.reportedChoice(candidate.sessionId, 'thought_level')) {
        await this.app.sessions.setSessionEffort(candidate.sessionId, input.reasoningEffort);
      }
    });
    if (input.reasoningEffort && session.availableEfforts?.length === 0) {
      this.app.sessions.emit('localPreference', { sessionId: session.sessionId, text: '所选模型未声明独立推理档位，官方未确认 ' + input.reasoningEffort });
    }
    this.app.swarm.trackNew(session.sessionId);
    this.app.approval.setSessionExecutionMode(session.sessionId, session.executionMode);
    this.app.telemetry.hydrateFromMessages(session.sessionId, session.modelId, () => this.app.messages.forStatistics(session.sessionId));
    this.monitor.syncSessionCheckpointWindow(session.sessionId);
    return this.enrichSession(session);
  }
  async resumeSession(sessionId: string, cwd: string) {
    this.app.accounts.assertReady();
    if (this.managing.has(sessionId) || this.app.sessions.get(sessionId).archivedAt) throw new Error('请先从归档恢复会话');
    if (this.app.sessions.isActive(sessionId)) {
      const current = this.app.sessions.get(sessionId);
      if (current.status !== 'error' || this.app.sessions.isBusy(sessionId)) return this.enrichSession(current);
      if (this.app.client.isRateLimited) throw new AcpRequestNotSentError(this.app.client.lastError || '官方服务正在冷却，请稍后重连');
      await this.closeSession(sessionId);
    }
    if (this.app.sessions.isResuming(sessionId)) throw new Error('此会话正在恢复');
    this.turns.sessionLifetimes.delete(sessionId);
    const hadLocalMessages = this.app.messages.recent(sessionId).length > 0;
    const replay = this.turns.loadReplay.begin(sessionId, this.turns.compactAvailable);
    const profileId = this.app.accounts.activeProfileId;
    const swarm = this.app.swarm;
    const sameOwner = () => !this.app.disposed && swarm === this.app.swarm && this.app.accounts.activeProfileId === profileId;
    this.managing.add(sessionId);
    swarm.beginReplay(sessionId);
    let session: ManagedSessionSummary;
    try {
      const needHistory = replay.first || replay.recovering || this.app.inspector.needsPlanReplay(sessionId);
      session = await this.app.sessions.resumeSession(sessionId, cwd, needHistory || (() => swarm.needsReplay(sessionId)));
      if (!replay.current()) throw new Error('恢复期间会话归属已改变');
      await swarm.finishReplay(sessionId);
      replay.commit();
      const caps = this.app.client.initializeResult?.agentCapabilities;
      if (needHistory && (caps?.loadSession || caps?.load_session)) this.app.inspector.finishPlanReplay(sessionId);
    } catch (error) {
      // 仅在切号/退出导致归属变更时直接中止；同 Profile 下 ACP 启动失败或断连仍须走下方离线只读回退，同时 planReplay.current() 已失效确保不提交脏 Plan。
      if (!sameOwner()) throw error;
      const localExisting = this.app.sessions.sessions.get(sessionId);
      // 已保存的对话可以离线阅读。只在恢复成功后重新启用输入和编辑。
      const diagnostic = diagnosticForError(error, this.app.client);
      const blocked = ['concurrency_limit_reached', 'rate_limited_429', 'permission_denied_403', 'auth_required_401'].includes(diagnostic.code);
      const unavailable = !this.app.client.connected || diagnostic.code === 'acp_disconnected' || (error instanceof Error &&
        /不支持恢复会话|会话不存在|(?:session|conversation).*(?:not found|expired|does not exist)|method not found/i.test(error.message));
      if (localExisting && hadLocalMessages && !blocked && !this.app.client.isRateLimited && unavailable) {
        session = { ...localExisting, readOnly: true, status: 'closed', diagnostic: diagnosticForError(error, this.app.client, 'resume_failed') };
        this.app.sessions.updateSessionRecord(session, false);
        this.app.emit('session-updated', this.enrichSession(session));
      } else {
        this.app.sessions.setStatus(sessionId, 'error', diagnostic);
        throw error;
      }
    } finally {
      this.managing.delete(sessionId);
      if (sameOwner()) swarm.discardReplay(sessionId);
      replay.discard();
    }
    this.app.approval.setSessionExecutionMode(session.sessionId, session.executionMode);
    this.app.telemetry.hydrateFromMessages(sessionId, session.modelId, () => this.app.messages.forStatistics(sessionId));
    this.monitor.syncSessionCheckpointWindow(sessionId);
    this.turns.finishMessage(sessionId);
    return this.enrichSession(session);
  }
  async closeSession(sessionId: string): Promise<void> {
    this.turns.promptOwners.get(sessionId)?.abort(new Error('会话正在关闭'));
    this.turns.questions.cancel(sessionId);
    this.app.approval.cancelSession(sessionId);
    // Offline tabs can observe plan files without an ACP slot to emit 'closed'.
    if (!this.app.sessions.isActive(sessionId)) this.app.retireSession(sessionId);
    await this.app.sessions.closeSession(sessionId);
  }
  private async finishDeletion(id: string): Promise<void> {
    this.app.retireSession(id);
    const profile = this.app.accounts.activeProfileId;
    this.app.approval.clearSessionGrants(id);
    this.turns.releaseSession(id);
    this.monitor.resetSession(id);
    this.app.messages.delete(id);
    this.app.messages.save();
    this.app.inspector.remove(id);
    this.app.titles.remove(profile, id);
    this.app.telemetry.remove(id);
    if (profile === 'default') {
      const legacy = this.app.store.read<Record<string, unknown>>('inspector-states.json', {});
      if (Object.hasOwn(legacy, id)) { delete legacy[id]; this.app.store.write('inspector-states.json', legacy); }
    }
    this.app.sessions.forgetSession(id);
    this.settings.layout = { ...this.settings.layout, ...withoutSession(this.settings.layout, id) };
    this.app.store.write('layout.json', this.settings.layout);
    await this.app.swarm.remove(id);
  }
  async discardNewBranch(id: string): Promise<void> {
    const journal = 'pending-session-deletes-' + this.app.accounts.activeProfileId + '.json';
    const pending = this.app.store.read<string[]>(journal, []);
    this.app.store.write(journal, [...new Set([...pending, id])]);
    this.app.trees.removeBranchOrTree(id);
    await this.closeSession(id);
    await this.finishDeletion(id);
    const remaining = this.app.store.read<string[]>(journal, []).filter(item => item !== id);
    this.app.store.write(journal, remaining);
  }
  private deleting?: Promise<void>;
  waitForDeletions(): Promise<void> | undefined { return this.deleting; }
  async completePendingDeletions(): Promise<void> {
    while (this.deleting) await this.deleting;
    const journal = 'pending-session-deletes-' + this.app.accounts.activeProfileId + '.json';
    const pending = this.app.store.read<string[]>(journal, []);
    if (!pending.length) return;
    const work = Promise.allSettled(pending.map(async id => {
      this.app.trees.removeBranchOrTree(id);
      await this.finishDeletion(id);
      const remaining = this.app.store.read<string[]>(journal, []).filter(item => item !== id);
      this.app.store.write(journal, remaining);
    })).then(results => {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    this.deleting = work;
    try { await work; } finally { if (this.deleting === work) this.deleting = undefined; }
  }
  async manageSession(id: string, action: SessionAction) {
    this.app.accounts.assertReady();
    if (!['archive', 'restore', 'delete'].includes(action)) throw new Error('未知会话操作');
    const journal = 'pending-session-deletes-' + this.app.accounts.activeProfileId + '.json';
    const pendingDelete = this.app.store.read<string[]>(journal, []).includes(id);
    if (pendingDelete && action !== 'delete') throw new Error('会话删除尚未完成');
    const rootId = this.app.trees.resolveRootId(id);
    const branchIds = [...new Set([id, ...this.app.trees.listBranchIds(rootId)])].filter(
      bid => pendingDelete || this.app.sessions.sessions.has(bid)
    );
    if (!pendingDelete && !this.app.sessions.sessions.has(id)) {
      this.app.sessions.get(id);
    }
    for (const bid of branchIds) {
      if (this.turns.isSessionTurnActive(bid) || this.app.isChangingSession(bid)) {
        throw new Error('请等待当前回合结束后再管理会话');
      }
    }
    for (const bid of branchIds) this.managing.add(bid);
    try {
      if (action !== 'restore') {
        for (const bid of branchIds) {
          if (this.app.sessions.isActive(bid)) await this.closeSession(bid);
        }
      }
      if (action === 'delete') {
        this.app.store.write(journal, [...new Set([...this.app.store.read<string[]>(journal, []), ...branchIds])]);
        await this.completePendingDeletions();
      } else {
        const archiveStamp = new Date().toISOString();
        for (const bid of branchIds) {
          if (action === 'archive') {
            this.settings.layout = { ...this.settings.layout, ...withoutSession(this.settings.layout, bid) };
          }
          const existing = this.app.sessions.sessions.get(bid);
          if (!existing) continue;
          const updated = { ...existing, archivedAt: action === 'archive' ? existing.archivedAt || archiveStamp : undefined };
          this.app.sessions.updateSessionRecord(updated);
          if (action === 'archive') this.app.retireSession(bid);
          this.app.emit('session-updated', this.enrichSession(updated));
        }
        if (action === 'archive') this.app.store.write('layout.json', this.settings.layout);
      }
      return { sessions: [...this.app.sessions.sessions.values()].map(s => this.enrichSession(s)), layout: structuredClone(this.settings.layout) };
    } finally {
      for (const bid of branchIds) this.managing.delete(bid);
    }
  }
  async setSessionMode(sessionId: string, mode: AgentExecutionMode) {
    this.app.accounts.assertReady();
    const updated = await this.app.sessions.setSessionMode(sessionId, mode);
    this.app.approval.setSessionExecutionMode(sessionId, updated.executionMode);
    return this.enrichSession(updated);
  }
  async setSessionEffort(sessionId: string, effort: AgentReasoningEffort) { this.app.accounts.assertReady(); return this.enrichSession(await this.app.sessions.setSessionEffort(sessionId, effort)); }
  async setSessionModel(sessionId: string, modelId: string) {
    this.app.accounts.assertReady();
    const session = await this.app.sessions.setSessionModel(sessionId, modelId);
    this.app.telemetry.ensure(sessionId, modelId);
    this.app.telemetry.clearSessionCheckpointLimit(sessionId, modelId);
    this.monitor.resetSession(sessionId);
    this.monitor.syncSessionCheckpointWindow(sessionId);
    return this.enrichSession(session);
  }
}
