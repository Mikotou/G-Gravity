import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpClient, AcpRpcError } from '../acp/acp-client';
import {
  MAX_PARALLEL_ACTIVE_SESSIONS,
  normalizeWorkspacePath,
  isLegacyPollutionSessionTitle,
} from '../../shared/session-contract';
import type { ManagedSessionSummary } from '../../shared/session-contract';
import type { ClientStore } from '../storage/client-store';
import { EXECUTION_MODE_ORDER, REASONING_EFFORT_ORDER } from '../../shared/acp-protocol';
import type {
  AcpConfigOption,
  AcpModelOption,
  AcpSessionListResult,
  AcpSessionNewResult,
  AcpSessionPromptParams,
  AcpSessionPromptResult,
  AcpSessionUpdateNotification,
  AgentExecutionMode,
  AgentReasoningEffort,
} from '../../shared/acp-protocol';

export const CHINESE_SESSION_GUIDANCE =
  '默认使用简体中文向用户回复，保留代码标识符、文件路径和命令。尊重用户明确指定的语言。';

const TRANSLATOR_MARKER = '[Gravity Translator]';
const TITLE_ORGANIZER_MARKER = '[Gravity Title Organizer]';

export function isTempExtractionDir(rawPath?: string): boolean {
  if (!rawPath) return false;
  return /[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)/i.test(rawPath) || /^\/tmp\/\.mount_/i.test(rawPath);
}

/**
 * 在同一 ACP 连接上管理多个用户会话。
 * sessions 存放可展示的摘要，active 表示当前已接入，busy 表示提示仍在等待结果。
 */
export class SessionMultiplexer extends EventEmitter {
  readonly sessions = new Map<string, ManagedSessionSummary>();
  private active = new Set<string>();
  private busy = new Set<string>();
  private opening = new Set<string>();
  private reservations = 0;
  profileId = 'default';
  private optionsBySession = new Map<string, AcpSessionNewResult>();
  private savedSettings: Record<string, { executionMode: AgentExecutionMode; reasoningEffort: AgentReasoningEffort }>;
  private ownedIds = new Set<string>();
  private hasLoadedLedger = false;
  /** 汇总已知会话声明的模型并按 ID 去重。新格式从 model 配置项读取，旧格式从 availableModels 读取。 */
  availableModels(): AcpModelOption[] {
    const collected: AcpModelOption[] = [];
    for (const value of this.optionsBySession.values()) {
      const cfgModel = value.configOptions?.find((opt) => opt.id === 'model');
      if (cfgModel?.options?.length) {
        for (const opt of cfgModel.options) {
          collected.push({ modelId: opt.value, name: opt.name, description: opt.description });
        }
      } else if (value.models?.availableModels?.length) {
        collected.push(...value.models.availableModels);
      }
    }
    return [...new Map(collected.map((model) => [model.modelId, model])).values()];
  }

  hasConfigOptions(sessionId: string): boolean {
    return Boolean(this.optionsBySession.get(sessionId)?.configOptions?.length);
  }

  hasNativeSessionOptions(sessionId: string): boolean {
    const opts = this.optionsBySession.get(sessionId);
    return Boolean(opts?.configOptions?.length || opts?.modes?.availableModes?.length);
  }

  setProfile(profileId: string): void {
    if (this.active.size || this.busy.size || this.reservations) throw new Error('切换 Profile 前必须停止当前连接');
    this.profileId = profileId;
    this.sessions.clear();
    this.ownedIds.clear();
    this.optionsBySession.clear();
    this.loadOwnedLedger();
  }

  private ownedLedgerFile(): string {
    return `owned-sessions-${this.profileId}.json`;
  }

  hasPersistedLedger(): boolean {
    if (!this.store) return false;
    const raw = this.store.read<Record<string, ManagedSessionSummary> | null>(this.ownedLedgerFile(), null);
    return raw !== null && typeof raw === 'object';
  }

  private loadOwnedLedger(): void {
    if (!this.store) return;
    // 用 null 区分从未建立清单和已经保存过的空清单，后者不能触发旧消息迁移。
    const saved = this.store.read<Record<string, ManagedSessionSummary> | null>(this.ownedLedgerFile(), null);
    this.hasLoadedLedger = saved !== null;
    if (!saved || typeof saved !== 'object') return;
    for (const [id, item] of Object.entries(saved)) {
      if (!item || typeof item !== 'object' || !id) continue;
      if (isTempExtractionDir(item.cwd)) {
        item.cwd = homedir();
        item.rawCwd = item.cwd;
      }
      this.ownedIds.add(id);
      this.sessions.set(id, {
        ...this.defaults(),
        ...this.settings(id),
        ...item,
        sessionId: id,
        profileId: this.profileId,
        status: this.active.has(id) ? item.status : 'closed',
      });
    }
  }

  saveOwnedLedger(): void {
    if (!this.store) return;
    const payload: Record<string, ManagedSessionSummary> = {};
    // 磁盘只记录可恢复的会话摘要。活动状态属于本次连接，下次启动需重新恢复会话。
    for (const id of this.ownedIds) {
      const s = this.sessions.get(id);
      if (s && !s.isLegacyApprovalPollution) {
        payload[id] = { ...s, status: 'closed' };
      }
    }
    this.hasLoadedLedger = true;
    this.store.write(this.ownedLedgerFile(), payload);
  }

  /**
   * 首次升级迁移：仅将 Gravity 自有 `messages-<profile>.json` 中已保存的对话注册进独立账本，
   * 彻底隔离外部 Antigravity / CLI 会话。
   */
  seedOwnedFromLocalMessages(
    entries: Array<{ sessionId: string; title: string; cwd: string; updatedAt: string }>
  ): void {
    if (!this.store || this.hasLoadedLedger) return;
    for (const entry of entries) {
      const cleanCwd = !entry.cwd || isTempExtractionDir(entry.cwd) ? homedir() : normalizeWorkspacePath(entry.cwd);
      this.ownedIds.add(entry.sessionId);
      this.sessions.set(entry.sessionId, {
        ...this.defaults(),
        ...this.settings(entry.sessionId),
        sessionId: entry.sessionId,
        cwd: cleanCwd,
        rawCwd: cleanCwd,
        title: entry.title || '新建对话',
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'closed',
        modelId: '',
        updatedAt: entry.updatedAt || new Date().toISOString(),
      });
    }
    this.saveOwnedLedger();
  }

  forgetSession(id: string): void {
    this.ownedIds.delete(id);
    this.sessions.delete(id);
    this.optionsBySession.delete(id);
    delete this.savedSettings[this.profileId + ':' + id];
    this.store?.write('session-settings.json', this.savedSettings);
    this.saveOwnedLedger();
  }

  updateSessionRecord(session: ManagedSessionSummary): void {
    if (!this.sessions.has(session.sessionId)) return;
    this.sessions.set(session.sessionId, { ...session });
    if (this.ownedIds.has(session.sessionId)) {
      this.saveOwnedLedger();
    }
  }

  private defaults() {
    return {
      executionMode: 'default' as const,
      reasoningEffort: 'high' as const,
      originKind: 'acp-live' as const,
      readOnly: false,
      profileId: this.profileId,
    };
  }

  constructor(
    readonly client: AcpClient,
    private store?: ClientStore
  ) {
    super();
    this.savedSettings = store?.read('session-settings.json', {}) || {};
    this.loadOwnedLedger();
    client.on('session/update', (payload: AcpSessionUpdateNotification) => {
      if (!payload || !payload.update) return;
      if (!this.active.has(payload.sessionId) && !this.opening.has(payload.sessionId)) return;
      if (
        payload.update.sessionUpdate === 'config_option_update' &&
        Array.isArray(payload.update.configOptions)
      ) {
        const stored = this.optionsBySession.get(payload.sessionId) || { sessionId: payload.sessionId };
        stored.configOptions = payload.update.configOptions;
        this.optionsBySession.set(payload.sessionId, stored);
        const session = this.sessions.get(payload.sessionId);
        if (session) {
          this.syncSessionFromOptions(session, stored);
          this.emit('session', { ...session });
        }
        return;
      }
      this.emit('update', payload);
    });
    client.on('disconnected', () => {
      for (const id of this.active) this.setStatus(id, 'error');
      this.active.clear();
      this.busy.clear();
      this.opening.clear();
    });
  }

  private syncSessionFromOptions(session: ManagedSessionSummary, result?: AcpSessionNewResult): void {
    if (!result) return;
    const cfg = result.configOptions;
    const modelOpt = cfg?.find((opt) => opt.id === 'model');
    if (modelOpt?.options?.length) {
      session.availableModels = modelOpt.options.map((opt) => ({
        modelId: opt.value,
        name: opt.name,
        description: opt.description,
      }));
      if (modelOpt.currentValue) session.modelId = modelOpt.currentValue;
    } else if (result.models?.availableModels?.length) {
      session.availableModels = result.models.availableModels.map((m) => ({ ...m }));
      if (result.models.currentModelId) session.modelId = result.models.currentModelId;
    } else if (result.models?.currentModelId) {
      session.modelId = result.models.currentModelId;
    }

    // 代理已声明统一配置但未列出推理选项时，写入空列表。
    // 界面可据此区分「明确无档位」与「旧协议未提供此信息」。
    if (Array.isArray(cfg)) {
      const effortOpt = cfg.find((opt) => opt.id === 'thought_level');
      if (effortOpt?.options?.length) {
        session.availableEfforts = effortOpt.options
          .filter((opt) => (REASONING_EFFORT_ORDER as readonly string[]).includes(opt.value))
          .map((opt) => ({ value: opt.value as AgentReasoningEffort, name: opt.name }));
        if (
          effortOpt.currentValue &&
          (REASONING_EFFORT_ORDER as readonly string[]).includes(effortOpt.currentValue)
        ) {
          session.reasoningEffort = effortOpt.currentValue as AgentReasoningEffort;
        }
      } else {
        session.availableEfforts = [];
      }
    }

    const modeOpt = cfg?.find((opt) => opt.id === 'mode');
    const currentMode = modeOpt?.currentValue || result.modes?.currentModeId;
    if (currentMode && ['default', 'accept-edits', 'plan', 'auto'].includes(currentMode)) {
      session.executionMode = currentMode as AgentExecutionMode;
    }
  }

  private settings(sessionId: string): { executionMode?: AgentExecutionMode; reasoningEffort?: AgentReasoningEffort } {
    const saved = this.savedSettings[`${this.profileId}:${sessionId}`];
    return saved
      ? {
          executionMode: (EXECUTION_MODE_ORDER as readonly string[]).includes(saved.executionMode)
            ? saved.executionMode
            : 'default',
          reasoningEffort: REASONING_EFFORT_ORDER.includes(saved.reasoningEffort)
            ? saved.reasoningEffort
            : 'high',
        }
      : {};
  }

  private persistSettings(session: ManagedSessionSummary): void {
    this.savedSettings[`${this.profileId}:${session.sessionId}`] = {
      executionMode: session.executionMode,
      reasoningEffort: session.reasoningEffort,
    };
    this.store?.write('session-settings.json', this.savedSettings);
  }

  get activeSessionCount(): number {
    return this.active.size;
  }
  isActive(id: string): boolean {
    return this.active.has(id);
  }
  isBusy(id: string): boolean {
    return this.busy.has(id);
  }
  isResuming(id: string): boolean {
    return this.opening.has(id);
  }
  get(id: string): ManagedSessionSummary {
    const session = this.sessions.get(id);
    if (!session) throw new Error('会话不存在');
    return session;
  }

  private workspace(raw: string): string {
    if (typeof raw !== 'string' || raw.includes('\0')) throw new Error('工作区路径无效');
    const cwd = normalizeWorkspacePath(raw);
    if (!cwd || !isAbsolute(cwd)) throw new Error('请选择工作区绝对路径');
    return cwd;
  }

  /** 先占用名额再异步握手。调用方在 finally 归还预留数，因此同时点击新建或恢复也受同一上限约束。 */
  private reserve(): void {
    if (this.active.size + this.reservations >= MAX_PARALLEL_ACTIVE_SESSIONS) {
      throw new Error('最多同时打开 4 个活动会话，请先关闭一个标签页');
    }
    this.reservations++;
  }

  /** 为短生命周期后台任务（如内置 Hydrogen 标题整理）借用一个并发槽位，遵守最多 4 路并发上限。 */
  reserveExternalSlot(): void {
    if (this.active.size + this.reservations >= MAX_PARALLEL_ACTIVE_SESSIONS) {
      throw new Error('当前已打开 4 个活动会话，请先关闭一个标签页后再使用内置模型 Hydrogen (medium) 整理标题');
    }
    this.reservations++;
  }

  releaseExternalSlot(): void {
    this.reservations = Math.max(0, this.reservations - 1);
  }

  setStatus(id: string, status: ManagedSessionSummary['status']): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = status;
    session.updatedAt = new Date().toISOString();
    if (this.ownedIds.has(id) && (status === 'idle' || status === 'closed')) {
      this.saveOwnedLedger();
    }
    this.emit('session', { ...session });
  }

  async listSessions(includeHiddenPollution = false): Promise<ManagedSessionSummary[]> {
    await this.client.start();
    const isolateGravityOwned = Boolean(this.store);
    if (this.client.initializeResult?.agentCapabilities.sessionCapabilities?.list) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result: AcpSessionListResult = await this.client.request('session/list', cursor ? { cursor } : {});
        if (!Array.isArray(result.sessions)) throw new Error('官方会话列表格式无效');
        for (const item of result.sessions) {
          if (
            (item.title && item.title.includes(TRANSLATOR_MARKER)) ||
            (item.title && item.title.includes(TITLE_ORGANIZER_MARKER)) ||
            (item.title && /^Gravity Translator\b/i.test(item.title))
          ) {
            continue;
          }
          // 独立账本模式：只同步 Gravity 自己创建的对话，绝不混入外部 Antigravity / CLI 会话
          if (isolateGravityOwned && !this.ownedIds.has(item.sessionId)) {
            continue;
          }
          const existing = this.sessions.get(item.sessionId);
          const resolvedCwd =
            existing?.cwd && !isTempExtractionDir(existing.cwd)
              ? existing.cwd
              : isTempExtractionDir(item.cwd)
                ? homedir()
                : normalizeWorkspacePath(item.cwd);
          this.sessions.set(item.sessionId, {
            ...this.defaults(),
            ...this.settings(item.sessionId),
            ...(existing
              ? {
                  executionMode: existing.executionMode,
                  reasoningEffort: existing.reasoningEffort,
                  availableModels: existing.availableModels,
                  availableEfforts: existing.availableEfforts,
                }
              : {}),
            sessionId: item.sessionId,
            cwd: resolvedCwd,
            rawCwd: resolvedCwd,
            title:
              existing?.title && existing.title !== '新建对话'
                ? existing.title
                : item.title || existing?.title || '新建对话',
            rawTitle: item.title,
            archivedAt: existing?.archivedAt,
            pinned: existing?.pinned || false,
            categoryTag: existing?.categoryTag,
            isLegacyApprovalPollution: isLegacyPollutionSessionTitle(item.title),
            status: existing?.status || 'closed',
            modelId: existing?.modelId || '',
            updatedAt: existing?.updatedAt && existing.updatedAt > (item.updatedAt || '') ? existing.updatedAt : item.updatedAt || new Date().toISOString(),
          });
        }
        // 翻页时记住已经用过的游标，同时限制页数，避免异常的列表响应使启动一直等待。
        cursor = result.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('官方会话列表游标重复');
        if (cursor) seen.add(cursor);
      } while (cursor && seen.size < 100);
      if (isolateGravityOwned) this.saveOwnedLedger();
    }
    return [...this.sessions.values()]
      .filter((item) => (!isolateGravityOwned || this.ownedIds.has(item.sessionId)) && (includeHiddenPollution || !item.isLegacyApprovalPollution))
      .map((item) => ({ ...item }));
  }

  async createSession(input: { cwd: string; title?: string }): Promise<ManagedSessionSummary> {
    const cwd = this.workspace(input.cwd);
    this.reserve();
    try {
      await this.client.start();
      const append = this.client.initializeResult?.agentCapabilities._meta?.antigravity?.systemPrompt?.append;
      const newSession = () => this.client.request<AcpSessionNewResult>('session/new', {
        cwd,
        mcpServers: [],
        ...(append ? { _meta: { antigravity: { systemPrompt: { append: CHINESE_SESSION_GUIDANCE } } } } : {}),
      });
      const profile = this.profileId;
      let result: AcpSessionNewResult;
      try { result = await newSession(); }
      catch (error) {
        // Only retry an explicit startup rejection. A lost response might refer to a conversation that already exists.
        if (!(error instanceof AcpRpcError) || !/^Failed to start Antigravity conversation[.!]?$/i.test(error.message)) throw error;
        await delay(900);
        if (!this.client.connected || this.profileId !== profile) throw error;
        result = await newSession();
      }
      if (!result?.sessionId || this.active.has(result.sessionId)) throw new Error('官方 ACP 返回了无效或重复会话 ID');
      const session: ManagedSessionSummary = {
        ...this.defaults(),
        sessionId: result.sessionId,
        cwd,
        rawCwd: input.cwd,
        title: input.title?.trim() || '新建对话',
        rawTitle: input.title,
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'idle',
        modelId: result.models?.currentModelId || '',
        updatedAt: new Date().toISOString(),
      };
      this.optionsBySession.set(result.sessionId, result);
      this.syncSessionFromOptions(session, result);
      this.ownedIds.add(session.sessionId);
      this.sessions.set(session.sessionId, session);
      this.active.add(session.sessionId);
      this.saveOwnedLedger();
      this.emit('session', { ...session });
      return { ...session };
    } finally {
      this.reservations--;
    }
  }

  async resumeSession(sessionId: string, rawCwd: string): Promise<ManagedSessionSummary> {
    const requestedCwd = this.workspace(rawCwd);
    const isRealAgy = Boolean(
      this.store && this.client.initializeResult?.agentInfo?.name?.toLowerCase().includes('antigravity')
    );
    const cwd = isTempExtractionDir(requestedCwd) || (isRealAgy && !existsSync(requestedCwd)) ? homedir() : requestedCwd;
    if (this.active.has(sessionId)) return { ...this.get(sessionId) };
    if (this.opening.has(sessionId)) throw new Error('此会话正在恢复');
    this.reserve();
    this.opening.add(sessionId);
    try {
      await this.client.start();
      const capabilities = this.client.initializeResult?.agentCapabilities;
      // 优先选择服务端声明的 resume，较早的实现使用 load。两种入口共用活动槽位与消息路由。
      const method = capabilities?.sessionCapabilities?.resume
        ? 'session/resume'
        : capabilities?.loadSession || capabilities?.load_session
          ? 'session/load'
          : undefined;
      if (!method) throw new Error('当前官方 ACP 不支持恢复会话');
      const previous = this.sessions.get(sessionId);
      const session: ManagedSessionSummary = previous || {
        ...this.defaults(),
        ...this.settings(sessionId),
        sessionId,
        cwd,
        rawCwd,
        title: '恢复的对话',
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'idle',
        modelId: '',
        updatedAt: new Date().toISOString(),
      };
      // load 会在响应之前回放历史，因此先注册路由。
      this.sessions.set(sessionId, session);
      try {
        const append = this.client.initializeResult?.agentCapabilities._meta?.antigravity?.systemPrompt?.append;
        const result = await this.client.request<AcpSessionNewResult>(method, {
          sessionId,
          cwd,
          mcpServers: [],
          ...(append ? { _meta: { antigravity: { systemPrompt: { append: CHINESE_SESSION_GUIDANCE } } } } : {}),
        });
        const stored = result || { sessionId };
        this.optionsBySession.set(sessionId, stored);
        // 先保存用户原有模式，再用服务端配置刷新摘要。
        // 旧模式仍在可用列表且与当前值不符时，才发起恢复设置的 RPC。
        const desiredMode = session.executionMode;
        this.syncSessionFromOptions(session, stored);
        if (
          stored?.modes?.availableModes?.some((mode) => mode.id === desiredMode) &&
          stored.modes.currentModeId !== desiredMode
        ) {
          await this.client.request('session/set_mode', { sessionId, modeId: desiredMode });
          session.executionMode = desiredMode;
        }
        session.cwd = cwd;
        session.rawCwd = rawCwd;
        this.active.add(sessionId);
        this.setStatus(sessionId, 'idle');
        return { ...session };
      } catch (error) {
        this.active.delete(sessionId);
        this.setStatus(sessionId, 'error');
        throw error;
      }
    } finally {
      this.reservations--;
      this.opening.delete(sessionId);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.active.has(sessionId)) return;
    if (this.client.initializeResult?.agentCapabilities.sessionCapabilities?.close) {
      await this.client.request('session/close', { sessionId });
    } else {
      await this.cancelPrompt(sessionId);
      throw new Error('当前官方 ACP 不支持关闭单个会话；请退出客户端以释放所有会话');
    }
    this.active.delete(sessionId);
    this.busy.delete(sessionId);
    this.setStatus(sessionId, 'closed');
    this.emit('closed', sessionId);
  }

  /** 用户提示按会话互斥。长回合关闭常规 RPC 超时，由服务端答复或连接中断结束等待。 */
  async sendPrompt(params: AcpSessionPromptParams): Promise<AcpSessionPromptResult> {
    if (!this.active.has(params.sessionId)) throw new Error('请先恢复此会话');
    if (this.busy.has(params.sessionId)) throw new Error('该会话仍在生成，请等待或停止');
    this.busy.add(params.sessionId);
    this.setStatus(params.sessionId, 'streaming');
    try {
      return await this.client.request<AcpSessionPromptResult>('session/prompt', params, 0);
    } catch (error) {
      this.setStatus(params.sessionId, 'error');
      throw error;
    } finally {
      this.busy.delete(params.sessionId);
      if (this.active.has(params.sessionId) && this.get(params.sessionId).status !== 'error') {
        this.setStatus(params.sessionId, 'idle');
      }
    }
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    if (this.active.has(sessionId)) this.client.notify('session/cancel', { sessionId });
    this.emit('cancelled', sessionId);
  }

  async setSessionMode(sessionId: string, mode: AgentExecutionMode): Promise<ManagedSessionSummary> {
    if (!['default', 'accept-edits', 'plan', 'auto'].includes(mode)) throw new Error('无效的 Mode');
    if (!this.active.has(sessionId) || this.busy.has(sessionId)) throw new Error('请在活动会话空闲时修改 Mode');
    const stored = this.optionsBySession.get(sessionId);
    const cfgMode = stored?.configOptions?.find((opt) => opt.id === 'mode');
    if (cfgMode?.options?.some((opt) => opt.value === mode)) {
      const res = await this.client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
        sessionId,
        configId: 'mode',
        value: mode,
      });
      if (res?.configOptions && stored) stored.configOptions = res.configOptions;
    } else if (stored?.modes?.availableModes?.some((item) => item.id === mode)) {
      await this.client.request('session/set_mode', { sessionId, modeId: mode });
    } else {
      this.emit('localPreference', {
        sessionId,
        text: `官方 ACP 未声明 ${mode} 模式；已保存本地提示偏好，权限审查保持原设置。`,
      });
    }
    const session = this.get(sessionId);
    session.executionMode = mode;
    this.persistSettings(session);
    this.emit('session', { ...session });
    return { ...session };
  }

  async setSessionEffort(sessionId: string, effort: AgentReasoningEffort): Promise<ManagedSessionSummary> {
    if (!REASONING_EFFORT_ORDER.includes(effort)) throw new Error('无效的 Effort');
    if (!this.active.has(sessionId) || this.busy.has(sessionId)) throw new Error('请在活动会话空闲时修改 Effort');
    const stored = this.optionsBySession.get(sessionId);
    const session = this.get(sessionId);
    if (Array.isArray(stored?.configOptions)) {
      const effortOpt = stored.configOptions.find((opt) => opt.id === 'thought_level');
      if (!effortOpt?.options?.length) throw new Error('当前所选模型没有独立的推理强度档位');
      if (!effortOpt.options.some((opt) => opt.value === effort)) {
        throw new Error(`当前模型不支持 ${effort} 推理强度`);
      }
      const res = await this.client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
        sessionId,
        configId: 'thought_level',
        value: effort,
      });
      if (res?.configOptions) stored.configOptions = res.configOptions;
      this.syncSessionFromOptions(session, stored);
      session.reasoningEffort = effort;
      this.persistSettings(session);
      this.emit('session', { ...session });
      return { ...session };
    }
    session.reasoningEffort = effort;
    this.persistSettings(session);
    this.emit('localPreference', {
      sessionId,
      text: `Effort ${effort} 已保存为本地提示偏好；当前 ACP 未声明独立的推理强度设置接口。`,
    });
    this.emit('session', { ...session });
    return { ...session };
  }

  /** 只有活动且空闲的会话能改模型。优先采用 configOptions 的选项和值，旧版代理使用独立的 set_model。 */
  async setSessionModel(sessionId: string, modelId: string): Promise<ManagedSessionSummary> {
    if (!this.active.has(sessionId) || this.busy.has(sessionId)) throw new Error('请在活动会话空闲时修改 Model');
    const stored = this.optionsBySession.get(sessionId);
    const cfgModel = stored?.configOptions?.find((opt) => opt.id === 'model');
    const session = this.get(sessionId);
    if (cfgModel?.options?.some((opt) => opt.value === modelId)) {
      const res = await this.client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: modelId,
      });
      if (res?.configOptions && stored) stored.configOptions = res.configOptions;
      session.modelId = modelId;
      this.syncSessionFromOptions(session, stored);
      this.persistSettings(session);
      this.emit('session', { ...session });
      return { ...session };
    }
    if (!stored?.models?.availableModels?.some((model) => model.modelId === modelId)) {
      throw new Error('官方会话未声明此 Model 可用');
    }
    await this.client.request('session/set_model', { sessionId, modelId });
    session.modelId = modelId;
    this.emit('session', { ...session });
    return { ...session };
  }
}
