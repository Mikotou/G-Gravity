import { randomUUID } from 'node:crypto';
import type { AcpRequestPermissionParams, AcpSessionUpdateNotification } from '../../shared/acp-protocol';
import type { ApprovalAuditEntry } from '../../shared/approval-contract';
import type { ChatMessageItem, ManagedSessionSummary } from '../../shared/session-contract';
import {
  isToolCallFailure, inspectStreamInterruption, isTransientStreamInterruptionLine,
  stripTransientStreamInterruptions,
} from '../../shared/session-contract';
import { QuestionFollowups } from './question-followups';
import { TurnActivity } from './turn-activity';
import { normalizePlan } from './session-plan';
import { HistoryReplay } from './history-replay';
import { AgentQuestions } from './agent-questions';
import { restoreAnnotatedMessage } from './annotation-prompt';
import { appendImage } from './message-images';
import { approvalConversationContext } from '../services/approval-coordinator';
import { buildDiagnosticBanner, type SessionDiagnosticBanner } from '../../shared/diagnostic-contract';
import { diagnosticDetail, disconnectDiagnostic } from '../services/session-diagnostics';
import type { TurnHost } from '../core-contracts';

export abstract class TurnStream {
  private profileGeneration = 0;
  private readonly textBatches = new Map<string, { message: ChatMessageItem; timer: NodeJS.Timeout }>();
  readonly recoveringHistory = new Map<string, HistoryReplay>();
  readonly sessionLifetimes = new Map<string, symbol>();
  readonly assistantMessages = new Map<string, ChatMessageItem>();
  // Elicitation splits the visible reply. Retain earlier segments until the enclosing turn settles.
  readonly questionSegments = new Map<string, ChatMessageItem[]>();
  readonly thoughtOwners = new Map<string, { sessionId: string; message: ChatMessageItem }>();
  readonly followups = new QuestionFollowups(() => this.app.messages, m => this.publishCommitted(m));
  readonly activity = new TurnActivity();
  private replayPlans = new Map<string, { profile: string; generation: number; latest?: ReturnType<typeof normalizePlan> }>();
  beginPlanReplay(id: string) {
    const replay = { profile: this.app.accounts.activeProfileId, generation: this.profileGeneration, latest: undefined as ReturnType<typeof normalizePlan> };
    this.replayPlans.set(id, replay);
    const current = () => this.replayPlans.get(id) === replay && replay.generation === this.profileGeneration && replay.profile === this.app.accounts.activeProfileId;
    return { current, commit: () => { if (current() && replay.latest) this.app.inspector.applyPlan(id, replay.latest); },
      discard: () => { if (this.replayPlans.get(id) === replay) this.replayPlans.delete(id); } };
  }
  private queueAnswer(message: ChatMessageItem): void {
    const profile = this.app.accounts.activeProfileId, id = message.sessionId;
    this.followups.add(message);
    if (!this.app.sessions.isBusy(id) && !this.promptOwners.has(id) && !this.reactiveWakeupActive.has(id)) {
      setImmediate(() => { if (profile === this.app.accounts.activeProfileId) this.sendQueuedReply(id); });
    }
  }
  readonly questions = new AgentQuestions((m, previous, followup) => {
    this.flushText(m.sessionId);
    if (previous) {
      this.app.messages.commitInteraction(m.sessionId, followup ? [m, followup] : [m], followup?.id);
    } else {
      if (m.question?.state === 'open') {
        this.activity.stamp(m);
        const beforeQuestion = this.assistantMessages.get(m.sessionId);
        if (beforeQuestion) {
          const segments = this.questionSegments.get(m.sessionId) || [];
          segments.push(beforeQuestion);
          this.questionSegments.set(m.sessionId, segments);
          this.finishAssistantMessage(m.sessionId);
        }
      }
      this.upsert(m);
      if (m.question?.state !== 'open') this.app.messages.save();
    }
  }, id => this.app.sessions.isActive(id), (_id, _text, message) => this.queueAnswer(message),
    id => this.refreshInteractionStatus(id), () => this.app.accounts.activeProfileId,
    (id, messageId) => this.app.messages.findMessage(id, messageId), question => this.queueAnswer(this.followups.retry(question)),
    (question, followup) => { this.publishCommitted(question); if (followup) this.publishCommitted(followup); });
  readonly feedback = new Map<string, string[]>();
  readonly reactiveWakeupActive = new Set<string>();
  readonly turnUserCancelled = new Set<string>();
  readonly turnStreamInterrupted = new Set<string>();
  readonly warningChunkStarts = new WeakMap<ChatMessageItem, { offset: number; separate: boolean }>();
  readonly promptOwners = new Map<string, AbortController>();
  readonly turnAutoDenied = new Map<string, Array<{ toolCallId?: string; toolName: string; command: string; reason: string }>>();
  readonly skipReplayedMessages = new Set<string>();
  readonly reactiveTurnTimers = new Map<string, NodeJS.Timeout>();
  readonly replayedUsers = new Map<string, ChatMessageItem>();
  readonly compactAvailable = new Set<string>();
  readonly lastToolReply = new Map<string, { contentLengthAtLastToolEnd: number; attachmentsAtLastToolEnd: number }>();
  readonly autoDeniedByToolCall = new Map<string, string>();
  readonly submitted = new Map<string, ChatMessageItem>();
  constructor(protected readonly app: TurnHost) {}
  protected abstract sendQueuedReply(id: string): void;
  isSessionTurnActive(id: string): boolean {
    const status = this.app.sessions.sessions.get(id)?.status;
    return this.app.sessions.isBusy(id) || this.app.sessions.isResuming(id) || this.promptOwners.has(id) ||
      this.reactiveWakeupActive.has(id) || status === 'waiting_question' || status === 'streaming' || status === 'waiting_approval';
  }
  bindEvents(): void {
    // 权限请求由代理反向发起。先确认会话仍激活，再把请求交给审批引擎等待决定。
    this.app.client.registerRequestHandler('elicitation/create', (raw, id) => this.questions.request(raw, id));
    this.app.client.on('$/cancel_request', ({ requestId } = {}) => {
      if (requestId === undefined) return;
      this.questions.cancel(undefined, requestId);
      this.app.approval.cancelPending(undefined, requestId);
    });
    this.app.client.registerRequestHandler('session/request_permission', (raw, rpcId) => {
      const params = raw as AcpRequestPermissionParams;
      if (!params?.sessionId || this.app.isEphemeral(params.sessionId) || !this.app.sessions.isActive(params.sessionId)) {
        return { outcome: { outcome: 'cancelled' } };
      }
      this.flushText(params.sessionId);
      return this.app.approval.requestPermission(
        params,
        this.app.sessions.get(params.sessionId).cwd,
        approvalConversationContext(this.app.messages.reviewContext(params.sessionId)),
        rpcId,
      );
    });
    this.app.client.on('disconnected', event => {
      const diagnostic = disconnectDiagnostic(this.app.client, event);
      try { this.releaseProfile(diagnostic); }
      catch (error) { this.app.emit('diagnostic', diagnosticDetail(error)); }
      this.app.approval.dispose();
      this.app.swarm.disconnected();
      this.app.publishConnection();
    });
    this.app.client.on('rateLimited', (warning: string) => {
      this.app.publishConnection();
      for (const session of this.app.sessions.sessions.values()) if (this.app.sessions.isActive(session.sessionId)) this.upsert({ id: randomUUID(), sessionId: session.sessionId, role: 'system', content: warning, createdAt: new Date().toISOString() });
    });
    this.app.sessions.on('session', (session: ManagedSessionSummary) => {
      if (this.app.sessions.isActive(session.sessionId)) this.app.approval.setSessionExecutionMode(session.sessionId, session.executionMode);
      const enriched = this.app.enrichSession(session);
      this.app.emit('session-updated', enriched);
      if (this.app.trees.hasTree(session.sessionId)) {
        this.app.treeUpdated(session.sessionId);
      }
    });
    this.app.sessions.on('update', (payload: AcpSessionUpdateNotification) => this.consumeUpdate(payload));
    this.app.sessions.on('localPreference', ({ sessionId, text }) => this.upsert({ id: randomUUID(), sessionId, role: 'system', content: text, createdAt: new Date().toISOString() }));
    this.app.sessions.on('cancelled', (id: string) => { this.questions.cancel(id); this.followups.failQueued(id); this.app.approval.cancelPending(id); this.feedback.delete(id); });
    this.app.sessions.on('closed', (id: string) => {
      this.app.swarm.markUnconfirmed(id, '会话已关闭', 'Session closed');
      this.releaseSession(id);
    });
    this.app.approval.on('requested', request => {
      this.flushText(request.sessionId);
      this.refreshInteractionStatus(request.sessionId);
      this.app.emit('approval-requested', request);
    });
    this.app.approval.on('resolved', payload => {
      if (this.app.sessions.isActive(payload.sessionId) && !this.app.approval.hasPendingForSession(payload.sessionId)) {
        this.refreshInteractionStatus(payload.sessionId);
      } else if (payload.grantsChanged && this.app.sessions.isActive(payload.sessionId)) {
        this.app.emit('session-updated', this.app.enrichSession(this.app.sessions.get(payload.sessionId)));
      }
      this.app.emit('approval-resolved', payload);
    });
    this.app.approval.on('feedback', ({ sessionId, text }) => {
      const list = this.feedback.get(sessionId) || []; list.push(text); this.feedback.set(sessionId, list);
      this.upsert({ id: randomUUID(), sessionId, role: 'system', content: `已拒绝操作。反馈将在当前执行结束后发送给智能体：${text}`, createdAt: new Date().toISOString() });
    });
    this.app.approval.on('audit', (entry: ApprovalAuditEntry) => {
      if (entry.verdict !== 'denied' || entry.decisionSource !== 'local-rule') return;
      const list = this.turnAutoDenied.get(entry.sessionId) || [];
      list.push({ toolCallId: entry.toolCallId, toolName: entry.toolName, command: entry.commandOrSummary, reason: entry.reason });
      this.turnAutoDenied.set(entry.sessionId, list);
      if (entry.toolCallId) {
        this.autoDeniedByToolCall.set(`${entry.sessionId}\0${entry.toolCallId}`, entry.reason);
        const message = this.turnMessages(entry.sessionId).find(m => m.toolCalls?.some(tc => tc.toolCallId === entry.toolCallId));
        const cards = message?.toolCalls;
        const index = cards?.findIndex(tc => tc.toolCallId === entry.toolCallId) ?? -1;
        if (cards && message && index >= 0) {
          const denied = this.app.inspector.consume(entry.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: entry.toolCallId }, cards[index], entry.reason);
          if (denied) cards[index] = denied;
          this.upsert(message);
        }
        this.lastToolReply.set(entry.sessionId, this.replyProgress(entry.sessionId));
      }
    });
    // Approve for me 仅通过本地规则与用户配置的外部 API 复核，严禁向蜂群拓扑伪造 @approval-guard 子个体节点。
    this.app.thoughts.on('block', block => {
      const owner = this.thoughtOwners.get(block.id); if (!owner) return;
      this.flushText(owner.sessionId);
      owner.message.thoughts = [block]; this.upsert(owner.message);
      if (!owner.message.isStreaming && !block.isStreaming && !block.isTranslating) {
        this.thoughtOwners.delete(block.id);
        this.app.thoughts.clear(block.id);
        if (this.assistantMessages.get(owner.sessionId) !== owner.message) this.app.messages.save();
      }
    });
  }
  upsert(message: ChatMessageItem, batchText = false): void {
    this.app.messages.upsert(message);
    if (!batchText) { this.flushText(message.sessionId); this.publishMessage(message); return; }
    const key = JSON.stringify([this.profileGeneration, message.sessionId, message.id]);
    if (this.textBatches.has(key)) return;
    const timer = setTimeout(() => {
      if (this.textBatches.delete(key)) this.publishMessage(message);
    }, 50);
    timer.unref();
    this.textBatches.set(key, { message, timer });
  }
  private flushText(id?: string): void {
    for (const [key, { message, timer }] of this.textBatches) {
      if (id !== undefined && message.sessionId !== id) continue;
      clearTimeout(timer);
      this.textBatches.delete(key);
      this.publishMessage(message);
    }
  }
  private publishCommitted(message: ChatMessageItem): void {
    // The RPC and retry state already belong to the durable transcript even if a view disconnects.
    try { this.publishMessage(message); } catch (error) { this.app.emit('diagnostic', diagnosticDetail(error)); }
  }
  private publishMessage(message: ChatMessageItem): void {
    if (message.isStreaming && !this.app.sessions.isResuming(message.sessionId)) this.app.messages.saveStreaming(message.sessionId);
    this.app.emit('message-upserted', { sessionId: message.sessionId, message: structuredClone(message) });
  }
  assistant(sessionId: string): ChatMessageItem {
    let message = this.assistantMessages.get(sessionId);
    if (!message) { const id = randomUUID(); message = { id, originMessageId: id, sessionId, role: 'assistant', content: '', isStreaming: true, createdAt: new Date().toISOString() }; this.activity.stamp(message); this.assistantMessages.set(sessionId, message); }
    return message;
  }
  clearTransientStreamWarning(sessionId: string, message: ChatMessageItem): boolean {
    if (!this.turnStreamInterrupted.has(sessionId)) return false;
    message.content = stripTransientStreamInterruptions(message.content);
    this.turnStreamInterrupted.delete(sessionId);
    return true;
  }

  appendAssistantText(sessionId: string, message: ChatMessageItem, text: string, live = true): void {
    const previous = message.content;
    let combined = previous + text;
    const interrupted = this.turnStreamInterrupted.has(sessionId);
    let candidate = this.warningChunkStarts.get(message);
    const tailLength = Math.min(previous.length, 5);
    const marker = /⚠|Error:/i.exec(previous.slice(previous.length - tailLength) + text);
    const markerFragment = /^E(?:r(?:r(?:o)?)?)?$/i.test(text);
    if (!interrupted && !candidate && !marker && !markerFragment) {
      message.content = combined;
      if (live) this.app.telemetry.addChunk(sessionId, text);
      return;
    }
    // A service notice may start a separate ACP chunk directly after partial reply text.
    // Wait for the complete line before inserting a separator so ordinary warning symbols retain their formatting.
    if ((!candidate && (marker || markerFragment)) || /^(?:⚠|Error:)/i.test(text)) {
      const offset = /^(?:⚠|Error:)/i.test(text) || !marker ? previous.length : previous.length - tailLength + marker.index;
      const separate = offset === previous.length && !!previous && !/[\n:：\x60>"“「]\s*$/.test(previous);
      candidate = { offset, separate };
      this.warningChunkStarts.set(message, candidate);
    }
    if (candidate) {
      const firstLine = combined.slice(candidate.offset, candidate.offset + 161).split(/\r?\n/, 1)[0];
      if (isTransientStreamInterruptionLine(firstLine)) {
        if (candidate.separate) {
          const separated = combined.slice(0, candidate.offset) + '\n' + combined.slice(candidate.offset);
          if (inspectStreamInterruption(separated).found) combined = separated;
        }
        this.warningChunkStarts.delete(message);
      } else {
        const lineEnded = combined.indexOf('\n', candidate.offset) >= 0;
        if (firstLine.length >= 160 || lineEnded || !/^(?:⚠|E(?:r(?:r(?:o(?:r:)?)?)?)?)/i.test(firstLine)) {
          this.warningChunkStarts.delete(message);
        }
        if (!lineEnded && !interrupted) {
          message.content = combined;
          if (live) this.app.telemetry.addChunk(sessionId, text);
          return;
        }
      }
    }
    let warning = inspectStreamInterruption(combined);
    if (interrupted && text.trim() && !warning.found) {
      // The next real chunk need not include a newline after a complete notice.
      const lastLine = combined.slice(combined.lastIndexOf('\n') + 1).trim().replace(/^⚠\uFE0F?\s*/, '').toLowerCase();
      if ('the stream was interrupted. please continue the task you were working on.'.startsWith(lastLine)) {
        message.content = combined;
        return;
      }
      combined = stripTransientStreamInterruptions(previous) + text;
      warning = inspectStreamInterruption(combined);
    }
    message.content = warning.trailing ? combined : warning.content;
    if (warning.trailing) this.turnStreamInterrupted.add(sessionId);
    else this.turnStreamInterrupted.delete(sessionId);
    if (live) {
      if (warning.found || interrupted) this.app.telemetry.addChunk(sessionId, warning.content, 'agentMessagesTokens', true);
      else this.app.telemetry.addChunk(sessionId, text);
    }
  }
  /** 按 ACP 更新类型合并增量。回复正文、思考、工具状态和用量共享 sessionId，各自维护自己的累计方式。 */
  consumeUpdate({ sessionId, update }: AcpSessionUpdateNotification): void {
    if (this.app.disposed || this.app.isEphemeral(sessionId)) return;
    const pureText = update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string';
    if (!pureText) this.flushText(sessionId);
    const replaying = this.app.sessions.isResuming(sessionId) || this.replayPlans.has(sessionId);
    if (replaying) {
      this.app.swarm.consume(sessionId, update, true);
      this.recoveringHistory.get(sessionId)?.consume(update);
    }
    if (replaying && update.sessionUpdate === 'plan' && this.skipReplayedMessages.has(sessionId)) {
      const replay = this.replayPlans.get(sessionId);
      const latest = normalizePlan(update.entries);
      if (replay && latest) replay.latest = latest;
      return;
    }
    if (replaying && this.skipReplayedMessages.has(sessionId) &&
        !['available_commands_update', 'current_mode_update', 'config_option_update'].includes(update.sessionUpdate)) return;
    if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'plan'].includes(update.sessionUpdate)) {
      this.finishReplayedUser(sessionId);
    }
    const text = update.content?.text || '';
    if (update.sessionUpdate === 'available_commands_update') {
      const commands = (update as unknown as { availableCommands?: Array<{ name: string }> }).availableCommands;
      if (Array.isArray(commands)) {
        if (commands.some(command => command.name === 'compact')) this.compactAvailable.add(sessionId);
        else this.compactAvailable.delete(sessionId);
      }
    }
    if (update.sessionUpdate === 'usage_update') {
      if (typeof update.used === 'number' || typeof update.size === 'number') {
        this.app.telemetry.applyContextWindow(sessionId, update.used, update.size);
      }
      if (!replaying && update.usage) this.app.telemetry.applyUsage(sessionId, update.usage);
      if (!replaying) this.app.maybeSyncSessionCheckpointWindow(sessionId);
      if (this.reactiveWakeupActive.has(sessionId)) {
        this.scheduleReactiveTurnSettle(sessionId, true);
      }
    }
    // 后台子个体完成触发的服务端主动唤醒回合（!isBusy）：同步归档子个体状态并在输出收敛后自动收口流式光标
    const todos = update.sessionUpdate === 'plan'
      ? this.app.inspector.consume(sessionId, { ...update, sessionUpdate: 'plan' }) : undefined;
    if (update.sessionUpdate === 'plan' && !todos) return;
    const isReactiveAgentUpdate =
      !replaying && !this.app.sessions.isBusy(sessionId) &&
      ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate);
    if (isReactiveAgentUpdate && !this.reactiveWakeupActive.has(sessionId)) {
      this.activity.begin(sessionId);
      this.reactiveWakeupActive.add(sessionId);
      this.app.telemetry.ensure(sessionId, this.app.sessions.sessions.get(sessionId)?.modelId);
      this.app.telemetry.beginTurn(sessionId, '');
      this.resetTurnState(sessionId);
      if (this.app.sessions.isActive(sessionId)) this.app.sessions.setStatus(sessionId, 'streaming');
      this.refreshInteractionStatus(sessionId);
    }

    if (todos) {
      if (!replaying && todos.length >= 2) this.app.approval.enableBurstGuard(sessionId);
      const message = this.assistant(sessionId);
      this.clearTransientStreamWarning(sessionId, message);
      message.todos = todos;
      this.upsert(message);
    }
    if (update.sessionUpdate === 'user_message_chunk') {
      if (replaying) {
        this.finishAssistantMessage(sessionId);
        const message = this.replayedUsers.get(sessionId) || { id: randomUUID(), sessionId, role: 'user', content: '', createdAt: new Date().toISOString() };
        message.content += text;
        appendImage(message, update.content, this.app.mediaContext);
        this.replayedUsers.set(sessionId, message);
        return;
      }
      // Our outgoing turn was already published with the user's structured annotations.
      if (this.app.sessions.isBusy(sessionId)) return;
      const items = this.app.messages.recent(sessionId); const previous = items.at(-1);
      const message: ChatMessageItem = previous?.role === 'user' && previous.isStreaming ? previous : { id: randomUUID(), sessionId, role: 'user', content: '', isStreaming: true, createdAt: new Date().toISOString() };
      appendImage(message, update.content, this.app.mediaContext);
      message.content += text; this.upsert(message); return;
    }
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const message = this.assistant(sessionId);
      if (update.sessionUpdate === 'agent_message_chunk') {
        this.completeStreamingThoughts(message);
        appendImage(message, update.content, this.app.mediaContext);
        if (update.content?.type === 'image') this.clearTransientStreamWarning(sessionId, message);
        if (text) this.appendAssistantText(sessionId, message, text, !replaying);
      } else {
        if (text.trim()) this.clearTransientStreamWarning(sessionId, message);
        const id = `${message.id}:thought`;
        this.thoughtOwners.set(id, { sessionId, message });
        const prev = message.thoughts?.[0];
        const prefix = prev && !prev.isStreaming && prev.originalText && !prev.originalText.endsWith('\n') && !text.startsWith('\n') ? '\n\n' : '';
        this.app.thoughts.append(id, prefix + text);
        if (!replaying) this.app.telemetry.addChunk(sessionId, text, 'thoughtTokens');
      }
      if (update.sessionUpdate === 'agent_message_chunk') this.upsert(message, pureText);
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (!replaying) this.app.swarm.consume(sessionId, update);
      if (!update.toolCallId) return;
      const earlier = update.sessionUpdate === 'tool_call_update' && this.questionSegments.get(sessionId)
        ?.find(segment => segment.toolCalls?.some(card => card.toolCallId === update.toolCallId));
      const message = earlier || this.assistant(sessionId);
      this.completeStreamingThoughts(message);
      // 工具创建和后续状态通知共用 toolCallId。传入旧卡片以保留增量更新里省略的字段。
      const cards = message.toolCalls ||= [];
      const index = cards.findIndex(card => card.toolCallId === update.toolCallId);
      const toolResults = Array.isArray(update.content) ? update.content : update.toolContent || [];
      for (const result of toolResults) appendImage(message, result, this.app.mediaContext);
      const previous = cards[index];
      const denyReason = this.autoDeniedByToolCall.get(sessionId + '\0' + update.toolCallId);
      const card = this.app.inspector.consume(sessionId, update, previous, denyReason);
      if (card) {
        if (!denyReason && card.status === 'failed' && !card.outputPreview && this.turnAutoDenied.get(sessionId)?.length) {
          card.outputPreview = '因同批次其他命令触发本地安全策略拦截，此并行命令被一并取消';
        }
        if (!replaying && (!previous || (!previous.completedAt && card.completedAt) ||
            (!isToolCallFailure(previous) && isToolCallFailure(card)))) {
          this.lastToolReply.set(sessionId, this.replyProgress(sessionId));
        }
        if (index >= 0) cards[index] = card; else cards.push(card);
        if (update.sessionUpdate === 'tool_call' || (card.status !== 'failed' && card.status !== 'rejected')) {
          this.clearTransientStreamWarning(sessionId, message);
        }
      }
      if (!replaying && update.sessionUpdate === 'tool_call') {
        this.app.maybeSyncSessionCheckpointWindow(sessionId);
      }
      if (!replaying && card) this.app.telemetry.updateTool(sessionId, update.toolCallId, card.argsSummary, card.outputPreview ?? '');
      this.upsert(message);
    }
    if (isReactiveAgentUpdate) {
      this.scheduleReactiveTurnSettle(sessionId, false);
    }
  }
  refreshInteractionStatus(id: string): void {
    if (this.app.disposed || !this.app.sessions.isActive(id)) return;
    if (this.questions.hasOpen(id)) {
      this.app.sessions.setStatus(id, 'waiting_question', buildDiagnosticBanner('waiting_question'));
    } else if (this.app.approval.hasPendingForSession(id)) {
      this.app.sessions.setStatus(id, 'waiting_approval', buildDiagnosticBanner('waiting_approval'));
    } else {
      if (this.app.sessions.get(id).status === 'error') return;
      const generating = this.app.sessions.isBusy(id) || this.reactiveWakeupActive.has(id);
      this.app.sessions.setStatus(id, generating ? 'streaming' : 'idle');
      if (this.reactiveWakeupActive.has(id)) this.scheduleReactiveTurnSettle(id, false);
    }
  }
  clearReactiveTurnTimer(sessionId: string): void {
    const timer = this.reactiveTurnTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reactiveTurnTimers.delete(sessionId);
    }
    if (this.reactiveWakeupActive.delete(sessionId)) this.app.telemetry.endTurn(sessionId);
  }
  /**
   * 服务端主动唤醒产生的回复没有本地 prompt 等待点，通过静默计时收尾。
   * 审批挂起时暂停收尾，计时到期再检查工具状态。
   */
  scheduleReactiveTurnSettle(sessionId: string, usageArrived: boolean): void {
    const prev = this.reactiveTurnTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const activeMsg = this.assistantMessages.get(sessionId);
    const hasPendingTool = Boolean(
      activeMsg?.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')
    );
    const hasPendingApproval = this.app.approval.hasPendingForSession(sessionId);
    if (hasPendingApproval || this.questions.hasOpen(sessionId)) {
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
      if (!this.app.sessions.isActive(sessionId) || !this.reactiveWakeupActive.has(sessionId) || this.app.sessions.isBusy(sessionId)) return;
      const currentMsg = this.assistantMessages.get(sessionId);
      const stillRunningTool = Boolean(
        currentMsg?.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')
      );
      if (stillRunningTool || this.app.approval.hasPendingForSession(sessionId)) {
        this.scheduleReactiveTurnSettle(sessionId, false);
        return;
      }
      const stop = this.turnStop(sessionId);
      this.clearReactiveTurnTimer(sessionId);
      try { this.finishMessage(sessionId, stop); }
      catch (error) { this.app.emit('diagnostic', diagnosticDetail(error)); }
      if (this.app.sessions.isActive(sessionId) && this.app.sessions.get(sessionId).status === 'streaming') {
        this.app.sessions.setStatus(sessionId, 'idle');
      }
      this.app.syncSessionCheckpointWindow(sessionId);
      this.sendQueuedReply(sessionId);
    }, delayMs);
    timer.unref?.();
    this.reactiveTurnTimers.set(sessionId, timer);
  }
  completeStreamingThoughts(message: ChatMessageItem): void {
    if (!message.thoughts?.length) return;
    message.thoughts = message.thoughts.map(block => (block.isStreaming ? this.app.thoughts.complete(block.id) || block : block));
  }
  finishReplayedUser(sessionId: string): void {
    const message = this.replayedUsers.get(sessionId);
    if (message) {
      this.replayedUsers.delete(sessionId);
      this.upsert(restoreAnnotatedMessage(message));
    }
  }
  prepareDisconnect(): void {
    for (const owner of this.promptOwners.values()) owner.abort(new Error('连接正在关闭'));
    this.questions.cancel();
    this.followups.failQueued();
    this.feedback.clear();
    this.app.approval.dispose();
  }
  releaseProfile(stop?: SessionDiagnosticBanner): void {
    const ids = new Set([...this.sessionLifetimes.keys(), ...this.promptOwners.keys(), ...this.assistantMessages.keys(),
      ...this.questionSegments.keys(), ...this.reactiveTurnTimers.keys(), ...this.reactiveWakeupActive,
      ...this.submitted.keys(), ...this.feedback.keys(), ...this.followups.sessions(), ...this.replayPlans.keys(), ...this.compactAvailable,
      ...this.turnAutoDenied.keys(), ...this.turnUserCancelled, ...this.recoveringHistory.keys(), ...this.replayedUsers.keys(),
      ...Array.from(this.thoughtOwners.values(), owner => owner.sessionId)]);
    const errors: unknown[] = [];
    for (const id of ids) {
      try { this.releaseSession(id, stop); } catch (error) { errors.push(error); }
    }
    this.activity.clear();
    this.flushText();
    this.profileGeneration++;
    this.questions.cancel();
    if (errors.length) throw errors[0];
  }
  releaseSession(id: string, stop?: SessionDiagnosticBanner): void {
    try {
      this.promptOwners.get(id)?.abort(new Error('会话已关闭'));
      this.promptOwners.delete(id);
      this.sessionLifetimes.delete(id);
      this.questions.cancel(id);
      this.app.approval.cancelSession(id);
      const submitted = this.submitted.get(id);
      const reactive = this.reactiveWakeupActive.has(id);
      this.clearReactiveTurnTimer(id);
      this.app.telemetry.cancelManualCompaction(id);
      if (!reactive) this.app.telemetry.endTurn(id);
      if (stop && submitted && !submitted.questionFollowup && !this.hasPostToolSubstantiveReply(id)) {
        submitted.sendFailed = true;
        this.upsert(submitted);
      }
      this.clearSessionThoughts(id);
      if (submitted || this.assistantMessages.has(id) || this.questionSegments.has(id)) this.finishMessage(id, stop);
    } finally {
      this.activity.clear(id);
      this.submitted.delete(id);
      this.assistantMessages.delete(id);
      this.questionSegments.delete(id);
      this.compactAvailable.delete(id);
      this.recoveringHistory.delete(id);
      this.replayedUsers.delete(id);
      this.skipReplayedMessages.delete(id);
      this.feedback.delete(id);
      this.followups.end(id);
      this.replayPlans.delete(id);
      this.resetTurnState(id);
    }
  }
  clearSessionThoughts(id: string): void {
    for (const [key, owner] of this.thoughtOwners) {
      if (owner.sessionId !== id) continue;
      this.thoughtOwners.delete(key);
      this.app.thoughts.clear(key);
      for (const block of owner.message.thoughts || []) { block.isStreaming = false; block.isTranslating = false; }
    }
  }
  finishAssistantMessage(sessionId: string): void {
    this.flushText(sessionId);
    const message = this.assistantMessages.get(sessionId);
    if (message) {
      message.isStreaming = false;
      message.completedAt ??= new Date().toISOString();
      this.assistantMessages.delete(sessionId);
      const streaming = message.thoughts?.filter(block => block.isStreaming) ?? [];
      if (streaming.length) for (const block of streaming) this.app.thoughts.complete(block.id);
      else {
        for (const block of message.thoughts || []) if (!block.isTranslating) {
          this.thoughtOwners.delete(block.id);
          this.app.thoughts.clear(block.id);
        }
        this.upsert(message);
      }
    }
  }
  resetTurnState(id: string): void {
    this.turnUserCancelled.delete(id);
    this.turnStreamInterrupted.delete(id);
    this.turnAutoDenied.delete(id);
    this.lastToolReply.delete(id);
    for (const key of this.autoDeniedByToolCall.keys()) if (key.startsWith(id + '\0')) this.autoDeniedByToolCall.delete(key);
  }
  turnMessages(id: string): ChatMessageItem[] {
    const earlier = this.questionSegments.get(id) ?? [];
    const current = this.assistantMessages.get(id);
    return current ? [...earlier, current] : earlier;
  }
  replyProgress(id: string) {
    let contentLengthAtLastToolEnd = 0;
    let attachmentsAtLastToolEnd = 0;
    for (const message of this.turnMessages(id)) {
      contentLengthAtLastToolEnd += stripTransientStreamInterruptions(message.content).trim().length;
      attachmentsAtLastToolEnd += message.attachments?.length ?? 0;
    }
    return { contentLengthAtLastToolEnd, attachmentsAtLastToolEnd };
  }
  hasPostToolSubstantiveReply(id: string): boolean {
    const current = this.replyProgress(id);
    const atTool = this.lastToolReply.get(id);
    return current.contentLengthAtLastToolEnd > (atTool?.contentLengthAtLastToolEnd ?? 0) ||
      current.attachmentsAtLastToolEnd > (atTool?.attachmentsAtLastToolEnd ?? 0);
  }
  turnStop(id: string, reason?: string): SessionDiagnosticBanner | undefined {
    if (this.turnUserCancelled.has(id)) return buildDiagnosticBanner('user_cancelled', { stopReason: 'cancelled' });
    if (!this.hasPostToolSubstantiveReply(id)) {
      if (this.turnAutoDenied.get(id)?.length) return buildDiagnosticBanner('policy_blocked', { stopReason: reason });
      if (this.turnMessages(id).some(m => m.toolCalls?.some(isToolCallFailure))) return buildDiagnosticBanner('tool_failure_stopped', { stopReason: reason });
    }
    if (reason === 'max_tokens' || reason === 'refusal') return buildDiagnosticBanner(reason, { stopReason: reason });
    if (this.turnStreamInterrupted.has(id)) return buildDiagnosticBanner('stream_interrupted', { stopReason: reason });
    if (reason === 'cancelled') return buildDiagnosticBanner('user_cancelled', { stopReason: reason });
    if (reason && reason !== 'end_turn') return buildDiagnosticBanner('unknown_error', { stopReason: diagnosticDetail(reason) });
  }
  protected settleActivity(id: string): void {
    this.activity.settle(id, this.app.messages, m => this.publishMessage(m));
  }
  finishMessage(sessionId: string, stop?: SessionDiagnosticBanner, settle = true): void {
    this.flushText(sessionId);
    const segments = this.questionSegments.get(sessionId) || [];
    this.questionSegments.delete(sessionId);
    if (stop) {
      const last = this.assistantMessages.get(sessionId) || segments.at(-1) || this.assistant(sessionId);
      last.turnStop = stop;
      const status = stop.code === 'user_cancelled' || stop.code === 'policy_blocked' ? 'rejected' : 'failed';
      for (const message of new Set([...segments, last])) {
        for (const [i, card] of (message.toolCalls || []).entries()) {
          if (card.status !== 'pending' && card.status !== 'running') continue;
          const settled = this.app.inspector.consume(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: card.toolCallId, status }, card);
          if (settled) message.toolCalls![i] = settled;
        }
        if (message !== this.assistantMessages.get(sessionId)) this.upsert(message);
      }
    }
    this.finishAssistantMessage(sessionId);
    this.app.approval.resetTurnBurstCounter(sessionId);
    for (const item of this.app.messages.recent(sessionId)) item.isStreaming = false;
    if (settle) this.settleActivity(sessionId);
    this.app.messages.save();
    this.app.inspector.flush();
    this.app.sessions.flush();
  }
}
