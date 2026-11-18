import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AcpRequestPermissionParams, AcpSessionUpdateNotification, AcpPromptContentBlock, AgentExecutionMode, AgentReasoningEffort } from '../shared/acp-protocol';
import type { ApprovalDecisionSubmission, ApprovalMode, ApproveForMeConfig } from '../shared/approval-contract';
import type { AppBootstrapPayload, AcpConnectionStatus, CreateSessionInput, OpenLinkOrFileInput, OpenLinkOrFileResult, SendPromptInput } from '../shared/ipc-channels';
import { isForbiddenCredentialOrStatePath } from '../shared/accounts-history-contract';
import type { ChatMessageItem, ManagedSessionSummary, TitleOrganizeRequest, WorkspaceLayoutState } from '../shared/session-contract';
import { generateStructuredChineseTitle, isLegacyPollutionSessionTitle, isRightInspectorTab, normalizeWorkspacePath } from '../shared/session-contract';
import type { ClientPreferences, GravityIconId, WorkspaceProjectConfig } from '../shared/theme-i18n-contract';
import { THEME_PRESETS, GRAVITY_ICON_VARIANTS, validateCustomThemeConfig } from '../shared/theme-i18n-contract';
import type { ModelRateCard } from '../shared/telemetry-contract';
import type { CreateAccountProfileInput, ContinueHistoryInGravityInput } from '../shared/accounts-history-contract';
import type { PluginActionInput, McpActionInput } from '../shared/plugins-contract';
import { AcpClient, type AcpClientOptions } from './acp/acp-client';
import { ApprovalEngine, DEFAULT_APPROVAL_CONFIG, type ApprovalGuardActivityEvent } from './approval/approval-engine';
import type { Reviewer } from './approval/external-reviewer';
import { ClientStore } from './storage/client-store';
import { SessionMultiplexer } from './session/session-multiplexer';
import { TitleOrganizer } from './organizer/title-organizer';
import { estimateTokens, TelemetryStore } from './telemetry/telemetry-store';
import { readSessionCheckpointLimit } from './telemetry/checkpoint-limit-reader';
import { ThoughtTranslator } from './translation/thought-translator';
import { SwarmTracker } from './swarm/swarm-tracker';
import { readAccountQuota } from './accounts/account-quota';
import { AccountManager } from './accounts/account-manager';
import { HistoryImporter } from './history/history-importer';
import { PluginsManager, type CliExecutor } from './plugins/plugins-manager';
import { WorkspaceFiles } from './workspace/workspace-files';
import { InspectorStore } from './session/inspector-store';

import { prepareRevision, revisionContext } from '../shared/message-revision';
import type { ReviseMessageInput } from '../shared/ipc-channels';
import { withoutSession, type SessionAction } from '../shared/session-contract';
import { appendImage } from './session/message-images';
import { LocalTranslator } from './translation/local-translator';

export const DEFAULT_PREFERENCES: ClientPreferences = { locale: 'zh-CN', theme: 'claude-code-dark', appIcon: 'gravity-claude-dark', defaultThoughtTrack: 'zh', translationEngine: 'local', processPerSession: false, activeProfileId: 'default', defaultWorkspaceCwd: '', projects: [] };
export const DEFAULT_LAYOUT: WorkspaceLayoutState = { openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null, tertiarySessionId: null, quaternarySessionId: null, layoutMode: 'single', hideLegacyPollutionSessions: true, leftSidebarCollapsed: false, leftSidebarWidth: 260, rightInspectorCollapsed: false, rightInspectorWidth: 360, activeInspectorTab: 'context' };
export interface CoreServiceOptions { dataDir: string; acp?: AcpClient; acpOptions?: AcpClientOptions; reviewer?: Reviewer; translator?: ThoughtTranslator; historyRoots?: string[]; pluginsExecutor?: CliExecutor; homeDir?: string; setIcon?: (iconId: GravityIconId) => void | Promise<void>; openTargetHandler?: (resolvedTarget: string, mode: 'browser' | 'default-app' | 'reveal-in-folder' | 'copy', isDirectory?: boolean) => void | Promise<void>; selectDirectoryHandler?: (defaultPath?: string) => Promise<string | null> }
/** 主进程的业务入口。窗口请求进入此处，ACP 更新按会话分发给消息、审批、统计和检视器，再由事件通知渲染层。 */
export class CoreService extends EventEmitter {
  readonly store: ClientStore; readonly client: AcpClient; readonly sessions: SessionMultiplexer; readonly approval: ApprovalEngine;
  readonly telemetry: TelemetryStore; readonly titles: TitleOrganizer; readonly thoughts: ThoughtTranslator; readonly swarm: SwarmTracker;
  readonly accounts: AccountManager; readonly history: HistoryImporter; readonly plugins: PluginsManager;
  readonly inspector: InspectorStore; readonly workspaceFiles = new WorkspaceFiles();
  private preferences: ClientPreferences;
  private layout: WorkspaceLayoutState;
  private messages = new Map<string, ChatMessageItem[]>();
  private assistantMessages = new Map<string, ChatMessageItem>();
  private thoughtOwners = new Map<string, { sessionId: string; message: ChatMessageItem }>();
  private feedback = new Map<string, string[]>();
  private compactAvailable = new Set<string>();
  private reactiveTurnTimers = new Map<string, NodeJS.Timeout>();
  private reactiveWakeupActive = new Set<string>();
  private skipReplayedMessages = new Set<string>();
  private quotaRequests = new Map<string, ReturnType<typeof readAccountQuota>>();
  private managing = new Set<string>();
  private revising = new Set<string>();
  private localTranslator = new LocalTranslator();
  private guardActiveSessions = new Map<string, { count: number; modelLabel: string }>();
  private bootstrapping?: Promise<AppBootstrapPayload>;
  private telemetryPush?: NodeJS.Timeout;
  constructor(private options: CoreServiceOptions) {
    super(); this.store = new ClientStore(options.dataDir);
    this.preferences = { ...DEFAULT_PREFERENCES, ...this.store.read('preferences.json', {}) };
    if (this.preferences.translationEngine !== 'local') {
      this.preferences.translationEngine = 'local';
      this.store.write('preferences.json', this.preferences);
    }
    if (!THEME_PRESETS.some(theme => theme.id === this.preferences.theme) && !['custom', 'system'].includes(this.preferences.theme)) this.preferences.theme = DEFAULT_PREFERENCES.theme;
    if (!GRAVITY_ICON_VARIANTS.some(icon => icon.id === this.preferences.appIcon)) this.preferences.appIcon = DEFAULT_PREFERENCES.appIcon;
    if (this.preferences.customTheme) { try { this.preferences.customTheme = validateCustomThemeConfig(this.preferences.customTheme); } catch { delete this.preferences.customTheme; this.preferences.theme = DEFAULT_PREFERENCES.theme; } }
    this.layout = { ...DEFAULT_LAYOUT, ...this.store.read<Partial<WorkspaceLayoutState>>('layout.json', {}) };
    if (!isRightInspectorTab(this.layout.activeInspectorTab)) this.layout.activeInspectorTab = DEFAULT_LAYOUT.activeInspectorTab;
    this.client = options.acp || new AcpClient({ ...options.acpOptions, args: options.acpOptions?.args || ['acp', ...(this.preferences.processPerSession ? ['--process-per-session'] : [])] });
    this.sessions = new SessionMultiplexer(this.client, this.store);
    let config = this.store.read<ApproveForMeConfig>('approval-config.json', structuredClone(DEFAULT_APPROVAL_CONFIG));
    // 公开 API 密钥不落盘；重启后需要用户重新配置才可开启联网复核。
    if (config.externalReviewer?.provider !== 'local-ollama') config = { ...config, externalReviewer: { ...config.externalReviewer, enabled: false } };
    try { this.approval = new ApprovalEngine({ store: this.store, config, reviewer: options.reviewer }); }
    catch { this.approval = new ApprovalEngine({ store: this.store, reviewer: options.reviewer }); }
    this.telemetry = new TelemetryStore({ store: this.store });
    this.swarm = new SwarmTracker(this.store);
    this.inspector = new InspectorStore(this.store);
    this.titles = new TitleOrganizer(this.store);
    this.thoughts =
      options.translator ||
      new ThoughtTranslator(originalText => this.localTranslator.translate(originalText));
    // 默认与外部 Antigravity 历史完全隔离（roots=[]），仅在显式指定 historyRoots（如单测）时扫描
    this.history = new HistoryImporter({ roots: options.historyRoots ?? [], cacheDir: join(options.dataDir, 'history-cache') });
    this.plugins = new PluginsManager({ store: this.store, binaryPath: options.acpOptions?.binaryPath, executor: options.pluginsExecutor, homeDir: options.homeDir });
    // 切换账号要跨越两套会话状态。旧消息在切换前保存，新账号的消息在窗格和内存索引清空后载入。
    this.accounts = new AccountManager({ store: this.store, client: this.client, sessions: this.sessions,
      beforeSwitch: async () => { if (this.managing.size) throw new Error('正在保存会话变更'); this.approval.dispose(); this.feedback.clear(); this.saveMessages(); },
      afterSwitch: profileId => {
        this.thoughts.dispose();
        for (const id of this.reactiveTurnTimers.keys()) this.clearReactiveTurnTimer(id);
        this.guardActiveSessions.clear();
        for (const id of this.messages.keys()) this.telemetry.remove(id);
        this.assistantMessages.clear(); this.thoughtOwners.clear(); this.compactAvailable.clear(); this.messages.clear();
        this.preferences.activeProfileId = profileId; this.store.write('preferences.json', this.preferences);
        this.layout = { ...this.layout, openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null, tertiarySessionId: null, quaternarySessionId: null };
        this.store.write('layout.json', this.layout); this.loadProfileData();
      },
    });
    this.preferences.activeProfileId = this.accounts.activeProfileId; this.loadProfileData();
    this.accounts.on('updated', state => this.emit('account-updated', state));
    this.history.on('updated', records => this.emit('history-updated', records));
    this.inspector.on('updated', data => this.emit('inspector-updated', data));
    // 权限请求由代理反向发起。先确认会话仍激活，再把请求交给审批引擎等待决定。
    this.client.registerRequestHandler('session/request_permission', (raw) => {
      const params = raw as AcpRequestPermissionParams;
      if (!params?.sessionId || !this.sessions.isActive(params.sessionId)) return { outcome: { outcome: 'cancelled' } };
      return this.approval.requestPermission(params, this.sessions.get(params.sessionId).cwd);
    });
    this.client.on('disconnected', () => { this.approval.dispose(); });
    this.client.on('rateLimited', (warning: string) => {
      for (const session of this.sessions.sessions.values()) if (this.sessions.isActive(session.sessionId)) this.upsert({ id: randomUUID(), sessionId: session.sessionId, role: 'system', content: warning, createdAt: new Date().toISOString() });
    });
    this.sessions.on('session', (session: ManagedSessionSummary) => this.emit('session-updated', this.titles.apply(session)));
    this.sessions.on('update', (payload: AcpSessionUpdateNotification) => this.consumeUpdate(payload));
    this.sessions.on('localPreference', ({ sessionId, text }) => this.upsert({ id: randomUUID(), sessionId, role: 'system', content: text, createdAt: new Date().toISOString() }));
    this.sessions.on('cancelled', (id: string) => { this.approval.cancelSession(id); this.feedback.delete(id); });
    this.sessions.on('closed', (id: string) => { this.approval.cancelSession(id); this.telemetry.cancelTurn(id); });
    this.approval.on('requested', request => { this.sessions.setStatus(request.sessionId, 'waiting_approval'); this.emit('approval-requested', request); });
    this.approval.on('resolved', payload => {
      if (!this.approval.listPending().some(item => item.sessionId === payload.sessionId)) this.sessions.setStatus(payload.sessionId, this.sessions.isBusy(payload.sessionId) ? 'streaming' : 'idle');
      this.emit('approval-resolved', payload);
    });
    this.approval.on('feedback', ({ sessionId, text }) => {
      const list = this.feedback.get(sessionId) || []; list.push(text); this.feedback.set(sessionId, list);
      this.upsert({ id: randomUUID(), sessionId, role: 'system', content: `已拒绝操作。反馈将在当前执行结束后发送给智能体：${text}`, createdAt: new Date().toISOString() });
    });
    this.approval.on('config-updated', (cfg: ApproveForMeConfig) => {
      const persisted = structuredClone(cfg);
      delete persisted.externalReviewer.apiKey;
      this.store.write('approval-config.json', persisted);
    });
    this.approval.on('guard-activity', (ev: ApprovalGuardActivityEvent) => {
      this.guardActiveSessions.set(ev.sessionId, { count: ev.autoApprovedCount, modelLabel: ev.modelLabel });
      this.swarm.ingest(ev.sessionId, 'invoke_subagent', {
        name: 'approval-guard',
        role: 'Approve for me 安全代审守卫',
        model: ev.modelLabel,
        brief: '多命令密集运行实时审查（本地多段 AST 语义快筛 / 独立模型复核，零订阅额度消耗）',
        status: 'working',
      });
    });
    this.thoughts.on('block', block => {
      const owner = this.thoughtOwners.get(block.id); if (!owner) return;
      owner.message.thoughts = [block]; this.upsert(owner.message);
      if (!owner.message.isStreaming && !block.isStreaming && !block.isTranslating) {
        if (this.assistantMessages.get(owner.sessionId) !== owner.message) this.saveMessages();
        this.thoughtOwners.delete(block.id);
        this.thoughts.clear(block.id);
      }
    });
    // Token 事件可很密集：跨进程看板最多每 100ms 推送一次，主回复流不节流。
    this.telemetry.on('updated', () => {
      if (!this.telemetryPush) { this.telemetryPush = setTimeout(() => { this.telemetryPush = undefined; this.emit('telemetry-updated', this.telemetry.snapshot()); }, 100); this.telemetryPush.unref(); }
    });
    this.swarm.on('updated', state => this.emit('swarm-updated', state));
  }
  private messagesFile(): string { return `messages-${this.accounts.activeProfileId}.json`; }
  private loadProfileData(): void {
    this.loadMessages();
    const profileId = this.accounts.activeProfileId;
    const owned = new Set(this.sessions.sessions.keys());
    this.inspector.setProfile(profileId, owned);
    this.swarm.setProfile(profileId, owned);
    const pending = this.store.read<string[]>('pending-session-deletes-' + profileId + '.json', []);
    for (const id of pending) this.finishDeletion(id);
  }
  getPreferences(): ClientPreferences { return structuredClone(this.preferences); }
  private saveMessages(): void { this.store.write(this.messagesFile(), Object.fromEntries(this.messages)); }
  /**
   * 恢复每个会话最近 500 条消息，并重置流式标记。
   * 默认 Profile 可读取旧版消息文件，缺少归属清单时以本地消息补建。
   */
  private loadMessages(): void {
    const saved = this.store.read<Record<string, ChatMessageItem[]>>(this.messagesFile(), this.accounts.activeProfileId === 'default' ? this.store.read('messages.json', {}) : {});
    const seedEntries: Array<{ sessionId: string; title: string; cwd: string; updatedAt: string }> = [];
    const hasLedger = this.sessions.hasPersistedLedger();
    for (const [id, items] of Object.entries(saved || {})) {
      if (!Array.isArray(items) || (hasLedger && !this.sessions.sessions.has(id))) continue;
      const normalizedItems = items.slice(-500).filter(item => item && typeof item.id === 'string').map(item => ({
        ...item, isStreaming: false,
        thoughts: item.thoughts?.map(block => ({ ...block, isStreaming: false, isTranslating: false })),
      }));
      this.messages.set(id, normalizedItems);
      const firstUser = normalizedItems.find(m => m.role === 'user')?.content || '';
      if (normalizedItems.length > 0 && !isLegacyPollutionSessionTitle(firstUser)) {
        const gen = generateStructuredChineseTitle(firstUser);
        seedEntries.push({
          sessionId: id,
          title: gen.organizedTitle,
          cwd: this.options.homeDir || homedir(),
          updatedAt: normalizedItems.at(-1)?.createdAt || new Date().toISOString(),
        });
      }
    }
    // 已有归属清单时以清单为准，避免根据遗留消息重新加入先前移出的会话。
    if (!this.sessions.hasPersistedLedger()) {
      this.sessions.seedOwnedFromLocalMessages(seedEntries);
    }
  }
  private upsert(message: ChatMessageItem): void {
    const items = this.messages.get(message.sessionId) || []; const index = items.findIndex(item => item.id === message.id);
    if (index >= 0) items[index] = message; else items.push(message);
    this.messages.set(message.sessionId, items.slice(-500)); this.emit('message-upserted', { sessionId: message.sessionId, message: structuredClone(message) });
  }
  private assistant(sessionId: string): ChatMessageItem {
    let message = this.assistantMessages.get(sessionId);
    if (!message) { message = { id: randomUUID(), sessionId, role: 'assistant', content: '', isStreaming: true, createdAt: new Date().toISOString() }; this.assistantMessages.set(sessionId, message); }
    return message;
  }
  /** 按 ACP 更新类型合并增量。回复正文、思考、工具状态和用量共享 sessionId，各自维护自己的累计方式。 */
  private consumeUpdate({ sessionId, update }: AcpSessionUpdateNotification): void {
    const replaying = this.sessions.isResuming(sessionId);
    if (replaying && this.skipReplayedMessages.has(sessionId) &&
        !['available_commands_update', 'current_mode_update', 'config_option_update'].includes(update.sessionUpdate)) return;
    if (update.sessionUpdate === 'plan') {
      this.inspector.consume(sessionId, update);
      const todos = this.inspector.get(sessionId).todos;
      if (todos.length >= 2) this.approval.enableBurstGuard(sessionId);
      const message = this.assistant(sessionId);
      message.todos = todos;
      this.upsert(message);
    }
    if (update.sessionUpdate === 'current_mode_update' && ['default', 'accept-edits', 'plan', 'auto'].includes(update.currentModeId || '')) {
      const nextMode = update.currentModeId as AgentExecutionMode;
      this.sessions.get(sessionId).executionMode = nextMode;
      this.approval.setSessionExecutionMode(sessionId, nextMode);
      this.sessions.setStatus(sessionId, this.sessions.get(sessionId).status);
    }
    const text = update.content?.text || '';
    if (update.sessionUpdate === 'available_commands_update') {
      const commands = (update as unknown as { availableCommands?: Array<{ name: string }> }).availableCommands;
      if (commands?.some(command => command.name === 'compact')) this.compactAvailable.add(sessionId);
    }
    if (update.sessionUpdate === 'usage_update') {
      if (typeof update.used === 'number' || typeof update.size === 'number') {
        this.telemetry.applyContextWindow(sessionId, update.used, update.size);
      }
      if (update.usage) this.telemetry.applyUsage(sessionId, update.usage);
      if (this.reactiveWakeupActive.has(sessionId)) {
        this.scheduleReactiveTurnSettle(sessionId, true);
      }
    }
    // 后台子个体完成触发的服务端主动唤醒回合（!isBusy）：同步归档子个体状态并在输出收敛后自动收口流式光标
    const isReactiveAgentUpdate =
      !replaying && !this.sessions.isBusy(sessionId) &&
      ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate);
    if (isReactiveAgentUpdate && !this.reactiveWakeupActive.has(sessionId)) {
      this.reactiveWakeupActive.add(sessionId);
      if (this.sessions.isActive(sessionId)) {
        this.sessions.setStatus(sessionId, 'streaming');
      }
      this.swarm.markWorkingSubagentsCompleted(sessionId);
    }

    if (update.sessionUpdate === 'user_message_chunk') {
      if (replaying) this.finishAssistantMessage(sessionId);
      const items = this.messages.get(sessionId) || []; const previous = items.at(-1);
      const message: ChatMessageItem = previous?.role === 'user' && previous.isStreaming ? previous : { id: randomUUID(), sessionId, role: 'user', content: '', isStreaming: true, createdAt: new Date().toISOString() };
      appendImage(message, update.content);
      message.content += text; this.upsert(message); return;
    }
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const message = this.assistant(sessionId);
      if (update.sessionUpdate === 'agent_message_chunk') {
        this.completeStreamingThoughts(message);
        appendImage(message, update.content);
        message.content += text;
        this.telemetry.addChunk(sessionId, text);
      } else {
        const id = `${message.id}:thought`;
        this.thoughtOwners.set(id, { sessionId, message });
        const prev = message.thoughts?.[0];
        const prefix = prev && !prev.isStreaming && prev.originalText && !prev.originalText.endsWith('\n') && !text.startsWith('\n') ? '\n\n' : '';
        message.thoughts = [this.thoughts.append(id, prefix + text)];
        this.telemetry.addChunk(sessionId, text, 'thoughtTokens');
      }
      this.upsert(message);
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.swarm.consume(sessionId, update); if (!update.toolCallId) return;
      const message = this.assistant(sessionId);
      this.completeStreamingThoughts(message);
      // 工具创建和后续状态通知共用 toolCallId。传入旧卡片以保留增量更新里省略的字段。
      const cards = message.toolCalls ||= [];
      const index = cards.findIndex(card => card.toolCallId === update.toolCallId);
      const toolResults = Array.isArray(update.content) ? update.content : update.toolContent || [];
      for (const result of toolResults) appendImage(message, result);
      const card = this.inspector.consume(sessionId, update, index >= 0 ? cards[index] : undefined);
      if (card) { if (index >= 0) cards[index] = card; else cards.push(card); }
      this.telemetry.addChunk(sessionId, JSON.stringify(update), 'toolCallsTokens'); this.upsert(message);
    }
    if (isReactiveAgentUpdate) {
      this.scheduleReactiveTurnSettle(sessionId, false);
    }
  }
  private clearReactiveTurnTimer(sessionId: string): void {
    const timer = this.reactiveTurnTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reactiveTurnTimers.delete(sessionId);
    }
    this.reactiveWakeupActive.delete(sessionId);
  }
  /**
   * 服务端主动唤醒产生的回复没有本地 prompt 等待点，通过静默计时收尾。
   * 审批挂起时暂停收尾，计时到期再检查工具状态。
   */
  private scheduleReactiveTurnSettle(sessionId: string, usageArrived: boolean): void {
    const prev = this.reactiveTurnTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const activeMsg = this.assistantMessages.get(sessionId);
    const hasPendingTool = Boolean(
      activeMsg?.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')
    );
    const hasPendingApproval = this.approval.listPending().some((item) => item.sessionId === sessionId);
    if (hasPendingApproval) {
      this.reactiveTurnTimers.delete(sessionId);
      return;
    }
    const delayMs = hasPendingTool
      ? 8000
      : usageArrived && activeMsg?.content?.trim()
        ? 380
        : activeMsg?.content?.trim()
          ? 950
          : 2600;
    const timer = setTimeout(() => {
      this.reactiveTurnTimers.delete(sessionId);
      if (this.sessions.isBusy(sessionId)) return;
      const currentMsg = this.assistantMessages.get(sessionId);
      const stillRunningTool = Boolean(
        currentMsg?.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')
      );
      if (stillRunningTool || this.approval.listPending().some((item) => item.sessionId === sessionId)) {
        this.scheduleReactiveTurnSettle(sessionId, false);
        return;
      }
      this.reactiveWakeupActive.delete(sessionId);
      this.finishMessage(sessionId);
      if (this.sessions.isActive(sessionId) && this.sessions.get(sessionId).status === 'streaming') {
        this.sessions.setStatus(sessionId, 'idle');
      }
      this.syncSessionCheckpointWindow(sessionId);
    }, delayMs);
    timer.unref?.();
    this.reactiveTurnTimers.set(sessionId, timer);
  }
  private completeStreamingThoughts(message: ChatMessageItem): void {
    if (!message.thoughts?.length) return;
    message.thoughts = message.thoughts.map(block => (block.isStreaming ? this.thoughts.complete(block.id) || block : block));
  }
  private finishAssistantMessage(sessionId: string): void {
    const message = this.assistantMessages.get(sessionId);
    if (message) { message.isStreaming = false; if (!message.completedAt) message.completedAt = new Date().toISOString(); for (const block of message.thoughts || []) this.thoughts.complete(block.id); this.upsert(message); }
    this.assistantMessages.delete(sessionId);
  }
  private finishMessage(sessionId: string): void {
    this.finishAssistantMessage(sessionId);
    const guardInfo = this.guardActiveSessions.get(sessionId);
    if (guardInfo) {
      this.guardActiveSessions.delete(sessionId);
      this.swarm.ingest(sessionId, 'post_message', {
        sender: 'approval-guard',
        channel: 'approval',
        content: `[done] 本轮已实时审查并自动放行 ${guardInfo.count} 项低风险操作（${guardInfo.modelLabel}）`,
      });
    }
    this.approval.resetTurnBurstCounter(sessionId);
    for (const item of this.messages.get(sessionId) || []) item.isStreaming = false;
    this.saveMessages();
  }
  /** 并发打开工作台时共用一次快照。连接失败仍返回本地会话记录，客户端可据此显示离线历史。 */
  async getBootstrap(): Promise<AppBootstrapPayload> {
    if (this.bootstrapping) return this.bootstrapping;
    this.bootstrapping = (async () => {
      let sessions: ManagedSessionSummary[] = [];
      try {
        sessions = await this.listSessions(true);
      } catch (error) {
        this.client.lastError = error instanceof Error ? error.message : 'ACP 连接失败';
        sessions = [...this.sessions.sessions.values()].map(item => this.titles.apply({ ...item }));
      }
      for (const s of sessions) {
        this.telemetry.hydrateFromMessages(s.sessionId, s.modelId, this.messages.get(s.sessionId) || []);
      }
      const importedHistory = await this.history.refresh();
      if (this.history.roots.length > 0) this.history.startWatching();
      return { preferences: { ...this.preferences }, connection: await this.getConnectionStatus(), accounts: this.accounts.getState(), importedHistory, plugins: this.plugins.getCachedSnapshot(), approvalConfig: this.approval.getConfig(), sessions, layout: structuredClone(this.layout), pendingApprovals: this.approval.listPending(), telemetry: this.telemetry.snapshot() };
    })();
    try { return await this.bootstrapping; } finally { this.bootstrapping = undefined; }
  }
  async getAccountQuota() {
    this.accounts.assertReady();
    const state = this.accounts.getState();
    const profile = state.profiles.find(p => p.profileId === state.activeProfileId)!;
    let query = this.quotaRequests.get(profile.profileId);
    if (!query) {
      query = readAccountQuota(profile, this.client.options.binaryPath).finally(() => this.quotaRequests.delete(profile.profileId));
      this.quotaRequests.set(profile.profileId, query);
    }
    return query;
  }
  async getConnectionStatus(): Promise<AcpConnectionStatus> { return { connected: this.client.connected, agyBinaryPath: this.client.binaryPath, agyVersion: this.client.initializeResult?.agentInfo?.version || '', agentServerVersion: this.client.initializeResult?.agentInfo?.version, activeSessionCount: this.sessions.activeSessionCount, maxParallelSessions: 4, activeProfileId: this.accounts.activeProfileId, availableModels: this.sessions.availableModels(), lastError: this.client.lastError }; }
  async updatePreferences(patch: Partial<ClientPreferences>): Promise<ClientPreferences> {
    const next = { ...this.preferences, ...patch };
    next.translationEngine = 'local';
    if (!['zh-CN', 'en-US'].includes(next.locale) || !['zh', 'raw'].includes(next.defaultThoughtTrack) || !(['system', 'custom'].includes(next.theme) || THEME_PRESETS.some(theme => theme.id === next.theme)) || typeof next.processPerSession !== 'boolean' || !GRAVITY_ICON_VARIANTS.some(icon => icon.id === next.appIcon)) throw new Error('偏好设置格式无效');
    // Profile 切换还涉及关闭旧连接和加载新的消息索引，必须走账号管理器的完整切换流程。
    if (next.activeProfileId !== this.accounts.activeProfileId) throw new Error('切换 Profile 必须使用专用账号切换入口');
    if (next.customTheme) next.customTheme = validateCustomThemeConfig(next.customTheme);
    if (next.theme === 'custom' && !next.customTheme) throw new Error('请先导入或创建自定义主题');
    if (next.defaultWorkspaceCwd !== undefined) {
      if (typeof next.defaultWorkspaceCwd !== 'string' || next.defaultWorkspaceCwd.length > 1024 || next.defaultWorkspaceCwd.includes('\0')) {
        throw new Error('默认文件夹路径无效');
      }
      next.defaultWorkspaceCwd = next.defaultWorkspaceCwd.trim() ? normalizeWorkspacePath(next.defaultWorkspaceCwd.trim()) : '';
    }
    if (next.projects !== undefined) {
      if (!Array.isArray(next.projects) || next.projects.length > 60) {
        throw new Error('自定义项目数量无效');
      }
      // 先重建并校验项目清单，再整体保存偏好。相同目录只保留第一项，比较使用规范化的小写路径。
      const normalizedProjects: WorkspaceProjectConfig[] = [];
      const seenPaths = new Set<string>();
      for (const rawProj of next.projects) {
        if (!rawProj || typeof rawProj !== 'object') throw new Error('项目配置格式无效');
        const cleanPath = normalizeWorkspacePath(String(rawProj.path || '').trim());
        const cleanName = String(rawProj.name || '').trim().slice(0, 80);
        if (!cleanPath || !isAbsolute(cleanPath) || !cleanName) {
          throw new Error('项目名称不能为空且路径必须为绝对路径');
        }
        const pathKey = cleanPath.toLowerCase();
        if (seenPaths.has(pathKey)) continue;
        seenPaths.add(pathKey);
        normalizedProjects.push({
          id: String(rawProj.id || randomUUID()).slice(0, 64),
          name: cleanName,
          path: cleanPath,
          description: rawProj.description ? String(rawProj.description).trim().slice(0, 240) : undefined,
          defaultMode:
            rawProj.defaultMode && ['default', 'accept-edits', 'plan', 'auto'].includes(rawProj.defaultMode)
              ? rawProj.defaultMode
              : undefined,
          defaultModelId: rawProj.defaultModelId ? String(rawProj.defaultModelId).trim().slice(0, 120) : undefined,
          pinned: Boolean(rawProj.pinned),
        });
      }
      next.projects = normalizedProjects;
    }
    if (this.client.connected && next.processPerSession !== this.preferences.processPerSession) throw new Error('请重启客户端后修改进程隔离设置');
    if (next.appIcon !== this.preferences.appIcon) await this.options.setIcon?.(next.appIcon);
    this.preferences = next; this.store.write('preferences.json', next);
    if (!this.client.connected) { this.client.options.args = ['acp', ...(next.processPerSession ? ['--process-per-session'] : [])]; this.accounts.applyArgs(); }
    return structuredClone(next);
  }
  async selectDirectory(defaultPath?: string): Promise<string | null> {
    if (defaultPath !== undefined && (typeof defaultPath !== 'string' || defaultPath.length > 1024)) {
      throw new Error('无效的默认目录参数');
    }
    const picked = await this.options.selectDirectoryHandler?.(defaultPath?.trim() || this.preferences.defaultWorkspaceCwd || undefined);
    return picked ? normalizeWorkspacePath(picked) : null;
  }
  async launchOfficialLogin(profileId?: string) { return this.accounts.login(profileId); }
  async listSessions(includeHiddenPollution = false) { this.accounts.assertReady(); return (await this.sessions.listSessions(includeHiddenPollution)).map(item => this.titles.apply(item)); }
  private hasAntigravityOptions(sessionId?: string): boolean {
    const agentName = this.client.initializeResult?.agentInfo?.name || '';
    return agentName.toLowerCase().includes('antigravity') || Boolean(sessionId && this.sessions.hasConfigOptions(sessionId));
  }
  /** 在后台读取当前 Profile 里该会话的压缩阈值，成功后再更新看板。缺失读数时继续使用已有窗口估计。 */
  private syncSessionCheckpointWindow(sessionId: string): void {
    if (!this.hasAntigravityOptions(sessionId)) return;
    const activeProfile = this.accounts
      .getState()
      .profiles.find((p) => p.profileId === this.accounts.activeProfileId);
    void readSessionCheckpointLimit({
      sessionId,
      cacheDir: join(this.options.dataDir, 'checkpoint-cache'),
      isolatedAppDataDir: activeProfile?.isDefault ? undefined : activeProfile?.isolatedAppDataDir,
      homeDir: this.options.homeDir,
    })
      .then((limit) => {
        if (limit) this.telemetry.setCheckpointWindowLimit(sessionId, limit);
      })
      .catch(() => {});
  }
  async createSession(input: CreateSessionInput) {
    this.accounts.assertReady();
    if (input.executionMode && !['default', 'accept-edits', 'plan', 'auto'].includes(input.executionMode) || input.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoningEffort)) throw new Error('会话 Mode 或 Effort 无效');
    let session = await this.sessions.createSession(input);
    try {
      if (input.modelId && input.modelId !== session.modelId) session = await this.sessions.setSessionModel(session.sessionId, input.modelId);
      if (input.executionMode && input.executionMode !== session.executionMode) session = await this.sessions.setSessionMode(session.sessionId, input.executionMode);
      if (input.reasoningEffort && (input.reasoningEffort !== session.reasoningEffort ||
          session.availableEfforts?.every(level => level.value !== input.reasoningEffort))) session = await this.sessions.setSessionEffort(session.sessionId, input.reasoningEffort);
    // 初始模式、推理强度或模型设置失败时尝试关闭刚创建的会话，避免半配置的会话继续占用活动名额。
    } catch (error) { await this.sessions.closeSession(session.sessionId).catch(() => {}); throw error; }
    this.approval.setSessionExecutionMode(session.sessionId, session.executionMode);
    this.telemetry.hydrateFromMessages(session.sessionId, session.modelId, this.messages.get(session.sessionId) || []);
    this.syncSessionCheckpointWindow(session.sessionId);
    return this.titles.apply(session);
  }
  async resumeSession(sessionId: string, cwd: string) {
    this.accounts.assertReady();
    if (this.managing.has(sessionId) || this.sessions.get(sessionId).archivedAt) throw new Error('请先从归档恢复会话');
    if (this.sessions.isActive(sessionId)) return this.titles.apply(this.sessions.get(sessionId));
    if (this.sessions.isResuming(sessionId)) throw new Error('此会话正在恢复');
    const hadLocalMessages = Boolean(this.messages.get(sessionId)?.length);
    if (hadLocalMessages) this.skipReplayedMessages.add(sessionId);
    let session: ManagedSessionSummary;
    try {
      session = await this.sessions.resumeSession(sessionId, cwd);
    } catch (error) {
      if (!hadLocalMessages) {
        this.messages.delete(sessionId);
        this.assistantMessages.delete(sessionId);
        for (const [id, owner] of this.thoughtOwners) if (owner.sessionId === sessionId) {
          this.thoughts.clear(id);
          this.thoughtOwners.delete(id);
        }
      }
      const localExisting = this.sessions.sessions.get(sessionId);
      // 已保存的对话可以离线阅读。只在恢复成功后重新启用输入和编辑。
      if (localExisting && hadLocalMessages && (!this.client.connected || this.hasAntigravityOptions())) {
        session = { ...localExisting, readOnly: true, status: 'closed' };
      } else {
        throw error;
      }
    } finally { this.skipReplayedMessages.delete(sessionId); }
    this.approval.setSessionExecutionMode(session.sessionId, session.executionMode);
    this.telemetry.hydrateFromMessages(sessionId, session.modelId, this.messages.get(sessionId) || []);
    this.syncSessionCheckpointWindow(sessionId);
    this.finishMessage(sessionId);
    return this.titles.apply(session);
  }
  async closeSession(sessionId: string): Promise<void> { this.clearReactiveTurnTimer(sessionId); this.swarm.markWorkingSubagentsCompleted(sessionId, '会话已关闭'); this.approval.cancelSession(sessionId); await this.sessions.closeSession(sessionId); this.finishMessage(sessionId); }
  private finishDeletion(id: string): void {
    const profile = this.accounts.activeProfileId;
    for (const [key, owner] of this.thoughtOwners) if (owner.sessionId === id) {
      this.thoughtOwners.delete(key);
      this.thoughts.clear(key);
    }
    this.clearReactiveTurnTimer(id);
    this.feedback.delete(id); this.compactAvailable.delete(id); this.guardActiveSessions.delete(id);
    this.assistantMessages.delete(id);
    this.messages.delete(id);
    this.saveMessages();
    this.inspector.remove(id);
    this.swarm.remove(id);
    this.titles.remove(profile, id);
    this.telemetry.remove(id);
    if (profile === 'default') {
      for (const file of ['messages.json', 'inspector-states.json', 'swarm-states.json']) {
        const legacy = this.store.read<Record<string, unknown>>(file, {});
        if (Object.hasOwn(legacy, id)) { delete legacy[id]; this.store.write(file, legacy); }
      }
    }
    this.sessions.forgetSession(id);
    this.layout = withoutSession(this.layout, id);
    this.store.write('layout.json', this.layout);
    const journal = 'pending-session-deletes-' + profile + '.json';
    this.store.write(journal, this.store.read<string[]>(journal, []).filter(item => item !== id));
  }
  async manageSession(id: string, action: SessionAction) {
    this.accounts.assertReady();
    if (!['archive', 'restore', 'delete'].includes(action)) throw new Error('未知会话操作');
    const journal = 'pending-session-deletes-' + this.accounts.activeProfileId + '.json';
    const pendingDelete = this.store.read<string[]>(journal, []).includes(id);
    if (pendingDelete && action !== 'delete') throw new Error('会话删除尚未完成');
    const session = pendingDelete ? this.sessions.sessions.get(id) : this.sessions.get(id);
    if (this.sessions.isBusy(id) || this.sessions.isResuming(id) || this.revising.has(id) || this.managing.has(id) ||
        session?.status === 'waiting_approval' || session?.status === 'streaming') throw new Error('请等待当前回合结束后再管理会话');
    this.managing.add(id);
    try {
      if (action !== 'restore' && this.sessions.isActive(id)) await this.closeSession(id);
      if (action === 'delete') {
        this.store.write(journal, [...new Set([...this.store.read<string[]>(journal, []), id])]);
        this.finishDeletion(id);
      } else {
        if (action === 'archive') {
          this.layout = withoutSession(this.layout, id);
          this.store.write('layout.json', this.layout);
        }
        const updated = { ...this.sessions.get(id), archivedAt: action === 'archive' ? session?.archivedAt || new Date().toISOString() : undefined };
        this.sessions.updateSessionRecord(updated);
        this.emit('session-updated', this.titles.apply(updated));
      }
      return { sessions: [...this.sessions.sessions.values()].map(s => this.titles.apply(s)), layout: structuredClone(this.layout) };
    } finally { this.managing.delete(id); }
  }
  async getSessionMessages(sessionId: string): Promise<ChatMessageItem[]> { return structuredClone(this.messages.get(sessionId) || []); }
  private userMessage(input: SendPromptInput): ChatMessageItem {
    return {
      id: randomUUID(), sessionId: input.sessionId, role: 'user', content: input.text,
      references: input.references, createdAt: new Date().toISOString(),
      attachments: (input.attachments || []).map(item => ({
        id: randomUUID(), name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, uri: item.uri,
        textContent: item.textContent, dataBase64: item.mimeType.startsWith('image/') ? undefined : item.dataBase64,
        dataUrl: item.dataBase64 && item.mimeType.startsWith('image/') ? 'data:' + item.mimeType + ';base64,' + item.dataBase64 : undefined,
      })),
    };
  }
  async reviseMessage(input: ReviseMessageInput): Promise<ManagedSessionSummary> {
    this.accounts.assertReady();
    const origin = this.sessions.get(input.sessionId);
    const profile = this.accounts.activeProfileId;
    if (origin.profileId !== profile || origin.readOnly || !this.sessions.isActive(origin.sessionId) ||
        this.sessions.isBusy(origin.sessionId) || this.revising.has(origin.sessionId) || this.managing.has(origin.sessionId)) {
      throw new Error('请等当前回合结束后再编辑');
    }
    const { prefix, references, attachments } = prepareRevision(this.messages.get(origin.sessionId) || [], input);
    let branch: ManagedSessionSummary | undefined;
    this.revising.add(origin.sessionId);
    try {
      // The edited branch replaces this live tab. Release the official worker first and restore it on failure.
      await this.closeSession(origin.sessionId);
      this.accounts.assertReady();
      if (profile !== this.accounts.activeProfileId) throw new Error('账号资料已切换');
      branch = await this.createSession({ cwd: origin.cwd, title: origin.title + ' · ' + (this.preferences.locale === 'en-US' ? 'Revision' : '修订'),
        executionMode: origin.executionMode, reasoningEffort: origin.availableEfforts?.length === 0 ? undefined : origin.reasoningEffort,
        modelId: origin.modelId || undefined });
      const id = branch.sessionId;
      if (profile !== this.accounts.activeProfileId) throw new Error('账号资料已切换');
      const history = prefix.map(m => {
        const copy = structuredClone(m);
        copy.id = randomUUID(); copy.sessionId = id; copy.revisionHistory = true; copy.isStreaming = false;
        delete copy.pendingApprovalId;
        for (const thought of copy.thoughts || []) { thought.id = randomUUID(); thought.isStreaming = false; thought.isTranslating = false; }
        return copy;
      });
      this.messages.set(id, [...history, ...(this.messages.get(id) || [])]);
      this.saveMessages();
      const revision = { sessionId: id, text: input.text, references, attachments };
      void this.sendPrompt(revision).catch(error => {
        if (this.accounts.activeProfileId !== profile || !this.sessions.sessions.has(id)) return;
        if (!(this.messages.get(id) || []).some(m => m.role === 'user' && !m.revisionHistory)) {
          this.upsert({ ...this.userMessage(revision), sendFailed: true });
        }
        this.upsert({ id: randomUUID(), sessionId: id, role: 'system', createdAt: new Date().toISOString(),
          content: '修订消息发送失败。' + (error instanceof Error ? error.message : String(error)) });
        this.saveMessages();
      });
      return branch;
    } catch (error) {
      if (profile === this.accounts.activeProfileId) {
        if (branch) await this.closeSession(branch.sessionId).catch(() => {});
        if (!this.sessions.isActive(origin.sessionId)) await this.resumeSession(origin.sessionId, origin.cwd).catch(() => {});
      }
      throw error;
    } finally { this.revising.delete(origin.sessionId); }
  }
  async sendPrompt(input: SendPromptInput): Promise<void> {
    this.accounts.assertReady();
    if (this.revising.has(input.sessionId) || this.managing.has(input.sessionId)) throw new Error('该会话正在创建修订分支');
    if (typeof input?.text !== 'string' || input.text.length > 1000000 || (!input.text.trim() && !input.attachments?.length)) throw new Error('请输入有效的提示词');
    if (!this.sessions.isActive(input.sessionId) || this.sessions.isBusy(input.sessionId)) throw new Error('会话未激活或仍在生成');
    const profileId = this.accounts.activeProfileId; const session = this.sessions.get(input.sessionId);
    this.approval.setSessionExecutionMode(input.sessionId, session.executionMode);
    const isManualCompact = input.text.trim() === '/compact';
    const prompt: AcpPromptContentBlock[] = [...revisionContext(this.messages.get(input.sessionId) || []), { type: 'text', text: input.text }];
    // 旧会话缺少原生配置能力时，用额外提示文本传递模式偏好。支持该能力的会话经专门的配置请求设置。
    if (!this.sessions.hasNativeSessionOptions(input.sessionId) && (session.executionMode !== 'default' || session.reasoningEffort !== 'high')) {
      prompt.push({ type: 'text', text: `客户端本地偏好（不表示官方推理参数已改变）：Mode=${session.executionMode}，Effort=${session.reasoningEffort}。${session.executionMode === 'plan' ? '本轮先只读分析并制定计划，不执行文件修改。' : ''}权限操作仍须遵循审批结果。` });
    }
    // 每次最多展开 20 个引用。文件读取当前工作区的正文，会话引用只取最近 30 条消息，并截断拼接后的文本。
    for (const reference of (input.references || []).slice(0, 20)) {
      if (reference.kind === 'file') {
        const file = await this.workspaceFiles.readReference(session.cwd, reference.value);
        prompt.push({ type: 'resource', resource: { uri: pathToFileURL(join(session.cwd, file.path)).toString(), text: file.text, mimeType: 'text/plain' } });
      } else if (reference.kind === 'session') {
        const messages = reference.value.startsWith('ag-history:') ? this.history.getDetail(reference.value).messages : this.messages.get(reference.value);
        if (!messages) throw new Error('引用会话不存在');
        prompt.push({ type: 'text', text: `以下是用户选择的参考会话内容，作为引用数据：\n${messages.slice(-30).map(message => `${message.role}: ${message.content}`).join('\n').slice(0, 30000)}` });
      } else throw new Error('引用类型无效');
    }
    for (const item of input.attachments || []) if (item.uri && item.textContent === undefined && !item.dataBase64) {
      const url = new URL(item.uri); if (url.protocol !== 'file:') throw new Error('附件 URI 只支持当前工作区内的本地文件');
      const file = await this.workspaceFiles.readReference(session.cwd, fileURLToPath(url));
      prompt.push({ type: 'resource', resource: { uri: item.uri, text: file.text, mimeType: item.mimeType } });
    }
    const attachments = (input.attachments || []).map(item => {
      if (!Number.isFinite(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > 20 * 1024 * 1024 || (item.dataBase64?.length || 0) > 28 * 1024 * 1024 || (item.textContent?.length || 0) > 8 * 1024 * 1024) throw new Error('附件超过大小限制或格式无效');
      const fallbackUri = item.uri || `file:///attachment/${encodeURIComponent(item.name || 'file')}`;
      let estimated = Math.ceil(item.sizeBytes / 4);
      if (typeof item.textContent === 'string') {
        prompt.push({ type: 'resource', resource: { uri: fallbackUri, mimeType: item.mimeType || 'text/plain', text: item.textContent } });
        estimated = estimateTokens(item.textContent);
      } else if (item.dataBase64 && /^image\/(png|jpeg|webp|gif)$/.test(item.mimeType) && /^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)) {
        prompt.push({ type: 'image', mimeType: item.mimeType, data: item.dataBase64 });
      } else if (item.dataBase64 && /^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)) {
        prompt.push({ type: 'resource', resource: { uri: fallbackUri, mimeType: item.mimeType || 'application/octet-stream', blob: item.dataBase64 } });
      } else if (item.uri) {
        /* 已经按工作区边界读取并装配文本 */
      } else {
        throw new Error('此附件类型暂不支持，请提供文件内容或资源 URI');
      }
      return { id: randomUUID(), name: item.name, kind: item.mimeType.startsWith('image/') ? 'image' as const : 'file' as const, sizeBytes: item.sizeBytes, estimatedTokens: estimated };
    });
    this.accounts.assertReady();
    // 准备文件引用会让出执行权。送出提示前再检查一次 Profile 和会话占用，避免把准备好的内容发到错误的上下文。
    if (profileId !== this.accounts.activeProfileId || this.managing.has(input.sessionId) || this.revising.has(input.sessionId) || this.sessions.isBusy(input.sessionId) || !this.sessions.isActive(input.sessionId)) throw new Error('文件准备期间会话状态已改变，请重试');
    if (!isManualCompact && input.text.trim() && (!session.title || session.title === '新建对话' || session.title === 'New Session')) {
      const generated = generateStructuredChineseTitle(input.text, session.cwd);
      session.title = generated.organizedTitle;
      session.categoryTag = generated.categoryTag;
      this.sessions.updateSessionRecord(session);
      this.emit('session-updated', this.titles.apply(session));
    }
    const submitted = this.userMessage(input);
    this.upsert(submitted);
    this.clearReactiveTurnTimer(input.sessionId);
    this.telemetry.ensure(input.sessionId, session.modelId);
    if (isManualCompact) this.telemetry.beginManualCompaction(input.sessionId);
    this.telemetry.beginTurn(input.sessionId, input.text, attachments); this.assistantMessages.delete(input.sessionId);
    try { const result = await this.sessions.sendPrompt({ sessionId: input.sessionId, prompt }); if (result.usage) this.telemetry.applyUsage(input.sessionId, result.usage); }
    catch (error) {
      if (profileId === this.accounts.activeProfileId) { submitted.sendFailed = true; this.upsert(submitted); }
      throw error;
    } finally {
      this.finishMessage(input.sessionId);
      this.telemetry.endTurn(input.sessionId);
      this.syncSessionCheckpointWindow(input.sessionId);
      if (isManualCompact) this.telemetry.finishManualCompaction(input.sessionId);
    }
    const feedback = this.feedback.get(input.sessionId); this.feedback.delete(input.sessionId);
    if (feedback?.length && this.sessions.isActive(input.sessionId)) {
      // 用户明确点击“拒绝并反馈”的后续提示，复用同一会话；没有后台自审循环。
      const text = `用户拒绝了上一轮操作，并要求根据以下反馈调整：\n${feedback.join('\n')}`;
      this.upsert({ id: randomUUID(), sessionId: input.sessionId, role: 'user', content: text, createdAt: new Date().toISOString() });
      this.telemetry.beginTurn(input.sessionId, text);
      try { const result = await this.sessions.sendPrompt({ sessionId: input.sessionId, prompt: [{ type: 'text', text }] }); if (result.usage) this.telemetry.applyUsage(input.sessionId, result.usage); }
      finally { this.finishMessage(input.sessionId); this.telemetry.endTurn(input.sessionId); }
    }
  }
  async cancelPrompt(sessionId: string): Promise<void> {
    this.clearReactiveTurnTimer(sessionId);
    this.swarm.markWorkingSubagentsCompleted(sessionId, '用户已停止执行');
    await this.sessions.cancelPrompt(sessionId);
    this.finishMessage(sessionId);
  }
  async compactSessionContext(sessionId: string): Promise<void> {
    if (!this.compactAvailable.has(sessionId)) throw new Error('当前官方会话未声明支持 /compact，不能保证压缩可用');
    await this.sendPrompt({ sessionId, text: '/compact' });
  }
  async saveWorkspaceLayout(patch: Partial<WorkspaceLayoutState>): Promise<WorkspaceLayoutState> {
    const next = { ...this.layout, ...patch };
    if (!Array.isArray(next.openTabSessionIds) || next.openTabSessionIds.length > 4 || !next.openTabSessionIds.every(id => typeof id === 'string') || !['single', 'split-2', 'grid-4'].includes(next.layoutMode) || typeof next.hideLegacyPollutionSessions !== 'boolean') throw new Error('工作台布局无效');
    if (typeof next.leftSidebarCollapsed !== 'boolean' || typeof next.rightInspectorCollapsed !== 'boolean' || !Number.isFinite(next.leftSidebarWidth) || next.leftSidebarWidth < 160 || next.leftSidebarWidth > 600 || !Number.isFinite(next.rightInspectorWidth) || next.rightInspectorWidth < 240 || next.rightInspectorWidth > 1000 || !isRightInspectorTab(next.activeInspectorTab)) throw new Error('Inspector 布局或栏宽无效');
    this.layout = next; this.store.write('layout.json', next); return structuredClone(next);
  }
  async renameSession(sessionId: string, newTitle: string) { const session = this.titles.rename(this.sessions.get(sessionId), newTitle); this.sessions.updateSessionRecord(session); this.emit('session-updated', session); return session; }
  async togglePinSession(sessionId: string) { const session = this.titles.togglePin(this.sessions.get(sessionId)); this.sessions.updateSessionRecord(session); this.emit('session-updated', session); return session; }
  async organizeTitles(request?: TitleOrganizeRequest) { const result = this.titles.organize([...this.sessions.sessions.values()], request); for (const session of this.sessions.sessions.values()) this.emit('session-updated', this.titles.apply(session)); return result; }
  async setApprovalMode(mode: ApprovalMode) { return this.updateApprovalConfig({ mode }); }
  async updateApprovalConfig(patch: Partial<ApproveForMeConfig>) {
    // 外部复审配置分为内存和磁盘两份。持久化副本在写入前剔除密钥，当前进程仍可使用已配置的复审服务。
    const config = this.approval.updateConfig(patch); const persisted = structuredClone(config); delete persisted.externalReviewer.apiKey;
    this.store.write('approval-config.json', persisted); return config;
  }
  async submitApprovalDecision(submission: ApprovalDecisionSubmission): Promise<void> { await this.approval.submitDecision(submission); }
  async listApprovalAudit(limit?: number) { return this.approval.listAudit(limit); }
  async getTelemetryDashboard() { return this.telemetry.snapshot(); }
  async updateModelRateCards(rates: ModelRateCard[]) { return this.telemetry.updateModelRateCards(rates); }
  async setAppIcon(iconId: GravityIconId) { return this.updatePreferences({ appIcon: iconId }); }
  async importCustomTheme(jsonText: string) {
    if (typeof jsonText !== 'string' || jsonText.length > 65536) throw new Error('主题 JSON 超过大小限制');
    let parsed: unknown; try { parsed = JSON.parse(jsonText); } catch { throw new Error('主题 JSON 格式无效'); }
    return this.updatePreferences({ customTheme: validateCustomThemeConfig(parsed), theme: 'custom' });
  }
  async exportCustomTheme(): Promise<string> {
    const preset = THEME_PRESETS.find(theme => theme.id === this.preferences.theme) || THEME_PRESETS[0];
    const theme = this.preferences.customTheme || { name: preset.nameEn, polarity: preset.polarity, baseThemeId: preset.id, tokens: preset.tokens };
    return JSON.stringify(validateCustomThemeConfig(theme), null, 2);
  }
  /** 将消息里的链接或路径解析为系统操作。相对文件依会话目录定位，解析后的本地路径再经过敏感路径检查。 */
  async openLinkOrFileTarget(input: OpenLinkOrFileInput): Promise<OpenLinkOrFileResult> {
    if (!input || typeof input.target !== 'string' || !input.target.trim() || input.target.length > 4096) {
      throw new Error('无效的目标链接或路径');
    }
    if (!['browser', 'default-app', 'reveal-in-folder', 'copy'].includes(input.action)) {
      throw new Error('无效的打开动作');
    }
    const rawTarget = input.target.trim();
    if (/^(?:https?|mailto):/i.test(rawTarget)) {
      const parsed = new URL(rawTarget);
      const mode: OpenLinkOrFileResult['modeUsed'] = input.action === 'copy' ? 'copy' : 'browser';
      await this.options.openTargetHandler?.(parsed.toString(), mode);
      return { opened: true, modeUsed: mode, resolvedTarget: parsed.toString() };
    }

    let localPath = '';
    if (/^file:\/\//i.test(rawTarget)) {
      try {
        const cleanFileUrl = new URL(rawTarget);
        cleanFileUrl.hash = '';
        cleanFileUrl.search = '';
        localPath = fileURLToPath(cleanFileUrl);
      } catch {
        let strippedUri = rawTarget.replace(/^file:\/\/\/?/i, '').replace(/#.*$/, '');
        try {
          strippedUri = decodeURIComponent(strippedUri);
        } catch {
          /* keep raw */
        }
        if (/^\/[A-Za-z]:[\\/]/.test(strippedUri)) strippedUri = strippedUri.slice(1);
        localPath = resolve(strippedUri);
      }
    } else {
      let strippedAnchor = rawTarget.replace(/(?:#L?\d+(?:-\w+)?|:\d+(?::\d+)?)$/i, '').trim();
      try {
        if (/%[0-9A-Fa-f]{2}/.test(strippedAnchor)) strippedAnchor = decodeURIComponent(strippedAnchor);
      } catch {
        /* keep raw */
      }
      localPath = isAbsolute(strippedAnchor)
        ? resolve(strippedAnchor)
        : input.cwd && isAbsolute(input.cwd)
          ? resolve(input.cwd, strippedAnchor)
          : resolve(strippedAnchor);

      // 若正文中右击的是会话生成的 Artifact 裸文件名（如 character_sheet.md / keyvisual.jpg），自动回退检索当前会话专属 brain 目录
      if (!existsSync(localPath) && !isAbsolute(strippedAnchor) && input.sessionId && /^[a-zA-Z0-9_-]{8,80}$/.test(input.sessionId)) {
        const activeProfile = this.accounts
          ?.getState?.()
          .profiles.find((p) => p.profileId === this.accounts.activeProfileId);
        const appDataRoot =
          activeProfile && !activeProfile.isDefault && activeProfile.isolatedAppDataDir
            ? resolve(activeProfile.isolatedAppDataDir)
            : join(this.options?.homeDir || homedir(), '.gemini', 'antigravity-cli');
        const brainCandidate = join(appDataRoot, 'brain', input.sessionId, basename(strippedAnchor));
        if (!isForbiddenCredentialOrStatePath(brainCandidate) && existsSync(brainCandidate)) {
          localPath = brainCandidate;
        }
      }
    }

    if (isForbiddenCredentialOrStatePath(localPath)) {
      throw new Error('拒绝打开敏感凭据或私有状态文件');
    }
    if (input.action === 'copy') {
      await this.options.openTargetHandler?.(localPath, 'copy');
      return { opened: true, modeUsed: 'copy', resolvedTarget: localPath };
    }
    if (!existsSync(localPath)) {
      throw new Error(`本地文件或目录不存在：${localPath}`);
    }
    const st = statSync(localPath);
    const isDir = st.isDirectory();
    const ext = extname(localPath).toLowerCase();
    const isExecutableOrScript = /^\.(?:exe|bat|cmd|ps1|vbs|vbe|wsf|wsh|msi|msp|com|scr|pif|reg|dll|sys|cpl|hta|sh)$/i.test(ext);

    // 根据文件类型智能分流：可执行程序/脚本或文件夹强制定位到文件管理器，文档/图片/代码支持系统默认应用打开
    const modeUsed: OpenLinkOrFileResult['modeUsed'] =
      input.action === 'default-app' && (isDir || isExecutableOrScript)
        ? 'reveal-in-folder'
        : input.action === 'browser'
          ? 'default-app'
          : input.action;

    await this.options.openTargetHandler?.(localPath, modeUsed, isDir);
    return { opened: true, modeUsed, resolvedTarget: localPath };
  }
  async getAccountsState() { return this.accounts.getState(); }
  async createAccountProfile(input: CreateAccountProfileInput) { return this.accounts.createProfile(input); }
  async deleteAccountProfile(profileId: string) { return this.accounts.deleteProfile(profileId); }
  async switchAccountProfile(profileId: string) { return this.accounts.switchProfile(profileId); }
  async officialLogout() { return this.accounts.logout(); }
  async setSessionMode(sessionId: string, mode: AgentExecutionMode) {
    this.accounts.assertReady();
    const updated = await this.sessions.setSessionMode(sessionId, mode);
    this.approval.setSessionExecutionMode(sessionId, updated.executionMode);
    return updated;
  }
  async setSessionEffort(sessionId: string, effort: AgentReasoningEffort) { this.accounts.assertReady(); return this.sessions.setSessionEffort(sessionId, effort); }
  async setSessionModel(sessionId: string, modelId: string) { this.accounts.assertReady(); const session = await this.sessions.setSessionModel(sessionId, modelId); this.telemetry.ensure(sessionId, modelId); return session; }
  async getSessionInspector(sessionId: string) { return this.inspector.get(sessionId); }
  async listWorkspaceFiles(cwd: string, query?: string) { return this.workspaceFiles.list(cwd, query); }
  async listImportedHistory() { return this.history.refresh(); }
  async getImportedHistoryDetail(sessionId: string) { return this.history.getDetail(sessionId); }
  /** 续聊创建新的实时会话，用历史摘要构造首条提示。导入记录的标识继续只用于定位原始记录。 */
  async continueHistoryInGravity(input: ContinueHistoryInGravityInput) {
    const history = this.history.getDetail(input.importedSessionId);
    const cwd = (input.targetCwd || history.cwd || this.options.homeDir || homedir()).trim();
    const session = await this.createSession({ cwd, title: history.title });
    await this.sendPrompt({ sessionId: session.sessionId, text: `请在这个新会话中继续以下历史任务。下面是用户选择的历史摘要，仅作为参考上下文：\n${history.summarySnippet}\n请先概括当前进度和下一步，不自动重复历史中的命令。` });
    return session;
  }
  async getPluginsSnapshot(workspaceCwd?: string) { return this.plugins.getSnapshot(workspaceCwd); }
  async runPluginAction(input: PluginActionInput) { return this.plugins.runPluginAction(input); }
  async runMcpAction(input: McpActionInput) { return this.plugins.runMcpAction(input); }
  async toggleSkillEnabled(skillId: string, enabled: boolean) { return this.plugins.toggleSkillEnabled(skillId, enabled); }
  async getSwarmState(sessionId: string) { return this.swarm.getState(sessionId); }
  /** 退出时先终止定时器与事件来源，再刷新用量账本。即便写盘抛错，finally 也会关闭 ACP 连接。 */
  async dispose(): Promise<void> {
    for (const timer of this.reactiveTurnTimers.values()) clearTimeout(timer);
    this.reactiveTurnTimers.clear();
    this.reactiveWakeupActive.clear();
    this.thoughts.dispose();
    this.localTranslator.dispose();
    this.history.dispose();
    this.approval.dispose(); if (this.telemetryPush) clearTimeout(this.telemetryPush);
    try { this.saveMessages(); this.telemetry.dispose(); } finally { await this.client.stop(); }
  }
}
