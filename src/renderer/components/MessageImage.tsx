import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { getDesktopBridge } from '../services/desktop-bridge';

export const ImageWorkspace = createContext('');
export const ImageSessionContext = createContext('');
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

function rasterizeToPngDataUrl(img: HTMLImageElement | null): string | null {
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const match = /^data:([^;]+);base64$/i.exec(dataUrl.slice(0, comma));
  if (!match) return null;
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: match[1] });
  } catch {
    return null;
  }
}

/** 将消息中的图片以位图形式写入系统剪贴板（桌面端优先通过主进程 nativeImage 写入，自动兼容 WebP/SVG 与浏览器回退）。 */
export async function copyMessageImageToClipboard(options: {
  source: string;
  resolvedUrl: string;
  imgEl?: HTMLImageElement | null;
  cwd?: string;
  sessionId?: string;
}): Promise<boolean> {
  const { source, resolvedUrl, imgEl, cwd, sessionId } = options;
  const bridge = getDesktopBridge();
  const isRemote = /^(?:https?|blob):/i.test(resolvedUrl);

  // 1) 桌面端原生写入：本地文件或 data:image/* 先尝试直接复制，遇到 WebP/SVG 或远程图时自动转 PNG dataURL。
  if (!isRemote && !/^data:image\/(?:webp|svg\+xml|avif)/i.test(resolvedUrl)) {
    try {
      const target = resolvedUrl.startsWith('data:image/') ? resolvedUrl : resolvedUrl || source;
      await bridge.openLinkOrFileTarget({ target, action: 'copy-image', cwd, sessionId });
      return true;
    } catch {
      /* 尝试光栅化为 PNG 再交由主进程写入 */
    }
  }

  const pngDataUrl = rasterizeToPngDataUrl(imgEl ?? null);
  if (pngDataUrl) {
    try {
      await bridge.openLinkOrFileTarget({ target: pngDataUrl, action: 'copy-image', cwd, sessionId });
      return true;
    } catch {
      /* 继续尝试浏览器 Clipboard API */
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const blob = dataUrlToBlob(pngDataUrl);
      if (blob) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          return true;
        } catch {
          /* fall through */
        }
      }
    }
  }

  try {
    await bridge.openLinkOrFileTarget({ target: resolvedUrl || source, action: 'copy-image', cwd, sessionId });
    return true;
  } catch {
    return false;
  }
}

export function MessageImage({ source, alt, title }: { source: string; alt: string; title?: string }) {
  const workspace = useContext(ImageWorkspace);
  const sessionId = useContext(ImageSessionContext);
  const { locale, dict } = useI18n();
  const url = resolveImage(source, workspace);
  const [failed, setFailed] = useState<string>();
  const [zoom, setZoom] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const thumbImgRef = useRef<HTMLImageElement>(null);
  const lightboxImgRef = useRef<HTMLImageElement>(null);
  const copyTimer = useRef<number | null>(null);

  const handleCopyImage = useCallback(async () => {
    if (!url) return;
    const ok = await copyMessageImageToClipboard({
      source,
      resolvedUrl: url,
      imgEl: zoom ? (lightboxImgRef.current || thumbImgRef.current) : thumbImgRef.current,
      cwd: workspace || undefined,
      sessionId: sessionId || undefined,
    });
    if (ok) {
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    }
  }, [sessionId, source, url, workspace, zoom]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (zoom) dialog.current?.showModal?.();
    return () => { if (zoom) trigger.current?.focus(); };
  }, [zoom]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void handleCopyImage();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleCopyImage, zoom]);

  if (!url || failed === url) return <span className="muted">{alt || (locale === 'zh-CN' ? '图片无法显示' : 'Image unavailable')}</span>;
  const close = () => setZoom(false);
  const label = alt || (locale === 'zh-CN' ? '图片' : 'Image');
  return <>
    <span className="message-image-wrap" data-image-source={source} data-image-url={url}>
      <button type="button" ref={trigger} className="message-image" aria-label={label} onClick={() => setZoom(true)}>
        <img
          ref={thumbImgRef}
          className="md-img"
          src={url}
          alt={alt}
          title={title || label}
          loading="lazy"
          onError={() => setFailed(url)}
        />
      </button>
      <button
        type="button"
        className={`icon-btn icon-btn-sm message-image-copy ${copied ? 'is-copied' : ''}`}
        title={copied ? dict.ui.copiedImageAction : dict.ui.copyImageAction}
        aria-label={copied ? dict.ui.copiedImageAction : dict.ui.copyImageAction}
        data-testid="copy-message-image-btn"
        onClick={(e) => {
          e.stopPropagation();
          void handleCopyImage();
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
    {zoom && createPortal(<dialog ref={dialog} className="image-lightbox" aria-label={label} onCancel={close}
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="image-lightbox-bar">
        <button type="button" autoFocus className="icon-btn" onClick={close} aria-label={locale === 'zh-CN' ? '关闭预览' : 'Close preview'}><X size={16} /></button>
        <button
          type="button"
          className={`btn btn-sm image-lightbox-copy ${copied ? 'is-copied' : ''}`}
          onClick={() => void handleCopyImage()}
          data-testid="lightbox-copy-image-btn"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? dict.ui.copiedImageAction : dict.ui.copyImageAction}</span>
        </button>
      </div>
      <img ref={lightboxImgRef} src={url} alt={alt} />
    </dialog>, document.body)}
  </>;
}
