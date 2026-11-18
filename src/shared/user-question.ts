export type AnswerValue = string | number | boolean | string[];
export interface QuestionField {
  name: string; title: string; description?: string;
  type: 'string' | 'array' | 'boolean' | 'number' | 'integer';
  required: boolean; choices?: { value: string; label: string; description?: string }[];
  initial?: AnswerValue; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  minItems?: number; maxItems?: number; pattern?: string; format?: string;
}
export interface UserQuestion {
  message: string; fields: QuestionField[]; state: 'open' | 'answered' | 'declined' | 'cancelled'; answer?: string;
}
export interface QuestionSubmission {
  sessionId: string; messageId: string; action: 'accept' | 'decline' | 'cancel';
  values?: Record<string, AnswerValue>; customReply?: string; displayAnswer?: string;
}

export function answerSummary(fields: QuestionField[], values: Record<string, AnswerValue>) {
  return fields.filter(f => values[f.name] !== undefined).map(f => {
    const v = values[f.name];
    const show = (s: string) => f.choices?.find(o => o.value === s)?.label || s;
    const text = Array.isArray(v) ? v.map(show).join('、') : typeof v === 'string' ? show(v) : String(v);
    return fields.length > 1 ? f.title + ' · ' + text : text;
  }).join('\n');
}

/** Chat-only agents may ask the same question as prose followed by a short list. */
export function writtenQuestion(text: string): UserQuestion | undefined {
  const lines = text.trimEnd().split(/\r?\n/);
  let fence = '', afterFence = 0;
  lines.forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) return;
    if (!fence) fence = marker;
    else if (marker.startsWith(fence)) { afterFence = index + 1; fence = ''; }
  });
  if (fence) return;
  const tail = lines.slice(Math.max(afterFence, lines.length - 22)).map(s => s.trim()).filter(Boolean);
  if (!tail.length || tail.some(s => /^(?:```|~~~)/.test(s))) return;
  const clean = (s: string) => s.replace(/^[#>*\s]+/, '').replace(/\*\*/g, '').trim();
  const question = (s: string) => /[?？]$/.test(s) || /^(?:请(?:选择|挑选)|请选择|which (?:one|option)|choose (?:one|an option)|pick (?:one|an option)).*[:：]$/i.test(s);
  const option = (s: string) => /^(?:[-*•]\s+|(?:[A-Ha-h]|\d{1,2})[.)、：:]\s*|\([A-Ha-h\d]\)\s*)(.+)$/.exec(s)?.[1];
  let index = tail.length - 1;
  let message = '';
  if (question(clean(tail[index]))) message = clean(tail[index--]);
  const options: string[] = [];
  while (index >= 0 && options.length < 12) {
    const value = option(tail[index]);
    if (!value) break;
    options.unshift(clean(value)); index--;
  }
  if (!message && index >= 0 && question(clean(tail[index]))) message = clean(tail[index]);
  if (!message || (!options.length && !question(clean(tail.at(-1)!)))) return;
  if (!options.length) {
    const pair = /^(?:would you (?:prefer|like)|do you (?:prefer|want)|(?:你|您)?(?:更)?(?:想要|想选|喜欢|偏好|希望选择|想选择|想用|选用|选择))\s*(.{1,45}?)\s*(?:还是|\s+or\s+)\s*(.{1,45}?)[？?]$/i.exec(message);
    if (pair) options.push(...pair.slice(1).map(s => s.replace(/^["'“「‘]|["'”」’]$/g, '').trim()));
  }
  if (!options.length && /^(?:would you like|do you want|should I|shall I|是否|要不要|需要我|要我)/i.test(message)) {
    options.push(...(/[\u4e00-\u9fff]/.test(message) ? ['是', '否'] : ['Yes', 'No']));
  }
  return { message, state: 'open', fields: [{ name: 'answer', title: message, type: 'string', required: true,
    choices: options.length > 1 ? options.map(s => ({ value: s, label: s })) : undefined }] };
}
