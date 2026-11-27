import { createHash } from 'node:crypto';
import type { ChatMessageItem } from '../../shared/session-contract';
import type { AnswerValue, QuestionSubmission, QuestionSubmissionReceipt, UserQuestion } from '../../shared/user-question';

export type SubmittedQuestion = ChatMessageItem & { submissionRecord?: {
  profileId: string; sessionId: string; messageId: string; signature: string; receipt: QuestionSubmissionReceipt;
} };

const maxAnswerBytes = 1_000_000;
type Shape = 'values' | 'answer' | 'edits' | 'strings' | 'string';

/** Count the actual JSON UTF-8 bytes while checking the accepted IPC shapes, before canonicalization. */
function checkAnswerSize(value: unknown, shape: Shape): void {
  let bytes = 0;
  function add(n: number): void {
    bytes += n;
    if (bytes > maxAnswerBytes) throw Error('回答过长');
  }
  function string(text: unknown): void {
    if (typeof text !== 'string') throw Error('回答文本无效');
    if (text.length > maxAnswerBytes - bytes) throw Error('回答过长');
    add(2 + Buffer.byteLength(text));
    // JSON escapes control characters, quotes, backslashes and lone UTF-16 surrogates.
    for (const match of text.matchAll(/[\x00-\x1f"\\]|[\uD800-\uDFFF]/gu)) {
      const code = match[0].charCodeAt(0);
      if (code >= 0xd800) add(3);
      else if (code < 32 && ![8, 9, 10, 12, 13].includes(code)) add(5);
      else add(1);
    }
  }
  function visit(item: unknown, kind: Shape): void {
    if (kind === 'string' || (kind === 'answer' && typeof item === 'string')) return string(item);
    if (kind === 'answer') {
      if (typeof item === 'boolean') return add(item ? 4 : 5);
      if (typeof item === 'number' && Number.isFinite(item)) return add(String(item).length);
      if (!Array.isArray(item)) throw Error('回答值无效');
      add(2 + Math.max(0, item.length - 1));
      for (const entry of item) string(entry);
      return;
    }
    if (!record(item) || (Object.getPrototypeOf(item) !== null && Object.getPrototypeOf(item) !== Object.prototype)) throw Error('回答字段无效');
    const child = kind === 'values' ? 'answer' : kind === 'edits' ? 'strings' : 'string';
    let first = true;
    add(2);
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      add(first ? 1 : 2);
      first = false;
      string(key);
      visit(item[key], child);
    }
  }
  visit(value, shape);
}

export function validateSubmissionPayload(input: QuestionSubmission): void {
  if (input.action !== 'accept') return;
  if (input.values !== undefined) checkAnswerSize(input.values, 'values');
  if (input.optionEdits !== undefined) checkAnswerSize(input.optionEdits, 'edits');
  if (input.customAnswers !== undefined) checkAnswerSize(input.customAnswers, 'strings');
  for (const text of [input.customReply, input.displayAnswer]) {
    if (text !== undefined && (typeof text !== 'string' || text.length > maxAnswerBytes)) throw Error('回答文本无效或过长');
  }
}

export function submissionSignature(input: QuestionSubmission): string {
  const payload = input.action === 'accept' ? {
    action: input.action, delivery: input.delivery, values: input.values ?? {}, optionEdits: input.optionEdits ?? {},
    customAnswers: input.customAnswers ?? {}, customReply: input.customReply?.trim() || '',
  } : { action: input.action };
  const canonical = JSON.stringify(payload, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    }
    return value;
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function validFormat(format: string | undefined, value: string): boolean {
  switch (format) {
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case 'url':
    case 'uri': return !/\s/.test(value) && URL.canParse(value);
    case 'date': {
      const stamp = Date.parse(value + 'T00:00:00Z');
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(stamp) && new Date(stamp).toISOString().startsWith(value + 'T');
    }
    case 'date-time': return validFormat('date', value.slice(0, 10)) &&
      /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value));
    default: return true;
  }
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function needsFollowup(question: UserQuestion, input: QuestionSubmission): boolean {
  const fields = new Map(question.fields.map(f => [f.name, f]));
  let changed = !!input.customReply?.trim();
  for (const map of [input.optionEdits, input.customAnswers]) {
    if (map !== undefined && (!record(map) || Object.keys(map).some(key => !fields.has(key)))) throw Error('回答字段无效');
  }
  for (const [key, edits] of Object.entries(input.optionEdits ?? {})) {
    if (!record(edits)) throw Error('选项改写无效');
    for (const [value, edit] of Object.entries(edits)) {
      const choice = fields.get(key)!.choices?.find(item => item.value === value);
      if (!choice || typeof edit !== 'string') throw Error('选项改写无效');
      if (edit !== choice.label) changed = true;
    }
  }
  for (const [key, answer] of Object.entries(input.customAnswers ?? {})) {
    if (typeof answer !== 'string') throw Error('自定义回答无效');
    if (answer.trim() && answer !== own(input.values, key)) changed = true;
  }
  return changed;
}

export function followupText(question: UserQuestion, input: QuestionSubmission): string {
  const fields = new Map(question.fields.map(f => [f.name, f]));
  for (const map of [input.values, input.optionEdits, input.customAnswers]) {
    if (map !== undefined && (!record(map) || Object.keys(map).some(key => !fields.has(key)))) throw Error('回答字段无效');
  }
  const lines = [question.message];
  let answered = false;
  for (const field of fields.values()) {
    lines.push('', field.title);
    if (field.description) lines.push(field.description);
    const choices = new Map(field.choices?.map(c => [c.value, c.label]));
    const edits = own(input.optionEdits, field.name) ?? {};
    if (!record(edits) || Object.entries(edits).some(([key, text]) => !choices.has(key) || typeof text !== 'string')) throw Error('选项改写无效');
    for (const { value, label, description } of field.choices ?? []) {
      const edit = own(edits, value);
      lines.push('- ' + label + (value !== label ? ' [' + value + ']' : '') + (edit !== undefined ? ' → ' + edit : '') + (description ? ' · ' + description : ''));
    }
    const value = own(input.values, field.name);
    if (value !== undefined) {
      if (!(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
          Array.isArray(value) && value.every(item => typeof item === 'string'))) throw Error('回答值无效');
      const show = (v: AnswerValue) => typeof v === 'string' ? own(edits, v) ?? choices.get(v) ?? v : String(v);
      lines.push('回答：' + (Array.isArray(value) ? value.map(show).join('、') : show(value)));
      answered = true;
    }
    const custom = own(input.customAnswers, field.name);
    if (custom !== undefined) {
      if (typeof custom !== 'string') throw Error('自定义回答无效');
      if (custom.trim()) { lines.push('自定义：' + custom); answered = true; }
    }
  }
  if (input.customReply?.trim()) { lines.push('', input.customReply.trim()); answered = true; }
  if (!answered) throw Error('请填写跟进回答');
  const text = lines.join('\n');
  if (text.length > 1_000_000) throw Error('回答过长');
  return text;
}

function own<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}
