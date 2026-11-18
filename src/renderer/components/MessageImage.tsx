import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

export const ImageWorkspace = createContext('');
const embedded = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,[a-z\d+/=\s]+$/i;
function filePath(value: string): string {
  return value.replace(/\\/g, '/').split('/').map((part, i) => {
    if (!i && /^[a-z]:$/i.test(part)) return part;
    try { return encodeURIComponent(decodeURIComponent(part)); }
    catch { return encodeURIComponent(part); }
  }).join('/');
}
export function resolveImage(raw: string, workspace: string): string | undefined {
  const value = raw.trim().replace(/^<|>$/g, '');
  if (!value || /[\x00-\x1f]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) return;
  if (embedded.test(value)) return value;
  if (/^[a-z]:[\\/]/i.test(value)) return 'file:///' + filePath(value);
  try {
    if (/^[a-z][\w+.-]*:/i.test(value)) {
      const uri = new URL(value);
      if (uri.protocol === 'file:' && uri.hostname && uri.hostname !== 'localhost') return;
      return ['https:', 'http:', 'file:', 'blob:'].includes(uri.protocol) ? uri.href : undefined;
    }
    if (value.startsWith('/')) return 'file://' + filePath(value);
    if (!workspace) return;
    const base = filePath(workspace).replace(/\/+$/, '');
    return new URL(filePath(value), 'file://' + (base.startsWith('/') ? '' : '/') + base + '/').href;
  } catch { return; }
}

export function MessageImage({ source, alt, title }: { source: string; alt: string; title?: string }) {
  const workspace = useContext(ImageWorkspace);
  const { locale } = useI18n();
  const url = resolveImage(source, workspace);
  const [failed, setFailed] = useState<string>();
  const [zoom, setZoom] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (zoom) dialog.current?.showModal?.();
    return () => { if (zoom) trigger.current?.focus(); };
  }, [zoom]);
  if (!url || failed === url) return <span className="muted">{alt || (locale === 'zh-CN' ? '图片无法显示' : 'Image unavailable')}</span>;
  const close = () => setZoom(false);
  const label = alt || (locale === 'zh-CN' ? '图片' : 'Image');
  return <>
    <button type="button" ref={trigger} className="message-image" aria-label={label} onClick={() => setZoom(true)}>
      <img className="md-img" src={url} alt={alt} title={title || label} loading="lazy" onError={() => setFailed(url)} />
    </button>
    {zoom && createPortal(<dialog ref={dialog} className="image-lightbox" aria-label={label} onCancel={close}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <button type="button" autoFocus className="icon-btn" onClick={close} aria-label={locale === 'zh-CN' ? '关闭预览' : 'Close preview'}><X /></button>
      <img src={url} alt={alt} />
    </dialog>, document.body)}
  </>;
}
