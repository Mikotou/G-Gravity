import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { AcpRpcError } from '../acp/acp-client';
import type { ChatMessageItem } from '../../shared/session-contract';
import {
  answerSummary, type AnswerValue, type QuestionField, type QuestionSubmission, type QuestionSubmissionReceipt, type UserQuestion,
} from '../../shared/user-question';

import { followupText, needsFollowup, submissionSignature, validateSubmissionPayload, validFormat, type SubmittedQuestion } from './question-submission';

type RpcResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, AnswerValue> };
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
const invalid = () => new AcpRpcError(-32602, 'Invalid elicitation form');

function fieldsOf(schema: unknown): QuestionField[] {
  if (!object(schema) || !object(schema.properties)) throw invalid();
  return Object.entries(schema.properties).map(([name, raw]) => {
    if (!object(raw) || !['string', 'array', 'boolean', 'number', 'integer'].includes(String(raw.type))) throw invalid();
    const type = raw.type as QuestionField['type'];
    const variants = type === 'array' ? raw.items : raw;
    if (!object(variants)) throw invalid();
    if (type === 'array' && variants.type !== undefined && variants.type !== 'string') throw invalid();
    const titled = type === 'array' ? variants.anyOf : variants.oneOf;
    let choices: QuestionField['choices'];
    if (Array.isArray(titled)) choices = titled.map(o => {
      if (!object(o) || typeof o.const !== 'string') throw invalid();
      return { value: o.const, label: typeof o.title === 'string' ? o.title : o.const,
        description: typeof o.description === 'string' ? o.description : undefined };
    });
    else if (strings(variants.enum)) choices = variants.enum.map(value => ({ value, label: value }));
    if (type === 'array' && !choices) throw invalid();
    const f: QuestionField = { name, type, choices, title: typeof raw.title === 'string' ? raw.title : name,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      required: Array.isArray(schema.required) && schema.required.includes(name) };
    if (typeof raw.default === 'string' || typeof raw.default === 'boolean' || typeof raw.default === 'number' || strings(raw.default)) f.initial = raw.default;
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) if (typeof raw[k] === 'number') f[k] = raw[k];
    if (typeof raw.pattern === 'string') f.pattern = raw.pattern;
    if (typeof raw.format === 'string') f.format = raw.format;
    return f;
  });
}

function validate(fields: QuestionField[], values: Record<string, AnswerValue>,
  followup?: { customAnswers?: Record<string, string>; legacyReply?: string }) {
  const names = new Set(fields.map(field => field.name));
  if (!object(values) || Object.keys(values).some(key => !names.has(key))) throw Error('回答字段无效');
  for (const f of fields) {
    const value = Object.hasOwn(values, f.name) ? values[f.name] : undefined;
    const fail = () => { throw Error('请检查回答 · ' + f.title); };
    const missing = value === undefined || (followup && (value === '' || (Array.isArray(value) && !value.length)));
    const custom = followup?.customAnswers;
    if (f.required && missing && !followup?.legacyReply && !(custom && Object.hasOwn(custom, f.name) && custom[f.name].trim())) fail();
    if (value === undefined) continue;
    if (f.type === 'array') {
      if (!strings(value) || value.length !== new Set(value).size || value.length < (f.minItems ?? 0) ||
          value.length > (f.maxItems ?? Infinity) || !value.every(v => f.choices?.some(c => c.value === v))) fail();
    } else if (f.type === 'boolean') { if (typeof value !== 'boolean') fail(); }
    else if (f.type === 'number' || f.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (f.type === 'integer' && !Number.isInteger(value)) ||
          value < (f.minimum ?? -Infinity) || value > (f.maximum ?? Infinity)) fail();
    } else {
      if (typeof value !== 'string') throw Error('请填写文本 · ' + f.title);
      if (!validFormat(f.format, value)) fail();
      if (value.length < (f.minLength ?? 0) || value.length > (f.maxLength ?? Infinity) ||
          (f.choices && !f.choices.some(c => c.value === value))) fail();
      if (f.pattern) {
        try { if (!runInNewContext('new RegExp(pattern).test(value)', { pattern: f.pattern, value }, { timeout: 30 })) fail(); }
        catch { fail(); }
      }
    }
  }
}

export class AgentQuestions {
  private open = new Map<string, { profileId: string; message: ChatMessageItem; rpc: string | number; resolve: (result: RpcResult) => void }>();
  private readonly completed = new Map<string, SubmittedQuestion>();
  constructor(private publish: (m: SubmittedQuestion, previous?: ChatMessageItem, followup?: ChatMessageItem) => void,
    private active: (id: string) => boolean, private queueReply: (sessionId: string, text: string, message: ChatMessageItem) => void,
    private stateChanged?: (sessionId: string) => void, private profile = () => 'default',
    private find?: (sessionId: string, id: string) => SubmittedQuestion | undefined,
    private retry?: (question: SubmittedQuestion) => void,
    private notifyCommitted?: (question: ChatMessageItem, followup?: ChatMessageItem) => void) {}

  hasOpen(sessionId: string): boolean {
    for (const pending of this.open.values()) {
      if (pending.message.sessionId === sessionId) return true;
    }
    return false;
  }

  request(raw: unknown, rpc: string | number): Promise<RpcResult> | RpcResult {
    if (!object(raw) || typeof raw.sessionId !== 'string' || typeof raw.message !== 'string' ||
        (raw.mode !== undefined && raw.mode !== 'form')) throw invalid();
    if (!this.active(raw.sessionId)) return { action: 'cancel' };
    const question: UserQuestion = { message: raw.message, fields: fieldsOf(raw.requestedSchema), state: 'open', submissionVersion: 2 };
    const message: ChatMessageItem = { id: randomUUID(), sessionId: raw.sessionId, role: 'assistant', content: '',
      createdAt: new Date().toISOString(), question };
    return new Promise(resolve => {
      this.open.set(message.id, { profileId: this.profile(), message, rpc, resolve });
      try { this.publish(message); this.stateChanged?.(message.sessionId); }
      catch (error) { this.open.delete(message.id); throw error; }
    });
  }

  answer(input: QuestionSubmission): QuestionSubmissionReceipt {
    if (!input || typeof input.messageId !== 'string' || typeof input.sessionId !== 'string' ||
        !['accept', 'decline', 'cancel'].includes(input.action)) throw Error('提问回答格式无效');
    if ((input.submissionId !== undefined && (typeof input.submissionId !== 'string' || input.submissionId.length > 256 || !input.submissionId.trim())) ||
        (input.delivery !== undefined && input.delivery !== 'form' && input.delivery !== 'followup') ||
        (input.retryUnsentFollowup !== undefined && typeof input.retryUnsentFollowup !== 'boolean')) throw Error('提问提交格式无效');
    validateSubmissionPayload(input);
    const profileId = this.profile();
    const key = JSON.stringify([profileId, input.sessionId, input.messageId]);
    const pending = this.open.get(input.messageId);
    const saved = this.find ? this.find(input.sessionId, input.messageId) : this.completed.get(key);
    const prior = saved?.submissionRecord;
    if (saved && prior && prior.profileId === profileId && prior.sessionId === input.sessionId && prior.messageId === input.messageId) {
      if (!input.submissionId || prior.receipt.submissionId !== input.submissionId) throw Error('该提问已结束');
      const retryById = input.retryUnsentFollowup && input.action === 'accept' && input.delivery !== 'form' &&
        !input.values && !input.optionEdits && !input.customAnswers && !input.customReply;
      if (!retryById && submissionSignature(input) !== prior.signature) throw Error('相同提交 ID 的回答内容不一致');
      const receipt = { ...prior.receipt };
      if (saved.questionFollowup) receipt.followupState = saved.questionFollowup.state;
      if (input.retryUnsentFollowup) {
        if (receipt.followupState !== 'failed-unsent' || !this.active(input.sessionId) || !this.retry) throw Error('仅可重试已确认未发送的跟进');
        this.retry(saved);
        receipt.followupState = 'queued';
      }
      return receipt;
    }
    if (input.retryUnsentFollowup || !pending || pending.profileId !== profileId || pending.message.sessionId !== input.sessionId) throw Error('该提问已结束');
    const question = pending.message.question!;
    const values = input.values ?? {};
    const accepted = input.action === 'accept';
    const custom = accepted && input.customReply?.trim();
    const display = accepted && input.displayAnswer?.trim();
    const edited = accepted && needsFollowup(question, input);
    const follow = accepted && (input.delivery === 'followup' || (input.delivery === undefined && edited));
    const submissionId = input.submissionId ?? randomUUID();
    const receipt: QuestionSubmissionReceipt = { mode: follow ? 'followup' : 'form', submissionId };
    let response: string | undefined;
    let followup: ChatMessageItem | undefined;
    if (accepted) {
      if (follow) {
        const legacy = input.delivery === undefined && !input.submissionId && !input.optionEdits && !input.customAnswers;
        const legacyReply = custom && (legacy || question.fields.length === 1) ? custom : undefined;
        validate(question.fields, values, { customAnswers: input.customAnswers, legacyReply });
        response = !input.delivery && !input.optionEdits && !input.customAnswers && custom ? custom : followupText(question, input);
        const id = randomUUID();
        receipt.followupMessageId = id;
        receipt.followupState = 'queued';
        followup = { id, originMessageId: id, sessionId: input.sessionId, role: 'user', createdAt: new Date().toISOString(), content: response,
          questionFollowup: { questionMessageId: input.messageId, submissionId, state: 'queued' } };
      } else {
        if (custom || edited) throw Error('改写或自定义回答需要显式跟进');
        validate(question.fields, values);
        response = display || answerSummary(question.fields, values);
      }
    }
    const message: SubmittedQuestion = { ...pending.message,
      question: { ...question, state: accepted ? 'answered' : input.action === 'decline' ? 'declined' : 'cancelled',
        ...(accepted && { answer: display || response }) },
      ...(followup && { questionFollowup: { ...followup.questionFollowup! } }),
      submissionRecord: { profileId, sessionId: input.sessionId, messageId: input.messageId, signature: submissionSignature(input), receipt } };
    this.open.delete(input.messageId);
    try { this.publish(message, pending.message, followup); }
    catch (error) { this.open.set(input.messageId, pending); throw error; }
    if (!this.find) this.completed.set(key, message);
    pending.message.question = message.question;
    pending.resolve(accepted && !follow ? { action: 'accept', content: values } : { action: follow ? 'decline' : input.action });
    if (followup) this.queueReply(input.sessionId, followup.content, followup);
    this.notifyCommitted?.(message, followup);
    this.stateChanged?.(input.sessionId);
    return { ...receipt };
  }

  cancel(sessionId?: string, rpc?: string | number) {
    for (const [messageId, item] of this.open) {
      if ((sessionId && item.message.sessionId !== sessionId) || (rpc !== undefined && rpc !== item.rpc)) continue;
      this.open.delete(messageId);
      item.message.question = { ...item.message.question!, state: 'cancelled' };
      // The server has stopped waiting. Finish its request even if saving the local transcript fails.
      try { this.publish(item.message); } catch { /* An open question is also restored as cancelled on restart. */ }
      item.resolve({ action: 'cancel' });
      this.stateChanged?.(item.message.sessionId);
    }
  }
}
