import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen, RotateCw, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { getDesktopBridge } from '../services/desktop-bridge';
import { isImeComposing, isPrimaryModifier } from '../lib/platform-keys';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { Icon } from './ui/Icon';

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

/** 大图预览中可切换的一张图片。`url` 为已解析可直接加载的地址（优先受控 data URL）。 */
export interface LightboxEntry {
  source: string;
  url: string;
  label: string;
  width?: number;
  height?: number;
  format?: string;
  /** 本地文件可在系统文件管理器（macOS 为访达）中定位 */
  revealTarget?: string;
}

/** 根据扩展名、data URL 或 MIME 推断图片格式徽标（PNG / SVG / WEBP）。 */
export function imageFormatLabel(source: string, ext?: string, mimeType?: string): string {
  const fromExt = (ext || '').replace(/^\./, '').toLowerCase();
  if (fromExt) return fromExt === 'jpeg' ? 'JPG' : fromExt.toUpperCase();
  const dataMime = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(source)?.[1] || /^image\/([a-z0-9.+-]+)$/i.exec(mimeType || '')?.[1];
  if (dataMime) {
    const clean = dataMime.toLowerCase().replace('svg+xml', 'svg').replace('jpeg', 'jpg');
    return clean.toUpperCase();
  }
  const path = source.replace(/[?#].*$/, '');
  const m = /\.([a-z0-9]{2,5})$/i.exec(path);
  if (!m) return '';
  const lower = m[1].toLowerCase();
  return lower === 'jpeg' ? 'JPG' : lower.toUpperCase();
}

/** 是否为可在文件管理器中定位的本地图片（排除 data:/blob:/http(s)）。 */
export function isLocalImageSource(source: string): boolean {
  const value = source.trim();
  if (!value || /^(?:data|blob|https?):/i.test(value)) return false;
  return true;
}

export interface MessageImageProps {
  source: string;
  alt: string;
  title?: string;
  /** 受控预览地址（主进程返回的 previewDataUrl 或附件 dataUrl），优先于 source 解析结果 */
  displayUrl?: string;
  /** 同一条消息内可在大图预览中切换的图片序列 */
  gallery?: LightboxEntry[];
  galleryIndex?: number;
  /** 图片加载后回报自然尺寸，用于画廊判断全景通栏与尺寸标注 */
  onNaturalSize?: (width: number, height: number) => void;
  /** 加载失败时回报，画廊可将其从网格中移除 */
  onLoadError?: () => void;
}

export function MessageImage({ source, alt, title, displayUrl, gallery, galleryIndex, onNaturalSize, onLoadError }: MessageImageProps) {
  const workspace = useContext(ImageWorkspace);
  const sessionId = useContext(ImageSessionContext);
  const { dict } = useI18n();
  const url = displayUrl || resolveImage(source, workspace);
  const [failed, setFailed] = useState<string>();
  const [retryCount, setRetryCount] = useState(0);
  const [openError, setOpenError] = useState('');
  const [zoom, setZoom] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealError, setRevealError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const thumbImgRef = useRef<HTMLImageElement>(null);
  const copyTimer = useRef<number | null>(null);
  const label = alt || (dict.ui.copy.image);

  const entries: LightboxEntry[] = gallery && gallery.length > 0
    ? gallery
    : url ? [{ source, url, label, revealTarget: isLocalImageSource(source) ? source : undefined }] : [];
  const baseIndex = gallery && gallery.length > 0 ? Math.max(0, Math.min(gallery.length - 1, galleryIndex ?? 0)) : 0;

  const copyFrom = useCallback(async (entry: { source: string; url: string }, imgEl: HTMLImageElement | null) => {
    const ok = await copyMessageImageToClipboard({
      source: entry.source,
      resolvedUrl: entry.url,
      imgEl,
      cwd: workspace || undefined,
      sessionId: sessionId || undefined,
    });
    if (ok) {
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    }
    return ok;
  }, [sessionId, workspace]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const isRemoteBlockedByCsp = Boolean(url && !displayUrl && /^https?:/i.test(url));
  if (isRemoteBlockedByCsp && url) {
    return (
      <span className="md-img-blocked" data-testid="md-img-blocked-capsule" data-remote-src={url} title={dict.ui.v035.imageBlockedTitle}>
        <span className="md-img-blocked-label truncate">{alt || url}</span>
        <button
          type="button"
          className="btn btn-sm md-img-blocked-btn"
          data-testid="md-img-blocked-open-btn"
          onClick={() => {
            setOpenError('');
            void getDesktopBridge()
              .openLinkOrFileTarget({ target: url, action: 'browser', cwd: workspace || undefined, sessionId: sessionId || undefined })
              .catch((reason) => setOpenError(dict.ui.v031.linkOpenFailed(stripIpcErrorPrefix(reason))));
          }}
        >
          <Icon icon={ExternalLink} size="xs" />
          <span>{dict.ui.v035.imageBlockedOpen}</span>
        </button>
        {openError && <span role="alert" className="md-inline-error">{openError}</span>}
      </span>
    );
  }

  if (!url) {
    return <span className="muted md-img-unavailable">{alt || dict.ui.v031.imageUnavailable}</span>;
  }
  if (failed === url) {
    return (
      <span className="muted md-img-unavailable" data-testid="md-img-failed">
        <span>{alt || dict.ui.v031.imageUnavailable}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm md-img-retry"
          data-testid="md-img-retry-btn"
          onClick={() => {
            setFailed(undefined);
            setRetryCount((n) => n + 1);
          }}
        >
          <Icon icon={RotateCw} size="xs" />
          <span>{dict.ui.v035.imageRetry}</span>
        </button>
      </span>
    );
  }
  const close = () => {
    setZoom(false);
    // FE-02：关闭灯箱即清空「在文件夹/访达中显示」的失败提示，避免残留在缩略图下方。
    setRevealError('');
    window.setTimeout(() => trigger.current?.focus(), 0);
  };
  return <>
    <span className="message-image-wrap" data-image-source={source} data-image-url={url}>
      <button type="button" ref={trigger} className="message-image" aria-label={label} onClick={() => setZoom(true)}>
        <img
          key={`${url}#${retryCount}`}
          ref={thumbImgRef}
          className="md-img"
          src={url}
          alt={alt}
          title={title || label}
          loading="lazy"
          decoding="async"
          onLoad={e => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) onNaturalSize?.(img.naturalWidth, img.naturalHeight);
          }}
          onError={() => { setFailed(url); onLoadError?.(); }}
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
          void copyFrom({ source, url }, thumbImgRef.current);
        }}
      >
        {copied ? <Icon icon={Check} size="xs" /> : <Icon icon={Copy} size="xs" />}
      </button>
    </span>
    {revealError && !zoom && <span role="alert" className="md-inline-error">{revealError}</span>}
    {zoom && entries.length > 0 && createPortal(
      <ImageLightbox
        entries={entries}
        startIndex={baseIndex}
        copied={copied}
        onCopy={(entry, imgEl) => copyFrom(entry, imgEl ?? (entry.url === url ? thumbImgRef.current : null))}
        onReveal={(target) => {
          setRevealError('');
          void getDesktopBridge()
            .openLinkOrFileTarget({ target, action: 'reveal-in-folder', cwd: workspace || undefined, sessionId: sessionId || undefined })
            .catch(reason => setRevealError(dict.ui.v031.linkOpenFailed(stripIpcErrorPrefix(reason))));
        }}
        revealError={revealError}
        onDismissRevealError={() => setRevealError('')}
        onClose={close}
      />,
      document.body
    )}
  </>;
}

/**
 * 大图预览：顶部显示文件名、分辨率与格式；`←` / `→` 在本条消息的图片间切换，
 * 主修饰键 + C（macOS 为 ⌘C，Windows / Linux 为 Ctrl 加 C）复制当前图片，`Esc` 关闭。
 * 只认当前平台的主修饰键，macOS 上 Ctrl 加 C 不触发复制。关闭按钮始终是 `<dialog>` 内第一个按钮。
 */
export function ImageLightbox({
  entries,
  startIndex,
  copied,
  onCopy,
  onReveal,
  revealError,
  onDismissRevealError,
  onClose,
}: {
  entries: LightboxEntry[];
  startIndex: number;
  copied: boolean;
  onCopy: (entry: LightboxEntry, imgEl: HTMLImageElement | null) => Promise<boolean> | void;
  onReveal?: (target: string) => void;
  /** FE-02：定位失败提示渲染在 `<dialog>` 内部（Top Layer 之上），不会被模态遮罩挡住 */
  revealError?: string;
  onDismissRevealError?: () => void;
  onClose: () => void;
}) {
  const { dict, shortcut, mac } = useI18n();
  const strings = dict.ui.v031;
  const dialog = useRef<HTMLDialogElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [index, setIndex] = useState(() => Math.max(0, Math.min(entries.length - 1, startIndex)));
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const entry = entries[Math.min(index, entries.length - 1)];
  const total = entries.length;

  const step = useCallback((delta: number) => {
    if (total < 2) return;
    setNatural(null);
    // 翻到另一张图时清除上一张的「定位失败」提示，避免错误挂在新图片上。
    onDismissRevealError?.();
    setIndex(prev => (prev + delta + total) % total);
  }, [onDismissRevealError, total]);

  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (isPrimaryModifier(e, mac) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        const selection = typeof window.getSelection === 'function' ? window.getSelection()?.toString() : '';
        if (selection) return;
        e.preventDefault();
        void onCopy(entry, imgRef.current);
        return;
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry, mac, onCopy, step]);

  if (!entry) return null;
  const width = entry.width || natural?.w;
  const height = entry.height || natural?.h;
  const metaParts = [
    width && height ? `${width}×${height}` : '',
    entry.format || imageFormatLabel(entry.source),
  ].filter(Boolean);
  return <dialog
    ref={dialog}
    className="image-lightbox"
    aria-label={entry.label}
    onCancel={(e) => { e.preventDefault(); onClose(); }}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}
  >
    <div className="image-lightbox-bar">
      <button type="button" autoFocus className="icon-btn image-lightbox-close" onClick={onClose} aria-label={strings.closePreview} title={strings.closePreview}>
        <Icon icon={X} size="md" />
      </button>
      <div className="image-lightbox-title">
        <strong title={entry.source}>{entry.label}</strong>
        {metaParts.length > 0 && <span className="image-lightbox-meta">{metaParts.join(' · ')}</span>}
        {total > 1 && <span className="image-lightbox-meta" data-testid="lightbox-position">{strings.lightboxPosition(index + 1, total)}</span>}
      </div>
      <div className="image-lightbox-actions">
        {total > 1 && <>
          <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label={strings.lightboxPrev} title={`${strings.lightboxPrev} (←)`} data-testid="lightbox-prev-btn">
            <Icon icon={ChevronLeft} size="md" />
          </button>
          <button type="button" className="icon-btn" onClick={() => step(1)} aria-label={strings.lightboxNext} title={`${strings.lightboxNext} (→)`} data-testid="lightbox-next-btn">
            <Icon icon={ChevronRight} size="md" />
          </button>
        </>}
        {entry.revealTarget && onReveal && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onReveal(entry.revealTarget!)}
            title={mac ? strings.revealInFinder : strings.revealInFolder}
            data-testid="lightbox-reveal-btn"
          >
            <Icon icon={FolderOpen} size="sm" />
            <span>{mac ? strings.revealInFinder : strings.revealInFolder}</span>
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm image-lightbox-copy ${copied ? 'is-copied' : ''}`}
          onClick={() => void onCopy(entry, imgRef.current)}
          title={`${dict.ui.copyImageAction} (${shortcut('C')})`}
          data-testid="lightbox-copy-image-btn"
        >
          {copied ? <Icon icon={Check} size="sm" /> : <Icon icon={Copy} size="sm" />}
          <span>{copied ? dict.ui.copiedImageAction : dict.ui.copyImageAction}</span>
        </button>
      </div>
    </div>
    {revealError && (
      <div role="alert" className="image-lightbox-error" data-testid="lightbox-reveal-error">
        <span>{revealError}</span>
        {onDismissRevealError && (
          <button type="button" className="icon-btn icon-btn-sm" onClick={onDismissRevealError} aria-label={strings.dismissAction} title={strings.dismissAction}>
            <Icon icon={X} size="xs" />
          </button>
        )}
      </div>
    )}
    <div className="image-lightbox-stage" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <img
        key={entry.url}
        ref={imgRef}
        src={entry.url}
        alt={entry.label}
        onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
    </div>
  </dialog>;
}
