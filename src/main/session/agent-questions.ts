import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { AcpRpcError } from '../acp/acp-client';
import type { ChatMessageItem } from '../../shared/session-contract';
import { answerSummary, type AnswerValue, type QuestionField, type QuestionSubmission, type UserQuestion } from '../../shared/user-question';

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

function validate(fields: QuestionField[], values: Record<string, AnswerValue>) {
  if (!object(values) || Object.keys(values).some(key => !fields.some(f => f.name === key))) throw Error('回答字段无效');
  for (const f of fields) {
    const value = Object.hasOwn(values, f.name) ? values[f.name] : undefined;
    const fail = () => { throw Error('请检查回答 · ' + f.title); };
    if (value === undefined) { if (f.required) fail(); continue; }
    if (f.type === 'array') {
      if (!strings(value) || value.length !== new Set(value).size || value.length < (f.minItems ?? 0) ||
          value.length > (f.maxItems ?? Infinity) || !value.every(v => f.choices?.some(c => c.value === v))) fail();
    } else if (f.type === 'boolean') { if (typeof value !== 'boolean') fail(); }
    else if (f.type === 'number' || f.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (f.type === 'integer' && !Number.isInteger(value)) ||
          value < (f.minimum ?? -Infinity) || value > (f.maximum ?? Infinity)) fail();
    } else {
      if (typeof value !== 'string') throw Error('请填写文本 · ' + f.title);
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
  private open = new Map<string, { message: ChatMessageItem; rpc: string | number; resolve: (result: RpcResult) => void }>();
  constructor(private publish: (m: ChatMessageItem) => void, private active: (id: string) => boolean,
    private queueReply: (sessionId: string, text: string) => void) {}

  request(raw: unknown, rpc: string | number): Promise<RpcResult> | RpcResult {
    if (!object(raw) || typeof raw.sessionId !== 'string' || typeof raw.message !== 'string' ||
        (raw.mode !== undefined && raw.mode !== 'form')) throw invalid();
    if (!this.active(raw.sessionId)) return { action: 'cancel' };
    const question: UserQuestion = { message: raw.message, fields: fieldsOf(raw.requestedSchema), state: 'open' };
    const message: ChatMessageItem = { id: randomUUID(), sessionId: raw.sessionId, role: 'assistant', content: '',
      createdAt: new Date().toISOString(), question };
    return new Promise(resolve => { this.open.set(message.id, { message, rpc, resolve }); this.publish(message); });
  }

  answer(input: QuestionSubmission): void {
    const pending = this.open.get(input.messageId);
    if (!pending || pending.message.sessionId !== input.sessionId || !['accept', 'decline', 'cancel'].includes(input.action)) throw Error('该提问已结束');
    const question = pending.message.question!;
    const values = input.values ?? {};
    const custom = input.customReply?.trim();
    const display = input.displayAnswer?.trim();
    if (input.action === 'accept') {
      if ((custom?.length ?? 0) > 1000000 || (display?.length ?? 0) > 1000000) throw Error('回答过长');
      if (!custom) validate(question.fields, values);
      if (custom) this.queueReply(input.sessionId, custom);
    }
    this.open.delete(input.messageId);
    question.state = input.action === 'accept' ? 'answered' : input.action === 'decline' ? 'declined' : 'cancelled';
    if (input.action === 'accept') question.answer = custom || display || answerSummary(question.fields, values);
    this.publish(pending.message);
    pending.resolve(input.action === 'accept' && !custom ? { action: 'accept', content: values } : { action: custom ? 'decline' : input.action });
  }

  cancel(sessionId?: string, rpc?: string | number) {
    for (const [messageId, item] of this.open) if ((!sessionId || item.message.sessionId === sessionId) && (rpc === undefined || rpc === item.rpc))
      this.answer({ sessionId: item.message.sessionId, messageId, action: 'cancel' });
  }
}
