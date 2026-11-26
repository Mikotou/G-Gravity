import { getComponentCopy } from '../i18n/domains/copy';
import { useEffect, useRef, useState } from 'react';
import type { AnswerValue, QuestionSubmission, UserQuestion } from '@shared';
import { answerSummary } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { stripIpcErrorPrefix } from '../i18n/locales';

type Reply = Omit<QuestionSubmission, 'sessionId' | 'messageId'>;
type Draft = { values: Record<string, AnswerValue>; edits: Record<string, string>; custom: string };
export function QuestionBar({ question, draftKey, native, sendError, submit }: {
  question: UserQuestion; draftKey: string; native: boolean; sendError?: string; submit: (reply: Reply) => Promise<void>;
}) {
  const zh = useI18n().locale === 'zh-CN';
  const key = 'gravity.question.' + draftKey;
  const [draft, setDraft] = useState<Draft>(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); if (saved?.values && saved.edits) return saved; } catch { /* optional storage */ }
    return { values: Object.fromEntries(question.fields.filter(f => f.initial !== undefined).map(f => [f.name, f.initial!])), edits: {}, custom: '' };
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false);
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* in-memory drafting still works */ } }, [draft, key]);
  const editKey = (field: string, value: string) => JSON.stringify([field, value]);
  const setValue = (name: string, value: AnswerValue | undefined) => setDraft(prev => {
    const values = { ...prev.values };
    if (value === undefined) delete values[name]; else values[name] = value;
    return { ...prev, values };
  });
  const free = question.fields.find(f => f.type === 'string' && !f.choices && /free.?form|free.?text|custom|other|additional|comment|补充|自定义/i.test(f.name + ' ' + f.title));
  const canCustom = question.fields.some(f => f.choices?.length);
  const [customOpen, setCustomOpen] = useState(Boolean(draft.custom));
  async function send(action: Reply['action']) {
    if (locked.current) return;
    const values = { ...draft.values };
    const custom = draft.custom.trim();
    const changes: string[] = [];
    const visible = { ...values };
    for (const f of question.fields) {
      const selected = values[f.name];
      if (!f.choices || selected === undefined) continue;
      const ids = Array.isArray(selected) ? selected : [String(selected)];
      const labels = ids.map(id => {
        const option = f.choices!.find(c => c.value === id);
        const label = option?.label || id;
        const edit = draft.edits[editKey(f.name, id)]?.trim();
        return edit ?? label;
      });
      if (labels.some(s => !s) && action === 'accept' && !custom) { setError(getComponentCopy(zh).enterTheEditedOption); return; }
      if (ids.some((id, i) => labels[i] !== (f.choices!.find(c => c.value === id)?.label || id))) changes.push(f.title + ' · ' + labels.join('、'));
      visible[f.name] = Array.isArray(selected) ? labels : labels[0];
    }
    const displayed = answerSummary(question.fields.map(f => ({ ...f, choices: undefined })), visible);
    let customReply: string | undefined;
    if (action === 'accept') {
      if (!native) customReply = custom || displayed;
      else if ((changes.length || custom) && free) {
        values[free.name] = [values[free.name], custom || changes.join('\n')].filter(Boolean).join('\n');
      } else if (custom || changes.length) {
        customReply = custom || displayed;
      }
      if (!customReply && question.fields.some(f => f.required && (values[f.name] === undefined || values[f.name] === '' ||
          (Array.isArray(values[f.name]) && !(values[f.name] as string[]).length)))) {
        setError(getComponentCopy(zh).answerTheRequiredFields); return;
      }
      if (!native && !customReply) { setError(getComponentCopy(zh).enterYourAnswer); return; }
    }
    locked.current = true; setBusy(true); setError('');
    try {
      await submit({ action, values, customReply, displayAnswer: changes.length ? displayed : undefined });
      try { sessionStorage.removeItem(key); } catch { /* optional storage */ }
    } catch (reason) { setError(stripIpcErrorPrefix(reason)); }
    finally { locked.current = false; setBusy(false); }
  }
  return <form className="question-bar" aria-label={getComponentCopy(zh).modelQuestion} data-testid="question-bar"
    onSubmit={e => { e.preventDefault(); void send('accept'); }}>
    <header><small>{getComponentCopy(zh).modelQuestion}</small><strong>{question.message}</strong></header>
    {question.fields.map(f => {
      const val = draft.values[f.name];
      return <fieldset key={f.name} disabled={busy}>
        {f.title !== question.message && <legend>{f.title}{f.required ? ' *' : ''}</legend>}
        {f.description && <small>{f.description}</small>}
        {f.choices ? <div className="question-options">{f.choices.map(option => {
          const selected = Array.isArray(val) ? val.includes(option.value) : val === option.value;
          const id = editKey(f.name, option.value);
          return <div key={option.value}><button type="button" aria-pressed={selected} className="question-option"
            title={option.description} onClick={() => setValue(f.name, f.type === 'array'
              ? (selected ? (val as string[]).filter(v => v !== option.value) : [...(Array.isArray(val) ? val : []), option.value]) : option.value)}>
            {option.label}{option.description && <small>{option.description}</small>}</button>
            {selected && <input aria-label={(getComponentCopy(zh).editOption) + option.label} value={draft.edits[id] ?? option.label}
              onChange={e => setDraft(prev => ({ ...prev, edits: { ...prev.edits, [id]: e.target.value } }))} />}
          </div>;
        })}</div> : f.type === 'boolean' ? <select aria-label={f.title} value={val === undefined ? '' : String(val)}
          onChange={e => setValue(f.name, e.target.value === '' ? undefined : e.target.value === 'true')}>
          <option value="">—</option><option value="true">{getComponentCopy(zh).yes}</option><option value="false">{getComponentCopy(zh).no}</option></select> :
          f.type === 'string' ? <textarea aria-label={f.title} rows={2} value={String(val ?? '')} maxLength={f.maxLength}
            onChange={e => setValue(f.name, e.target.value || undefined)} /> :
          <input type="number" aria-label={f.title} min={f.minimum} max={f.maximum} step={f.type === 'integer' ? 1 : 'any'} value={String(val ?? '')}
            onChange={e => {
              // 清空或输入不完整（如单独的 “-”、“e”）时 valueAsNumber 为 NaN，不能写入草稿。
              const n = e.target.valueAsNumber;
              setValue(f.name, e.target.value === '' || Number.isNaN(n) ? undefined : n);
            }} />}
      </fieldset>;
    })}
    {canCustom && !free && (customOpen
      ? <textarea aria-label={getComponentCopy(zh).customAnswer} autoFocus rows={2} value={draft.custom}
          onChange={e => setDraft(prev => ({ ...prev, custom: e.target.value }))} />
      : <button type="button" className="status-link" onClick={() => setCustomOpen(true)}>{getComponentCopy(zh).customAnswer}</button>)}
    {(error || sendError) && <p role="alert" className="question-error">{error || sendError}</p>}
    <footer>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void send('decline')}>{getComponentCopy(zh).skip}</button>
      {native && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void send('cancel')}>{getComponentCopy(zh).cancel2}</button>}
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>{getComponentCopy(zh).sendAnswer}</button>
    </footer>
  </form>;
}
