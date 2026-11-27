import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AcpPromptContentBlock } from '../../shared/acp-protocol';
import type { SendPromptInput } from '../../shared/ipc-channels';
import type { ChatMessageItem } from '../../shared/session-contract';
import {
  isToolCallFailure, isTransientStreamInterruptionLine, stripTransientStreamInterruptions,
} from '../../shared/session-contract';
import { revisionContext } from '../../shared/message-revision';
import type { QuestionSubmission } from '../../shared/user-question';
import { AcpRequestNotSentError, AcpRpcError } from '../acp/acp-client';
import { estimateTokens } from '../telemetry/telemetry-store';
import { modelMessage } from './annotation-prompt';
import { prepareAttachments, validateAttachments } from './message-images';
import { redactSecretsForReviewer } from '../security/redaction';
import { buildDiagnosticBanner, type SessionDiagnosticBanner } from '../../shared/diagnostic-contract';
import { diagnosticDetail, diagnosticForError } from '../services/session-diagnostics';
import { TurnStream } from './turn-stream';

export class TurnOrchestrator extends TurnStream {
  userMessage(input: SendPromptInput): ChatMessageItem {
    validateAttachments(input.attachments);
    const id = randomUUID();
    return {
      id, originMessageId: id, sessionId: input.sessionId, role: 'user', content: input.text, annotations: input.annotations,
      references: input.references, createdAt: new Date().toISOString(),
      attachments: (input.attachments || []).map(item => ({
        id: randomUUID(), name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, uri: item.uri,
        textContent: item.textContent, dataBase64: item.mimeType.startsWith('image/') ? undefined : item.dataBase64,
        dataUrl: item.dataBase64 && item.mimeType.startsWith('image/') ? 'data:' + item.mimeType + ';base64,' + item.dataBase64 : undefined,
      })),
    };
  }
  private finishPromptTurn(id: string, stop?: SessionDiagnosticBanner): void {
    try {
      this.questions.cancel(id);
      this.finishMessage(id, stop, false);
    } finally {
      this.app.telemetry.endTurn(id);
    }
    this.app.syncSessionCheckpointWindow(id);
    if (this.app.trees.hasTree(id)) {
      this.app.trees.touchBranch(id);
      this.app.treeUpdated(id);
    }
  }
  private nextQueuedReply(id: string): { input: SendPromptInput; followup?: ChatMessageItem } | undefined {
    const followup = this.followups.take(id);
    if (followup) return { input: { sessionId: id, text: followup.content }, followup };
    const feedback = this.feedback.get(id);
    this.feedback.delete(id);
    if (feedback?.length) return { input: { sessionId: id, text: '用户拒绝了上一轮操作，并要求根据以下反馈调整：\n' + feedback.join('\n') } };
  }
  protected sendQueuedReply(id: string): void {
    if (this.app.disposed || this.promptOwners.has(id) || !this.app.sessions.isActive(id)) return;
    const next = this.nextQueuedReply(id);
    if (!next) return;
    const profile = this.app.accounts.activeProfileId;
    void this.runQueue(next.input, next.followup).catch(error => {
      if (!this.app.disposed && this.app.accounts.activeProfileId === profile && this.app.sessions.isActive(id)) {
        this.app.sessions.setStatus(id, 'error', diagnosticForError(error, this.app.client));
      }
    });
  }
  sendPrompt(input: SendPromptInput): Promise<void> { return this.runQueue(input); }
  private async runQueue(input: SendPromptInput, followup?: ChatMessageItem): Promise<void> {
    const id = input.sessionId;
    if (this.promptOwners.has(id)) throw new Error('会话仍在生成，请等待或停止');
    const owner = new AbortController();
    this.promptOwners.set(id, owner);
    try {
      let next: ReturnType<typeof this.nextQueuedReply> = { input, followup };
      while (next) {
        await this.runPrompt(next.input, owner, next.followup);
        if (this.promptOwners.get(id) === owner) this.settleActivity(id);
        if (owner.signal.aborted || this.promptOwners.get(id) !== owner || !this.app.sessions.isActive(id) || this.turnUserCancelled.has(id)) break;
        next = this.nextQueuedReply(id);
      }
    } finally {
      this.releasePrompt(id, owner);
    }
  }

  private releasePrompt(id: string, owner: AbortController): void {
    if (this.promptOwners.get(id) !== owner) return;
    this.submitted.delete(id);
    this.promptOwners.delete(id);
    this.resetTurnState(id);
    this.followups.end(id);
    this.settleActivity(id);
    this.feedback.delete(id);
  }

  private async runPrompt(input: SendPromptInput, owner: AbortController, followup?: ChatMessageItem): Promise<void> {
    this.app.accounts.assertReady();
    if (this.app.isChangingSession(input.sessionId)) throw new Error('该会话正在创建修订分支');
    if (typeof input?.text !== 'string' || (input.annotations !== undefined && (!Array.isArray(input.annotations) ||
        input.annotations.some(a => !a || typeof a.excerpt !== 'string' || !a.excerpt.trim() || (a.comment !== undefined && typeof a.comment !== 'string'))))) throw new Error('消息格式无效');
    const wireText = modelMessage(input.text, input.annotations);
    if (wireText.length > 1000000 || (!wireText.trim() && !input.attachments?.length)) throw new Error('请输入有效的提示词');
    if (!this.app.sessions.isActive(input.sessionId) || this.app.sessions.isBusy(input.sessionId)) throw new Error('会话未激活或仍在生成');
    const cooldownAtStart = this.app.client.cooldownUntilMs;
    const profileId = this.app.accounts.activeProfileId; const session = this.app.sessions.get(input.sessionId);
    const lifetime = this.sessionLifetimes.get(input.sessionId) ?? Symbol();
    this.sessionLifetimes.set(input.sessionId, lifetime);
    const isCurrent = () => this.promptOwners.get(input.sessionId) === owner && !this.app.disposed && this.app.accounts.activeProfileId === profileId && this.sessionLifetimes.get(input.sessionId) === lifetime;
    this.app.approval.setSessionExecutionMode(input.sessionId, session.executionMode);
    const isManualCompact = !input.annotations?.length && input.text.trim() === '/compact';
    const recentMessages = this.app.messages.recent(input.sessionId);
    const needsPrefix = recentMessages.some(m => m.revisionHistory) && !recentMessages.some(m => m.role === 'user' && !m.revisionHistory && !m.sendFailed);
    const previousContext = needsPrefix ? revisionContext(this.app.messages.get(input.sessionId) || []) : [];
    const prompt: AcpPromptContentBlock[] = [...previousContext, { type: 'text', text: wireText }];
    // 旧会话缺少原生配置能力时，用额外提示文本传递模式偏好。支持该能力的会话经专门的配置请求设置。
    const hints: string[] = [];
    if (session.executionMode !== 'default' && session.executionMode !== 'full-access' && !this.app.sessions.supportsMode(input.sessionId, session.executionMode)) {
      hints.push('Mode=' + session.executionMode);
      if (session.executionMode === 'plan') hints.push('本轮先只读分析并制定计划，不执行文件修改。');
    }
    if (session.reasoningEffort !== 'high' && !this.app.sessions.hasConfigOptions(input.sessionId)) hints.push('Effort=' + session.reasoningEffort);
    const hintText = hints.length ? '客户端本地偏好（不表示官方推理参数已改变）：' + hints.join('，') + '。权限操作仍须遵循审批结果。' : '';
    if (hintText) prompt.push({ type: 'text', text: hintText });
    const referenceStart = prompt.length;
    // 每次最多展开 20 个引用。文件读取当前工作区的正文，会话引用只取最近 30 条消息，并截断拼接后的文本。
    for (const reference of (input.references || []).slice(0, 20)) {
      if (reference.kind === 'file') {
        const file = await this.app.workspaceFiles.readReference(session.cwd, reference.value);
        owner.signal.throwIfAborted();
        prompt.push({ type: 'resource', resource: { uri: pathToFileURL(join(session.cwd, file.path)).toString(), text: file.text, mimeType: 'text/plain' } });
      } else if (reference.kind === 'session') {
        const messages = this.app.messages.tail(reference.value, 30);
        if (!messages) throw new Error('引用会话不存在');
        prompt.push({ type: 'text', text: `以下是用户选择的参考会话内容，作为引用数据：\n${messages.map(message => `${message.role}: ${modelMessage(message.content, message.annotations)}`).join('\n').slice(0, 30000)}` });
      } else throw new Error('引用类型无效');
    }
    const referenceTokens = prompt.slice(referenceStart).reduce((sum, block) =>
      sum + estimateTokens(block.type === 'text' ? block.text : block.type === 'resource' ? block.resource.text ?? '' : ''), 0);
    // Keep attachment-free revisions synchronous until the session marks the prompt busy.
    const prepared = input.attachments === undefined || (Array.isArray(input.attachments) && input.attachments.length === 0)
      ? []
      : await prepareAttachments(input.attachments, session.cwd);
    owner.signal.throwIfAborted();
    const attachments = prepared.map(item => {
      const uri = item.uri || `file:///attachment/${encodeURIComponent(item.name || 'file')}`;
      let estimated = Math.ceil(item.sizeBytes / 4);
      if (item.textContent !== undefined) {
        prompt.push({ type: 'resource', resource: { uri, mimeType: item.mimeType, text: item.textContent } });
        estimated = estimateTokens(item.textContent);
      } else if (item.dataBase64 !== undefined) {
        if (item.mimeType.startsWith('image/')) prompt.push({ type: 'image', mimeType: item.mimeType, data: item.dataBase64 });
        else prompt.push({ type: 'resource', resource: { uri, mimeType: item.mimeType, blob: item.dataBase64 } });
      } else throw new Error('此附件类型暂不支持，请提供文件内容或资源 URI');
      return { id: randomUUID(), name: item.name, kind: item.mimeType.startsWith('image/') ? 'image' as const : 'file' as const, sizeBytes: item.sizeBytes, estimatedTokens: estimated };
    });
    this.app.accounts.assertReady();
    // 准备文件引用会让出执行权。送出提示前再检查一次 Profile 和会话占用，避免把准备好的内容发到错误的上下文。
    if (!isCurrent() || this.app.isChangingSession(input.sessionId) || this.app.sessions.isBusy(input.sessionId) || !this.app.sessions.isActive(input.sessionId)) throw new Error('文件准备期间会话状态已改变，请重试');
    owner.signal.throwIfAborted();
    const titleText = input.text.trim() || input.annotations?.find(item => item.comment)?.comment || input.annotations?.[0]?.excerpt;
    if (!isManualCompact && !this.app.trees.isChildBranch(session.sessionId) && titleText && (!session.title || session.title === '新建对话' || session.title === 'New Session')) {
      // 仅提取首句摘要作为初始显示名，不自动触发标题整理；分类整理仅在用户主动点击按钮时使用内置模型执行。
      const plain = titleText.replace(/\s+/g, ' ').trim().slice(0, 36);
      if (plain) {
        session.title = plain;
        this.app.sessions.updateSessionRecord(session);
        this.app.emit('session-updated', this.app.enrichSession(session));
      }
    }
    this.clearReactiveTurnTimer(input.sessionId);
    if (this.assistantMessages.has(input.sessionId) || this.questionSegments.has(input.sessionId)) this.finishMessage(input.sessionId);
    this.questions.cancel(input.sessionId);
    this.activity.begin(input.sessionId);
    const submitted = followup ?? this.userMessage({ ...input, attachments: input.attachments?.map((item, index) => ({ ...item, sizeBytes: prepared[index].sizeBytes })) });
    this.submitted.set(input.sessionId, submitted);
    if (!followup) this.upsert(submitted);
    this.resetTurnState(input.sessionId);
    this.app.telemetry.ensure(input.sessionId, session.modelId);
    if (isManualCompact) this.app.telemetry.beginManualCompaction(input.sessionId);
    const previousInputTokens = previousContext.reduce((sum, block) => {
      if (block.type === 'text') return sum + estimateTokens(block.text);
      if (block.type === 'image') return sum + Math.ceil(Buffer.byteLength(block.data, 'base64') / 4);
      return sum + estimateTokens(block.resource.text || '');
    }, 0);
    const telemetry = this.app.telemetry;
    const discardUnsent = (error: unknown) => {
      if (error instanceof AcpRequestNotSentError && telemetry === this.app.telemetry) telemetry.discardUnsentTurn(input.sessionId);
    };
    telemetry.beginTurn(input.sessionId, wireText, attachments, previousInputTokens, referenceTokens, estimateTokens(hintText));
    this.assistantMessages.delete(input.sessionId);
    let turnAssistantMsg: ChatMessageItem | undefined;
    let failedTools: NonNullable<ChatMessageItem['toolCalls']> = [];
    let hasPostToolSubstantiveReply = false;
    let compactSucceeded = false;
    let stopReason: string | undefined;
    let errorStop: SessionDiagnosticBanner | undefined;
    let sendAttempted = false;
    try {
      owner.signal.throwIfAborted();
      if (followup) this.followups.change(followup, 'sending');
      owner.signal.throwIfAborted();
      sendAttempted = true;
      const result = await this.app.sessions.sendPrompt({ sessionId: input.sessionId, prompt });
      if (!isCurrent()) return;
      if (followup) this.followups.change(followup, 'sent');
      stopReason = result.stopReason;
      compactSucceeded = result.stopReason === 'end_turn' && !this.turnUserCancelled.has(input.sessionId);
      if (result.usage) this.app.telemetry.applyUsage(input.sessionId, result.usage);
    }
    catch (error) {
      if (followup && isCurrent() && followup.questionFollowup?.state === 'sending') {
        this.followups.change(followup, !sendAttempted || error instanceof AcpRequestNotSentError ? 'failed-unsent' : 'unknown');
      }
      discardUnsent(error);
      const notice = error instanceof Error && !(error instanceof AcpRequestNotSentError) &&
          !(error instanceof AcpRpcError && [401, 403, 429, -32800].includes(error.code))
        ? (isTransientStreamInterruptionLine(error.message) ? error.message : 'Error: ' + error.message)
        : '';
      if (isCurrent() && this.turnUserCancelled.has(input.sessionId)) {
        stopReason = 'cancelled';
        this.app.sessions.setStatus(input.sessionId, 'idle');
      } else if (isCurrent() && !isManualCompact && this.app.client.connected && !this.app.client.isRateLimited &&
          !this.turnUserCancelled.has(input.sessionId) && isTransientStreamInterruptionLine(notice)) {
        const message = this.assistant(input.sessionId);
        if (!this.turnStreamInterrupted.has(input.sessionId)) this.appendAssistantText(input.sessionId, message, '\n' + notice);
        this.upsert(message);
      } else {
        if (!isCurrent()) throw error;
        const diagnostic = diagnosticForError(error, this.app.client);
        const toolStop = this.turnStop(input.sessionId)?.code;
        const canRecoverToolError = !isManualCompact && this.app.client.connected && !this.app.client.isRateLimited &&
          diagnostic.code === 'unknown_error' && (toolStop === 'policy_blocked' || toolStop === 'tool_failure_stopped');
        if (!canRecoverToolError) {
          errorStop = diagnostic;
          this.app.sessions.setStatus(input.sessionId, 'error', diagnostic);
          if (!followup) { submitted.sendFailed = true; this.upsert(submitted); }
          throw error;
        }
      }
    } finally {
      if (isCurrent()) {
        const messages = this.turnMessages(input.sessionId);
        turnAssistantMsg = messages.at(-1);
        failedTools = messages.flatMap(message => message.toolCalls?.filter(isToolCallFailure) ?? []);
        hasPostToolSubstantiveReply = this.hasPostToolSubstantiveReply(input.sessionId);
        const turnStop = this.turnStop(input.sessionId, stopReason);
        const stop = turnStop?.code === 'policy_blocked' || turnStop?.code === 'tool_failure_stopped' ? turnStop :
          errorStop ? turnAssistantMsg && errorStop : turnStop;
        if (stop && !turnAssistantMsg) turnAssistantMsg = this.assistant(input.sessionId);
        this.finishPromptTurn(input.sessionId, stop);
        if (isManualCompact) {
          if (compactSucceeded) this.app.telemetry.finishManualCompaction(input.sessionId);
          else this.app.telemetry.cancelManualCompaction(input.sessionId);
        }
      }
    }
    // 防止因单条命令触发安全拦截、少量命令失败或瞬态断连导致整轮无正文回复即完全中止：最多自动续接 1 次（有界，绝不循环）。
    // A server-side interruption can settle without a local cancel or a thrown RPC error.
    const hadFollowup = this.followups.has(input.sessionId);
    if (stopReason !== 'end_turn' || this.turnStreamInterrupted.has(input.sessionId)) this.followups.failQueued(input.sessionId);
    const wasCancelledByUser = this.turnUserCancelled.has(input.sessionId);
    const autoDenied = this.turnAutoDenied.get(input.sessionId) || [];
    const streamInterruptedUnrecovered = this.turnStreamInterrupted.has(input.sessionId);
    const shouldAutoRecover =
      !isManualCompact && !followup &&
      !hadFollowup && !this.feedback.has(input.sessionId) &&
      !owner.signal.aborted && !wasCancelledByUser && this.app.client.cooldownUntilMs === cooldownAtStart &&
      !this.app.client.isRateLimited &&
      (stopReason === undefined || stopReason === 'end_turn' || (stopReason === 'cancelled' && (autoDenied.length > 0 || failedTools.length > 0))) &&
      this.app.sessions.isActive(input.sessionId) &&
      isCurrent() &&
      (streamInterruptedUnrecovered || (!hasPostToolSubstantiveReply && (autoDenied.length > 0 || failedTools.length > 0)));

    if (shouldAutoRecover) {
      if (turnAssistantMsg && streamInterruptedUnrecovered) {
        turnAssistantMsg.content = stripTransientStreamInterruptions(turnAssistantMsg.content);
        this.upsert(turnAssistantMsg);
      }
      this.resetTurnState(input.sessionId);

      const summaries = failedTools.slice(-3).map(tc => {
        const firstWord = tc.command?.trim().match(/^[a-zA-Z0-9_.-]+/)?.[0] ?? tc.canonicalToolName;
        const tail = redactSecretsForReviewer(tc.outputPreview ?? '').trim().slice(-300);
        return [firstWord, tc.exitCode !== undefined ? 'exitCode=' + tc.exitCode : tc.status, tail].filter(Boolean).join(' ');
      });
      for (const denied of autoDenied.slice(-3)) {
        if (summaries.length >= 3 || failedTools.some(tc => tc.toolCallId === denied.toolCallId)) continue;
        const name = denied.command.match(/^[a-zA-Z0-9_.-]+/)?.[0] ?? denied.toolName;
        summaries.push(name + ' rejected ' + redactSecretsForReviewer(denied.reason).slice(0, 300));
      }
      const uniqueReasons = [...new Set(autoDenied.map(d => redactSecretsForReviewer(d.reason).slice(0, 300)).filter(Boolean))].slice(0, 3);
      let noticeText = '';
      let continuationPrompt = '';
      if (autoDenied.length > 0) {
        noticeText = `部分命令因触及本地安全策略已被拦截（${uniqueReasons.join('；') || '受保护路径'}），已自动通知模型跳过受限项并继续完成答复…`;
        continuationPrompt = `上一轮中有 ${autoDenied.length} 项操作因触发客户端安全策略被拦截（${uniqueReasons.join('；') || '受保护目录或敏感路径'}），同批次并行命令随之取消。请不要再访问受限路径或重试被拦截的命令，直接基于此前已收集到的信息或改用安全方式继续完成任务并给出完整最终答复。`;
      } else if (failedTools.length > 0) {
        noticeText = `上一轮有 ${failedTools.length} 项命令执行失败导致回复提前中断，已自动续接以完成最终答复…`;
        continuationPrompt = `上一轮有 ${failedTools.length} 项工具调用失败并导致回复提前中止。请跳过或调整失败的命令，基于已有上下文直接继续完成任务并给出完整最终答复。`;
      } else {
        noticeText = '检测到流式连接中断导致本轮未完成输出，已自动续接当前任务…';
        continuationPrompt = '上一轮与服务器的连接中断。请从当前会话已完成的位置继续，保留已有结果，先确认状态再处理未完成的操作，并给出最终答复。';
      }

      if (summaries.length) continuationPrompt += '\n失败工具及错误尾部（仅作诊断）：\n' + summaries.join('\n');
      this.upsert({
        id: randomUUID(),
        sessionId: input.sessionId,
        role: 'system',
        content: noticeText,
        createdAt: new Date().toISOString(),
      });
      this.app.telemetry.beginTurn(input.sessionId, continuationPrompt);
      this.assistantMessages.delete(input.sessionId);
      let recoveryStop: SessionDiagnosticBanner | undefined;
      try {
        const resumed = await this.app.sessions.sendPrompt({
          sessionId: input.sessionId,
          prompt: [{ type: 'text', text: continuationPrompt }],
        });
        if (!isCurrent()) return;
        if (resumed.stopReason !== 'end_turn' || this.turnStreamInterrupted.has(input.sessionId)) this.followups.failQueued(input.sessionId);
        if (resumed.usage) this.app.telemetry.applyUsage(input.sessionId, resumed.usage);
        recoveryStop = this.turnStop(input.sessionId, resumed.stopReason);
        if (!this.turnUserCancelled.has(input.sessionId)) {
          if (!this.hasPostToolSubstantiveReply(input.sessionId) && (autoDenied.length || failedTools.length) &&
              recoveryStop?.code !== 'policy_blocked' && recoveryStop?.code !== 'tool_failure_stopped') {
            recoveryStop = buildDiagnosticBanner(autoDenied.length ? 'policy_blocked' : 'tool_failure_stopped', { stopReason: resumed.stopReason });
          }
          if (this.turnStreamInterrupted.has(input.sessionId)) {
            this.assistant(input.sessionId).autoResumeFailure = {};
          } else if (!this.hasPostToolSubstantiveReply(input.sessionId)) {
            if (!recoveryStop || recoveryStop.code === 'user_cancelled') {
              recoveryStop = buildDiagnosticBanner(autoDenied.length ? 'policy_blocked' : failedTools.length ? 'tool_failure_stopped' : 'auto_resume_failed', { stopReason: resumed.stopReason });
            }
            this.assistant(input.sessionId).autoResumeFailure = {
              detail: '官方服务结束了续接，未返回正文或附件（' + diagnosticDetail(resumed.stopReason) + '）。',
            };
          } else if (turnAssistantMsg?.turnStop?.code === 'policy_blocked' || turnAssistantMsg?.turnStop?.code === 'tool_failure_stopped') {
            delete turnAssistantMsg.turnStop;
            this.upsert(turnAssistantMsg);
          }
        }
      } catch (error) {
        if (isCurrent()) this.followups.failQueued(input.sessionId);
        discardUnsent(error);
        if (isCurrent() && this.turnUserCancelled.has(input.sessionId)) {
          this.app.sessions.setStatus(input.sessionId, 'idle');
        } else if (isCurrent()) {
          const diagnostic = diagnosticForError(error, this.app.client);
          this.app.sessions.setStatus(input.sessionId, 'error', diagnostic);
          recoveryStop = autoDenied.length || failedTools.length
            ? buildDiagnosticBanner(autoDenied.length ? 'policy_blocked' : 'tool_failure_stopped', { technicalDetail: diagnosticDetail(error) })
            : diagnostic.code === 'unknown_error' ? diagnosticForError(error, this.app.client, 'auto_resume_failed') : diagnostic;
          this.assistant(input.sessionId).autoResumeFailure = { detail: diagnosticDetail(error) };
        }
      } finally {
        if (isCurrent()) {
          this.finishPromptTurn(input.sessionId, recoveryStop ?? this.turnStop(input.sessionId));
        }
      }
    }
    // Release with the finished turn so immediate ACP replies expose a settled, idle session.
    const id = input.sessionId;
    if (!this.followups.has(id) && !this.feedback.has(id)) this.releasePrompt(id, owner);
  }
  async answerQuestion(input: QuestionSubmission) {
    this.app.accounts.assertReady();
    return this.questions.answer(input);
  }
  async cancelPrompt(sessionId: string): Promise<void> {
    this.promptOwners.get(sessionId)?.abort(new AcpRequestNotSentError('用户已取消本次提交'));
    this.turnUserCancelled.add(sessionId);
    if (this.promptOwners.has(sessionId) && !this.submitted.has(sessionId) && !this.app.sessions.isBusy(sessionId)) return;
    this.clearReactiveTurnTimer(sessionId);
    await this.app.sessions.cancelPrompt(sessionId);
    if (this.app.sessions.isActive(sessionId)) this.app.swarm.markUnconfirmed(sessionId, '已请求停止当前回合', 'Stop requested for the parent turn');
    if (!this.app.sessions.isBusy(sessionId) && !this.promptOwners.has(sessionId) && this.app.sessions.isActive(sessionId)) {
      if (this.assistantMessages.has(sessionId) || this.questionSegments.has(sessionId)) {
        this.finishMessage(sessionId, buildDiagnosticBanner('user_cancelled', { stopReason: 'cancelled' }));
      }
      this.app.sessions.setStatus(sessionId, 'idle');
    }
  }
  async compactSessionContext(sessionId: string): Promise<void> {
    if (!this.compactAvailable.has(sessionId)) throw new Error('当前官方会话未声明支持 /compact，不能保证压缩可用');
    await this.sendPrompt({ sessionId, text: '/compact' });
  }
}
