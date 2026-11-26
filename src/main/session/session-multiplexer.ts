import { setTimeout as delay } from 'node:timers/promises';
import { diagnosticForError, disconnectDiagnostic } from '../services/session-diagnostics';
import { AcpClient, AcpRpcError } from '../acp/acp-client';
import {
  normalizeWorkspacePath, isLegacyPollutionSessionTitle,
} from '../../shared/session-contract';
import type { ManagedSessionSummary } from '../../shared/session-contract';
import type { ClientStore } from '../storage/client-store';
import { REASONING_EFFORT_ORDER } from '../../shared/acp-protocol';
import type {
  AcpConfigOption, AcpSessionListResult, AcpSessionNewResult, AcpSessionPromptParams,
  AcpSessionPromptResult, AcpSessionUpdateNotification, AgentExecutionMode, AgentReasoningEffort,
} from '../../shared/acp-protocol';

import { SessionSlots } from './session-slots';
import { SessionLedger, resolveAccessibleCwd } from './session-ledger';
import { declaredModels, isSessionExecutionMode } from './session-options-store';
import { isAnyAbsolutePath } from '../workspace/local-path-safety';
export { isSessionExecutionMode } from './session-options-store';
export const CHINESE_SESSION_GUIDANCE =
  '默认使用简体中文向用户回复，保留代码标识符、文件路径和命令。尊重用户明确指定的语言。' +
  '临时脚本请写入当前工作区的 ./.gravity-scratch/ 或系统临时目录，切勿写入用户主目录中的 .gemini 目录。';

const TRANSLATOR_MARKER = '[Gravity Translator]';
const TITLE_ORGANIZER_MARKER = '[Gravity Title Organizer]';

/**
 * 在同一 ACP 连接上管理多个用户会话。
 * sessions 存放可展示的摘要，active 表示当前已接入，busy 表示提示仍在等待结果。
 */
export class SessionMultiplexer extends SessionLedger {
  private busy = new Map<string, symbol>();
  private opening = new Set<string>();
  readonly slots: SessionSlots;
  private creating = 0;
  private configuring = new Set<string>();
  private earlyOptions = new Map<string, Map<string, AcpSessionUpdateNotification>>();
  private publishSession(session: ManagedSessionSummary): void {
    if (!this.configuring.has(session.sessionId)) this.emit('session', { ...session });
  }

  setProfile(profileId: string): void {
    if (this.active.size || this.busy.size || this.slots.count) throw new Error('切换 Profile 前必须停止当前连接');
    this.flush();
    this.profileId = profileId;
    this.sessions.clear();
    this.ownedIds.clear();
    this.options.optionsBySession.clear();
    this.options.localTurboSessions.clear();
    this.loadOwnedLedger();
    this.options.loadModelCatalog();
  }

  modelList() { return this.options.modelList(); }
  invalidateModelCatalog() { this.options.invalidateModelCatalog(); }
  supportsMode(id: string, mode: AgentExecutionMode) { return this.options.supportsMode(id, mode); }
  hasConfigOptions(id: string) { return this.options.hasConfigOptions(id); }
  reportedChoice(id: string, option: 'model' | 'thought_level'): string | undefined {
    const receipt = this.options.optionsBySession.get(id);
    const field = receipt?.configOptions?.find(item => item.id === option);
    return field ? field.currentValue : option === 'model' ? receipt?.models?.currentModelId : undefined;
  }

  constructor(client: AcpClient, store?: ClientStore) {
    super(client, store);
    this.slots = new SessionSlots(client);
    client.on('session/update', payload => this.routeUpdate(payload));
    client.on('disconnected', event => {
      const interrupted = [...this.active];
      this.slots.clear();
      this.active.clear();
      this.options.optionsBySession.clear();
      this.options.localTurboSessions.clear();
      this.busy.clear();
      this.opening.clear();
      this.earlyOptions.clear();
      const diagnostic = disconnectDiagnostic(client, event);
      for (const id of interrupted) this.setStatus(id, 'error', diagnostic);
    });
  }

  private routeUpdate(payload: AcpSessionUpdateNotification): void {
      if (!payload || !payload.update) return;
      if (!this.active.has(payload.sessionId) && !this.opening.has(payload.sessionId)) {
        const kind = payload.update.sessionUpdate;
        if (this.creating && ['available_commands_update', 'config_option_update', 'current_mode_update'].includes(kind) &&
            (this.earlyOptions.has(payload.sessionId) || this.earlyOptions.size < 16)) {
          const updates = this.earlyOptions.get(payload.sessionId) || new Map<string, AcpSessionUpdateNotification>();
          updates.set(kind, payload);
          this.earlyOptions.set(payload.sessionId, updates);
        }
        return;
      }
      if (
        payload.update.sessionUpdate === 'config_option_update' &&
        Array.isArray(payload.update.configOptions)
      ) {
        const stored = this.options.optionsBySession.get(payload.sessionId) || { sessionId: payload.sessionId };
        stored.configOptions = payload.update.configOptions;
        this.options.optionsBySession.set(payload.sessionId, stored);
        const session = this.sessions.get(payload.sessionId);
        if (session) {
          this.options.syncSessionFromOptions(session, stored);
          this.publishSession(session);
        }
        return;
      }
      if (payload.update.sessionUpdate === 'current_mode_update') {
        const session = this.sessions.get(payload.sessionId);
        if (session && this.options.applyReportedMode(session, payload.update.currentModeId)) {
          this.setStatus(session.sessionId, session.status, session.diagnostic);
        }
      }
      this.emit('update', payload);
  }

  get activeSessionCount(): number {
    return this.slots.count;
  }
  get isOpeningSession(): boolean { return this.creating > 0 || this.opening.size > 0; }
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
    const isAbs = isAnyAbsolutePath(cwd);
    if (!cwd || !isAbs) throw new Error('请选择工作区绝对路径');
    return cwd;
  }

  reserveExternalSlot() { return this.slots.reserve(true); }

  setStatus(id: string, status: ManagedSessionSummary['status'], diagnostic?: ManagedSessionSummary['diagnostic']): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = status;
    if (diagnostic) session.diagnostic = diagnostic;
    else delete session.diagnostic;
    session.updatedAt = new Date().toISOString();
    if (this.ownedIds.has(id) && (status === 'idle' || status === 'closed')) {
      this.saveOwnedLedger();
      this.flush();
    }
    this.publishSession(session);
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
            this.slots.find(item.sessionId)?.hidden ||
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
          const resolvedCwd = resolveAccessibleCwd(existing?.cwd || item.cwd, resolveAccessibleCwd(item.cwd));
          this.sessions.set(item.sessionId, {
            ...this.defaults(),
            ...this.options.settings(item.sessionId),
            ...(existing
              ? {
                  executionMode: existing.executionMode,
                  reasoningEffort: existing.reasoningEffort,
                  readOnly: existing.readOnly,
                  diagnostic: existing.diagnostic,
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
    return this.localSessionSummaries(includeHiddenPollution);
  }

  localSessionSummaries(includeHiddenPollution = false): ManagedSessionSummary[] {
    return [...this.sessions.values()]
      .filter((item) => (!this.store || this.ownedIds.has(item.sessionId)) && (includeHiddenPollution || !item.isLegacyApprovalPollution))
      .map((item) => ({ ...item }));
  }

  async createSession(input: { cwd: string; title?: string }, configure?: (session: ManagedSessionSummary) => Promise<void>): Promise<ManagedSessionSummary> {
    const cwd = this.workspace(input.cwd);
    const slot = this.slots.reserve(false);
    this.creating++;
    try {
      await this.client.start();
      const append = this.client.initializeResult?.agentCapabilities._meta?.antigravity?.systemPrompt?.append;
      const newSession = () => this.slots.open(slot, 'session/new', {
        cwd,
        mcpServers: [],
        ...(append ? { _meta: { antigravity: { systemPrompt: { append: CHINESE_SESSION_GUIDANCE } } } } : {}),
      });
      const profile = this.profileId;
      const cooldownAtStart = this.client.cooldownUntilMs;
      let result: AcpSessionNewResult;
      try { result = await newSession(); }
      catch (error) {
        // Only retry an explicit startup rejection. A lost response might refer to a conversation that already exists.
        if (!(error instanceof AcpRpcError) || !/^Failed to start Antigravity conversation[.!]?$/i.test(error.message)) throw error;
        await delay(900);
        if (!this.client.connected || this.profileId !== profile || this.client.cooldownUntilMs !== cooldownAtStart) throw error;
        result = await newSession();
      }
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
      this.options.optionsBySession.set(result.sessionId, result);
      this.options.syncSessionFromOptions(session, result);
      this.sessions.set(session.sessionId, session);
      this.active.add(session.sessionId);
      this.configuring.add(session.sessionId);
      try {
        for (const update of this.earlyOptions.get(session.sessionId)?.values() || []) this.routeUpdate(update);
        this.earlyOptions.delete(session.sessionId);
        await configure?.(session);
      } catch (error) {
        try { await this.closeSession(session.sessionId); }
        finally {
          if (!this.active.has(session.sessionId)) this.forgetSession(session.sessionId);
          else {
            this.configuring.delete(session.sessionId);
            this.ownedIds.add(session.sessionId);
            this.setStatus(session.sessionId, 'error');
            this.saveOwnedLedger();
          }
        }
        throw error;
      } finally {
        this.configuring.delete(session.sessionId);
      }
      this.ownedIds.add(session.sessionId);
      this.saveOwnedLedger();
      this.flush();
      this.publishSession(session);
      return { ...session };
    } finally {
      if (--this.creating === 0) this.earlyOptions.clear();
      this.slots.releaseUnused(slot);
    }
  }

  async resumeSession(sessionId: string, rawCwd: string, requestReplay: boolean | (() => Promise<boolean>) = false): Promise<ManagedSessionSummary> {
    const requestedCwd = this.workspace(rawCwd);
    const cwd = resolveAccessibleCwd(requestedCwd);
    if (this.opening.has(sessionId)) throw new Error('此会话正在恢复');
    if (this.active.has(sessionId)) return { ...this.get(sessionId) };
    const slot = this.slots.reserve(false, sessionId);
    this.opening.add(sessionId);
    try {
      await this.client.start();
      const capabilities = this.client.initializeResult?.agentCapabilities;
      // 优先选择服务端声明的 resume，较早的实现使用 load。两种入口共用活动槽位与消息路由。
      const canLoad = capabilities?.loadSession || capabilities?.load_session;
      const replay = canLoad && (typeof requestReplay === 'function' ? await requestReplay() : requestReplay);
      const method = replay ? 'session/load' : capabilities?.sessionCapabilities?.resume
        ? 'session/resume'
        : canLoad
          ? 'session/load'
          : undefined;
      if (!method) throw new Error('当前官方 ACP 不支持恢复会话');
      const previous = this.sessions.get(sessionId);
      const session: ManagedSessionSummary = previous || {
        ...this.defaults(),
        ...this.options.settings(sessionId),
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
      const desiredMode = this.options.settings(sessionId).executionMode ?? previous?.executionMode;
      const desiredEffort = session.reasoningEffort;
      try {
        const append = this.client.initializeResult?.agentCapabilities._meta?.antigravity?.systemPrompt?.append;
        const result = await this.slots.open(slot, method, {
          sessionId,
          cwd,
          mcpServers: [],
          ...(append ? { _meta: { antigravity: { systemPrompt: { append: CHINESE_SESSION_GUIDANCE } } } } : {}),
        });
        const stored = { ...this.options.optionsBySession.get(sessionId), ...(result || {}), sessionId };
        this.options.optionsBySession.set(sessionId, stored);
        // Reconcile saved Turbo with the capabilities of this connection before enabling it.
        if (desiredMode === 'full-access') session.executionMode = 'default';
        this.options.syncSessionFromOptions(session, stored);
        session.readOnly = false;
        this.configuring.add(sessionId);
        this.active.add(sessionId);
        if (desiredMode && session.executionMode !== desiredMode && (desiredMode === 'full-access' || this.supportsMode(sessionId, desiredMode))) {
          await this.setSessionMode(sessionId, desiredMode);
        }
        if (this.options.supportsEffort(sessionId, desiredEffort) && session.reasoningEffort !== desiredEffort) await this.setSessionEffort(sessionId, desiredEffort);
        session.cwd = cwd;
        session.rawCwd = requestedCwd === cwd ? rawCwd : cwd;
        this.assertConfigurationOwner(sessionId, stored);
        this.configuring.delete(sessionId);
        this.setStatus(sessionId, 'idle');
        return { ...session };
      } catch (error) {
        if (this.active.has(sessionId)) await this.closeSession(sessionId).catch(() => {});
        if (!this.active.has(sessionId)) this.options.optionsBySession.delete(sessionId);
        this.setStatus(sessionId, 'error', diagnosticForError(error, this.client));
        throw error;
      }
    } finally {
      this.slots.releaseUnused(slot);
      this.configuring.delete(sessionId);
      this.opening.delete(sessionId);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const slot = this.slots.find(sessionId);
    if (!slot || slot.hidden) {
      const session = this.sessions.get(sessionId);
      if (session?.readOnly) {
        session.readOnly = false;
        this.publishSession(session);
      }
      return;
    }
    if (!this.client.initializeResult?.agentCapabilities.sessionCapabilities?.close) await this.cancelPrompt(sessionId);
    await this.slots.close(slot, () => {
      this.active.delete(sessionId);
      this.options.optionsBySession.delete(sessionId);
      this.options.localTurboSessions.delete(sessionId);
      this.busy.delete(sessionId);
      try { this.setStatus(sessionId, 'closed'); }
      finally { this.emit('closed', sessionId); }
    });
  }

  /** 用户提示按会话互斥。长回合关闭常规 RPC 超时，由服务端答复或连接中断结束等待。 */
  async sendPrompt(params: AcpSessionPromptParams): Promise<AcpSessionPromptResult> {
    if (!this.active.has(params.sessionId)) throw new Error('请先恢复此会话');
    if (this.configuring.has(params.sessionId) || this.busy.has(params.sessionId)) throw new Error('该会话仍在生成，请等待或停止');
    const turn = Symbol();
    this.busy.set(params.sessionId, turn);
    this.setStatus(params.sessionId, 'streaming');
    try {
      return await this.client.request<AcpSessionPromptResult>('session/prompt', params, 0);
    } catch (error) {
      if (this.busy.get(params.sessionId) === turn) this.setStatus(params.sessionId, 'error', diagnosticForError(error, this.client));
      throw error;
    } finally {
      if (this.busy.get(params.sessionId) === turn) {
        this.busy.delete(params.sessionId);
        if (this.active.has(params.sessionId) && this.get(params.sessionId).status !== 'error') this.setStatus(params.sessionId, 'idle');
      }
    }
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    if (this.active.has(sessionId)) this.client.notify('session/cancel', { sessionId });
    this.emit('cancelled', sessionId);
  }

  private assertConfigurationOwner(id: string, original: AcpSessionNewResult | undefined): void {
    if (!this.active.has(id) || !this.sessions.has(id) || this.options.optionsBySession.get(id) !== original) throw new Error('配置期间会话已关闭或重新连接');
  }

  async setSessionMode(sessionId: string, mode: AgentExecutionMode): Promise<ManagedSessionSummary> {
    if (!isSessionExecutionMode(mode)) throw new Error('无效的 Mode');
    if (!this.active.has(sessionId) || this.busy.has(sessionId)) throw new Error('请在活动会话空闲时修改 Mode');
    const stored = this.options.optionsBySession.get(sessionId);
    const cfgMode = stored?.configOptions?.find((opt) => opt.id === 'mode');
    const legacyAdvertised = stored?.modes?.availableModes?.some(item => item.id === mode);
    let localTurbo = false;
    let preferenceNotice: string | undefined;
    const setLegacyMode = async () => {
      await this.client.request('session/set_mode', { sessionId, modeId: mode });
      this.assertConfigurationOwner(sessionId, stored);
      if (stored?.modes) stored.modes.currentModeId = mode;
    };
    if (cfgMode?.options?.some((opt) => opt.value === mode)) {
      let res: { configOptions?: AcpConfigOption[] } | undefined;
      try {
        res = await this.client.request('session/set_config_option', { sessionId, configId: 'mode', value: mode });
      } catch (error) {
        this.assertConfigurationOwner(sessionId, stored);
        if (!(error instanceof AcpRpcError && error.code === -32601 && legacyAdvertised)) throw error;
        await setLegacyMode();
      }
      this.assertConfigurationOwner(sessionId, stored);
      if (res?.configOptions && stored) {
        stored.configOptions = res.configOptions;
        this.options.syncSessionFromOptions(this.get(sessionId), stored);
        const reported = res.configOptions.find(opt => opt.id === 'mode')?.currentValue;
        if (reported && reported !== mode) throw new Error('官方未确认切换到所选模式');
      } else cfgMode.currentValue = mode;
    } else if (legacyAdvertised) {
      await setLegacyMode();
    } else if (mode === 'full-access') {
      localTurbo = true;
      if (!this.options.localTurboSessions.has(sessionId)) {
        preferenceNotice = '当前官方 agy 会话未声明原生 full-access，已启用客户端本地 Turbo 直通模式。常规工具回调免弹窗，凭据、.gemini 受保护目录和系统级破坏防护仍然生效，需人工确认的高风险操作仍会提示。';
      }
    } else {
      if (this.get(sessionId).executionMode === 'full-access' && !this.options.localTurboSessions.has(sessionId)) throw new Error('官方 ACP 未声明所选模式，无法确认已退出原生 Turbo。');
      preferenceNotice = this.options.localTurboSessions.has(sessionId)
        ? `已退出客户端本地 Turbo，恢复常规审批。官方 ACP 未声明 ${mode} 模式，已保存为本地偏好。`
        : `官方 ACP 未声明 ${mode} 模式；已保存本地提示偏好，权限审查保持原设置。`;
    }
    this.assertConfigurationOwner(sessionId, stored);
    const session = this.get(sessionId);
    this.options.persistSettings({ ...session, executionMode: mode });
    session.executionMode = mode;
    if (localTurbo) this.options.localTurboSessions.add(sessionId);
    else this.options.localTurboSessions.delete(sessionId);
    this.publishSession(session);
    if (preferenceNotice) this.emit('localPreference', { sessionId, text: preferenceNotice });
    return { ...session };
  }

  async setSessionEffort(sessionId: string, effort: AgentReasoningEffort): Promise<ManagedSessionSummary> {
    if (!REASONING_EFFORT_ORDER.includes(effort)) throw new Error('无效的 Effort');
    if (!this.active.has(sessionId) || this.busy.has(sessionId)) throw new Error('请在活动会话空闲时修改 Effort');
    const stored = this.options.optionsBySession.get(sessionId);
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
      this.assertConfigurationOwner(sessionId, stored);
      if (res?.configOptions) stored.configOptions = res.configOptions;
      this.options.syncSessionFromOptions(session, stored, Boolean(res?.configOptions));
      const actual = stored.configOptions.find(option => option.id === 'thought_level')?.currentValue;
      if (actual !== effort) {
        if (!actual) throw new Error('官方未确认切换到所选推理强度');
        this.emit('localPreference', { sessionId, text: '官方未确认所选推理强度 ' + effort + '，当前档位为 ' + actual });
      }
      this.options.persistSettings(session);
      this.publishSession(session);
      return { ...session };
    }
    session.reasoningEffort = effort;
    this.options.persistSettings(session);
    this.emit('localPreference', {
      sessionId,
      text: `Effort ${effort} 已保存为本地提示偏好；当前 ACP 未声明独立的推理强度设置接口。`,
    });
    this.publishSession(session);
    return { ...session };
  }

  /** 只有活动且空闲的会话能改模型。优先采用 configOptions 的选项和值，旧版代理使用独立的 set_model。 */
  async setSessionModel(sessionId: string, modelId: string): Promise<ManagedSessionSummary> {
    if (!this.active.has(sessionId) || this.busy.has(sessionId)) throw new Error('请在活动会话空闲时修改 Model');
    const stored = this.options.optionsBySession.get(sessionId);
    const cfgModel = stored?.configOptions?.find((opt) => opt.id === 'model');
    const session = this.get(sessionId);
    if (!declaredModels(stored)?.some(model => model.modelId === modelId)) throw new Error('官方会话未声明此 Model 可用');
    if (cfgModel) {
      const res = await this.client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: modelId,
      });
      this.assertConfigurationOwner(sessionId, stored);
      if (res?.configOptions && stored) stored.configOptions = res.configOptions;
      this.options.syncSessionFromOptions(session, stored, Boolean(res?.configOptions));
      const actual = stored?.configOptions?.find(option => option.id === 'model')?.currentValue;
      if (actual !== modelId) {
        if (!actual) throw new Error('官方未确认切换到所选模型');
        this.emit('localPreference', { sessionId, text: '官方未确认所选模型 ' + modelId + '，当前模型为 ' + actual });
      }
      this.options.persistSettings(session);
      this.publishSession(session);
      return { ...session };
    }
    await this.client.request('session/set_model', { sessionId, modelId });
    this.assertConfigurationOwner(sessionId, stored);
    if (stored?.models) stored.models.currentModelId = modelId;
    session.modelId = modelId;
    this.publishSession(session);
    return { ...session };
  }
}
