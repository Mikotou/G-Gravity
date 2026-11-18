import React, { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { ChatMessageItem, ReviseMessageInput } from '@shared';
import { canResendAttachment } from '../../shared/message-revision';
import { useI18n } from '../i18n/I18nContext';

export function EditUserMessage({ message, busy, submit, children, editRequest = 0, latest }: {
  latest?: boolean; editRequest?: number;
  message: ChatMessageItem; busy: boolean; submit: (input: ReviseMessageInput) => Promise<void>; children: React.ReactNode;
}) {
  const zh = useI18n().locale === 'zh-CN';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const seenRequest = useRef(editRequest);
  function start() {
    setDraft(message.content);
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
    if (busy || lock.current || (!draft.trim() && !attachments.length)) return;
    lock.current = true; setPending(true); setError('');
    try { await submit({ sessionId: message.sessionId, messageId: message.id, text: draft, attachmentIds: attachments }); setEditing(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setPending(false); }
  }
  if (!editing) return <>{children}<button ref={button} type="button" className={"icon-btn edit-message" + (latest ? " edit-latest" : "")} disabled={busy}
    data-testid={'edit-msg-' + message.id} aria-label={zh ? '编辑消息' : 'Edit message'} title={latest ? (zh ? '编辑上一条消息（输入框内按 ↑）' : 'Edit last message (↑ in empty composer)') : (zh ? '编辑消息' : 'Edit message')}
    onClick={start}>
    <Pencil size={13} /></button></>;
  return <form className="message-editor" onSubmit={e => { e.preventDefault(); void send(); }}>
    <textarea ref={editor} autoFocus aria-label={zh ? '编辑原消息' : 'Edit original message'} value={draft} disabled={pending} rows={4}
      onChange={e => setDraft(e.target.value)} onKeyDown={e => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
      }} />
    {message.attachments?.map(a => <label key={a.id}><input type="checkbox" checked={attachments.includes(a.id)}
      disabled={pending || !canResendAttachment(a)} onChange={e => setAttachments(e.target.checked ? [...attachments, a.id] : attachments.filter(id => id !== a.id))} />
      {a.name}{!canResendAttachment(a) && (zh ? '（原文件不可用）' : ' (original unavailable)')}</label>)}
    <small className="muted">{zh ? '从此处开始新的对话分支。原对话会保留，已有文件改动也会保留。' : 'Continue in a new branch from here. The original conversation and existing file changes are preserved.'}</small>
    {error && <div role="alert">{error}</div>}
    <div className="message-editor-actions">
      <button className="btn btn-sm" type="button" onClick={cancel} disabled={pending}>{zh ? '取消' : 'Cancel'}</button>
      <button className="btn btn-primary btn-sm" type="submit" disabled={busy || pending || (!draft.trim() && !attachments.length)}>{zh ? '重新发送' : 'Resend'}</button>
    </div>
  </form>;
}
