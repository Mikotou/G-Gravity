import { getComponentCopy } from '../i18n/domains/copy';
import React, { useEffect, useRef, useState } from 'react';
import { SquarePen } from 'lucide-react';
import type { ChatMessageItem, ReviseMessageInput } from '@shared';
import { canResendAttachment } from '../../shared/message-revision';
import { useI18n } from '../i18n/I18nContext';
import { isImeComposing, isPrimaryModifier } from '../lib/platform-keys';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { Icon } from './ui/Icon';

export function EditUserMessage({ message, busy, submit, children, editRequest = 0, latest }: {
  latest?: boolean; editRequest?: number;
  message: ChatMessageItem; busy: boolean; submit: (input: ReviseMessageInput) => Promise<void>; children: React.ReactNode;
}) {
  const { locale, mac, dict } = useI18n();
  const t6 = dict.ui.v036;
  const zh = locale === 'zh-CN';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [annotations, setAnnotations] = useState(message.annotations || []);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const seenRequest = useRef(editRequest);
  function start() {
    setDraft(message.content);
    setAnnotations(message.annotations || []);
    setAttachments((message.attachments || []).filter(canResendAttachment).map(a => a.id));
    setError('');
    setEditing(true);
  }
  useEffect(() => {
    if (seenRequest.current !== editRequest && !busy) start();
    seenRequest.current = editRequest;
  }, [editRequest]);
  useEffect(() => {
    if (editing) { editor.current?.focus(); editor.current?.scrollIntoView?.({ block: 'nearest' }); }
  }, [editing]);
  function cancel() {
    if (lock.current) return;
    setEditing(false); requestAnimationFrame(() => button.current?.focus());
  }
  async function send() {
    if (busy || lock.current || (!draft.trim() && !attachments.length && !annotations.length)) return;
    lock.current = true; setPending(true); setError('');
    // 批注 trim 后为空归一为 undefined（仅引用）；保持条目原序
    const normalized = annotations.map(a => {
      const comment = a.comment?.trim();
      const { comment: _drop, ...rest } = a;
      return comment ? { ...rest, comment } : rest;
    });
    try { await submit({ sessionId: message.sessionId, messageId: message.id, text: draft, attachmentIds: attachments, ...(normalized.length ? { annotations: normalized } : {}) }); setEditing(false); }
    catch (e) { setError(stripIpcErrorPrefix(e)); }
    finally { lock.current = false; setPending(false); }
  }
  if (!editing) return <>{children}<button ref={button} type="button" className={"icon-btn edit-message" + (latest ? " edit-latest" : "")} disabled={busy}
    data-testid={'edit-msg-' + message.id} aria-label={getComponentCopy(zh).editMessage} title={latest ? (getComponentCopy(zh).editLastMessageInEmpty) : (getComponentCopy(zh).editMessage)}
    onClick={start}>
    <Icon icon={SquarePen} size="sm" /></button></>;
  const editorKeys = (e: React.KeyboardEvent) => {
    if (isImeComposing(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    if (e.key === 'Enter' && isPrimaryModifier(e, mac)) { e.preventDefault(); void send(); }
  };
  return <form className="message-editor" onSubmit={e => { e.preventDefault(); void send(); }}>
    {annotations.length > 0 && <ol className="annotation-list is-editing">
      {annotations.map((item, index) => <li className="sent-annotation" key={item.id ?? index}>
        <span className="annotation-num">#{index + 1}</span>
        <blockquote>{item.excerpt}</blockquote>
        <textarea className="annotation-edit-input" aria-label={(getComponentCopy(zh).editAnnotation) + (index + 1)} placeholder={t6.annEditOptional}
          rows={1} disabled={pending} value={item.comment ?? ''} onKeyDown={editorKeys}
          onChange={e => setAnnotations(annotations.map((a, i) => i === index ? { ...a, comment: e.target.value } : a))} />
      </li>)}
    </ol>}
    <textarea ref={editor} autoFocus aria-label={getComponentCopy(zh).editOriginalMessage} value={draft} disabled={pending} rows={4}
      onChange={e => setDraft(e.target.value)} onKeyDown={editorKeys} />
    {message.attachments?.map(a => <label key={a.id}><input type="checkbox" checked={attachments.includes(a.id)}
      disabled={pending || !canResendAttachment(a)} onChange={e => setAttachments(e.target.checked ? [...attachments, a.id] : attachments.filter(id => id !== a.id))} />
      {a.name}{!canResendAttachment(a) && (getComponentCopy(zh).originalUnavailable)}</label>)}
    <small className="muted">{getComponentCopy(zh).createsANewBranchFrom}</small>
    {error && <div role="alert" className="alert message-editor-error">{error}</div>}
    <div className="message-editor-actions">
      <button className="btn btn-sm" type="button" onClick={cancel} disabled={pending}>{getComponentCopy(zh).cancel}</button>
      <button className="btn btn-primary btn-sm" type="submit" disabled={busy || pending || (!draft.trim() && !attachments.length && !annotations.length)}>{getComponentCopy(zh).resend}</button>
    </div>
  </form>;
}
