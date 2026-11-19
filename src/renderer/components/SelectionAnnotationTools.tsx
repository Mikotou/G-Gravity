import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ExternalLink, FileCode2, FolderOpen, Image as ImageIcon, MessageSquarePlus, Pencil, Quote, Trash2, X } from 'lucide-react';
import type { ClientLocale } from '@shared';
import { getDesktopBridge } from '../services/desktop-bridge';
import { copyMessageImageToClipboard } from './MessageImage';

export interface TextQuoteItem {
  id: string;
  messageId: string;
  text: string;
}

export interface TextNotationItem {
  id: string;
  messageId: string;
  selectedText: string;
  messageNumber?: number;
  start?: number;
  anchorText?: string;
  comment: string;
  createdAt: string;
}

export type DetectedTargetKind = 'url' | 'openable-file' | 'executable-file' | 'directory' | 'image';

export interface DetectedContextTarget {
  kind: DetectedTargetKind;
  target: string;
  displayPath: string;
  imageUrl?: string;
  imageEl?: HTMLImageElement | null;
}

const EXECUTABLE_EXT_RE = /\.(?:exe|msi|msp|bat|cmd|ps1|psm1|vbs|vbe|jse|wsf|wsh|scr|pif|com|reg|dll|sys|cpl|hta|sh|bash|zsh)$/i;
const KNOWN_FILE_EXT_RE =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonl|jsonc|md|markdown|txt|log|csv|tsv|pdf|png|jpg|jpeg|gif|webp|svg|ico|html|htm|css|scss|less|yml|yaml|toml|ini|cfg|conf|xml|sql|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|swift|dart|vue|svelte|zip|7z|tar|gz|mp3|wav|mp4|webm|doc|docx|xls|xlsx|ppt|pptx|exe|msi|bat|cmd|ps1|dll|sh)$/i;

function stripLineHash(raw: string): string {
  return raw.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
}

function classifyLocalPathKind(rawPath: string): DetectedTargetKind {
  const cleaned = stripLineHash(rawPath.replace(/^file:\/\/\/?/i, '').trim());
  if (!cleaned || /[\\/]$/.test(cleaned)) {
    return 'directory';
  }
  const base = cleaned.split(/[\\/]/).pop() || '';
  if (EXECUTABLE_EXT_RE.test(base)) {
    return 'executable-file';
  }
  if (KNOWN_FILE_EXT_RE.test(base) || /^\.[A-Za-z0-9_-]+$/.test(base) || /^(?:dockerfile|makefile|readme|license)$/i.test(base)) {
    return 'openable-file';
  }
  // 含有路径分隔符但无后缀名时按目录处理，默认在文件管理器打开
  if (/[\\/]/.test(cleaned) && !base.includes('.')) {
    return 'directory';
  }
  return 'openable-file';
}

export function looksLikePlausibleLocalTarget(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.length > 360 || /\n/.test(trimmed)) return false;
  if (/^file:\/\//i.test(trimmed)) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (/^(?:\.{1,2}[\\/]|~[\\/])/.test(trimmed)) return true;
  // 不含空格的相对路径或带常见后缀的文件名（排除普通命令或 URL）
  if (!/\s/.test(trimmed) && !/^[a-z]+:\/\//i.test(trimmed) && !trimmed.startsWith('-')) {
    const clean = stripLineHash(trimmed);
    if (/[\\/]/.test(clean) && !clean.startsWith('/') && clean.length >= 3) {
      return KNOWN_FILE_EXT_RE.test(clean) || /^(?:src|tests|test|docs|scripts|public|release|dist|build|packages|apps)[\\/]/i.test(clean);
    }
    if (KNOWN_FILE_EXT_RE.test(clean) && !EXECUTABLE_EXT_RE.test(clean)) {
      return true;
    }
    if (/\.(?:exe|msi|ps1|bat|cmd|sh)$/i.test(clean)) {
      return true;
    }
  }
  return false;
}

/**
 * 从右击的 DOM 节点向上嗅探超链接或本地文件/目录引用。
 */
export function detectContextTargetFromElement(targetEl: HTMLElement | null): DetectedContextTarget | null {
  if (!targetEl) return null;

  const imageWrap = targetEl.closest('.message-image-wrap') as HTMLElement | null;
  const imgNode = (targetEl.tagName === 'IMG' ? targetEl : imageWrap?.querySelector('img.md-img')) as HTMLImageElement | null;
  if (imageWrap || imgNode?.classList.contains('md-img')) {
    const rawSource = imageWrap?.getAttribute('data-image-source') || imgNode?.getAttribute('src') || '';
    const resolvedUrl = imageWrap?.getAttribute('data-image-url') || imgNode?.getAttribute('src') || rawSource;
    if (resolvedUrl) {
      let display = imgNode?.alt || rawSource;
      if (/^file:\/\//i.test(rawSource)) {
        try { display = decodeURIComponent(rawSource.replace(/^file:\/\/\/?/i, '')); } catch { display = rawSource; }
      } else if (/^data:image\//i.test(rawSource)) {
        display = imgNode?.alt || 'Embedded image';
      }
      return {
        kind: 'image',
        target: rawSource || resolvedUrl,
        displayPath: display,
        imageUrl: resolvedUrl,
        imageEl: imgNode,
      };
    }
  }

  // Markdown 链接已标记过目标类型，优先取其原始地址。只有落在行内代码上时才从文字推断目标。
  const anchor = targetEl.closest('a.md-link') as HTMLAnchorElement | null;
  if (anchor) {
    const rawHref = anchor.getAttribute('data-link-href') || anchor.getAttribute('href') || '';
    const linkKind = anchor.getAttribute('data-link-kind');
    if (!rawHref || rawHref.startsWith('#')) return null;

    if (linkKind === 'external' || /^https?:\/\/|^mailto:/i.test(rawHref)) {
      return {
        kind: 'url',
        target: rawHref,
        displayPath: rawHref,
      };
    }

    if (linkKind === 'file' || /^file:\/\//i.test(rawHref) || /^[A-Za-z]:[\\/]/.test(rawHref)) {
      let decoded = rawHref;
      try {
        decoded = decodeURIComponent(rawHref.replace(/^file:\/\/\/?/i, ''));
      } catch {
        /* keep raw */
      }
      return {
        kind: classifyLocalPathKind(decoded),
        target: rawHref,
        displayPath: stripLineHash(decoded),
      };
    }
  }

  const inlineCode = targetEl.closest('code.inline') as HTMLElement | null;
  if (inlineCode) {
    const rawCode = (inlineCode.getAttribute('data-inline-code') || inlineCode.textContent || '').trim();
    if (/^https?:\/\//i.test(rawCode) && !/\s/.test(rawCode)) {
      return {
        kind: 'url',
        target: rawCode,
        displayPath: rawCode,
      };
    }
    if (looksLikePlausibleLocalTarget(rawCode)) {
      const cleaned = stripLineHash(rawCode);
      return {
        kind: classifyLocalPathKind(cleaned),
        target: cleaned,
        displayPath: cleaned,
      };
    }
  }

  return null;
}

/* ============================================================================
 * 1. 划词悬浮工具条（支持一键 Quote 引用 + Codex 式原地添加多处 Notation）
 * ========================================================================== */

export interface SelectionFloatingBarProps {
  x: number;
  y: number;
  selectedText: string;
  locale: ClientLocale;
  onQuote: () => void;
  onAddNotation: (comment: string) => void;
  onDismiss: () => void;
}

export function SelectionFloatingBar({
  x,
  y,
  selectedText,
  locale,
  onQuote,
  onAddNotation,
  onDismiss,
}: SelectionFloatingBarProps): React.ReactElement {
  const [annotating, setAnnotating] = useState(false);
  const [comment, setComment] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (annotating) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [annotating]);

  const isZh = locale === 'zh-CN';
  const clampedLeft = typeof window !== 'undefined' ? Math.max(16, Math.min(x, window.innerWidth - (annotating ? 340 : 210))) : x;
  const clampedTop = typeof window !== 'undefined' ? Math.max(12, Math.min(y, window.innerHeight - (annotating ? 190 : 56))) : y;

  function submitNotation(): void {
    const trimmed = comment.trim();
    if (!trimmed) return;
    onAddNotation(trimmed);
  }

  return typeof document !== 'undefined'
    ? createPortal(
        <div
          className={`selection-floating-bar ${annotating ? 'is-expanded' : ''}`}
          style={{ left: clampedLeft, top: clampedTop }}
          onMouseDown={(e) => e.stopPropagation()}
          data-testid="selection-floating-bar"
        >
          {!annotating ? (
            <div className="selection-pill-actions">
              <button
                type="button"
                className="selection-pill-btn"
                onClick={onQuote}
                data-testid="selection-quote-btn"
              >
                <Quote size={12} />
                <span>{isZh ? '引用' : 'Quote'}</span>
              </button>
              <span className="selection-pill-sep" />
              <button
                type="button"
                className="selection-pill-btn is-accent"
                onClick={() => setAnnotating(true)}
                data-testid="selection-annotate-btn"
              >
                <MessageSquarePlus size={12} />
                <span>{isZh ? '添加批注' : 'Notation'}</span>
              </button>
            </div>
          ) : (
            <div className="selection-notation-editor" data-testid="selection-notation-editor">
              <div className="selection-notation-preview">
                <span className="badge badge-accent badge-mono">Notation</span>
                <span className="truncate">「{selectedText.replace(/\s+/g, ' ').slice(0, 72)}」</span>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  onClick={onDismiss}
                  aria-label={isZh ? '关闭' : 'Close'}
                >
                  <X size={12} />
                </button>
              </div>
              <textarea
                ref={inputRef}
                className="input selection-notation-textarea"
                rows={2}
                placeholder={isZh ? '写下对该处内容的修改意见或疑问 (Enter 标记)…' : 'Add notation for this passage (Enter to save)…'}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submitNotation();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onDismiss();
                  }
                }}
                data-testid="selection-notation-input"
              />
              <div className="selection-notation-foot">
                <button type="button" className="btn btn-ghost btn-sm" onClick={onQuote}>
                  <Quote size={11} />
                  <span>{isZh ? '改为仅引用' : 'Quote instead'}</span>
                </button>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!comment.trim()}
                  onClick={submitNotation}
                  data-testid="selection-notation-save-btn"
                >
                  <Check size={12} />
                  <span>{isZh ? '标记批注' : 'Save mark'}</span>
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body
      )
    : <div />;
}

/* ============================================================================
 * 2. 消息轮次下方的 Codex 式多处标记批注钉（支持原地编辑与删除）
 * ========================================================================== */

export function TurnNotationPins({
  items,
  allNotations,
  locale,
  onUpdate,
  onRemove,
}: {
  items: TextNotationItem[];
  allNotations: TextNotationItem[];
  locale: ClientLocale;
  onUpdate: (id: string, nextComment: string) => void;
  onRemove: (id: string) => void;
}): React.ReactElement | null {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const isZh = locale === 'zh-CN';

  if (items.length === 0) return null;

  return (
    <div className="turn-notation-pins" data-testid="turn-notation-pins">
      {items.map((item) => {
        // 消息旁只显示该消息的批注，编号仍按整个会话的批注顺序计算，与最后发送的提示相对应。
        const globalIndex = Math.max(1, allNotations.findIndex((n) => n.id === item.id) + 1);
        const isEditing = editingId === item.id;
        return (
          <div key={item.id} className="turn-notation-card" data-testid={`turn-notation-${item.id}`}>
            <span className="turn-notation-num">#{globalIndex}</span>
            <div className="turn-notation-main">
              <div className="turn-notation-quote truncate" title={item.selectedText}>
                「{item.selectedText.replace(/\s+/g, ' ')}」
              </div>
              {isEditing ? (
                <div className="turn-notation-edit-row">
                  <input
                    className="input"
                    value={editValue}
                    autoFocus
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editValue.trim()) {
                        onUpdate(item.id, editValue.trim());
                        setEditingId(null);
                      } else if (e.key === 'Escape') {
                        setEditingId(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      if (editValue.trim()) {
                        onUpdate(item.id, editValue.trim());
                        setEditingId(null);
                      }
                    }}
                  >
                    {isZh ? '保存' : 'Save'}
                  </button>
                </div>
              ) : (
                <div className="turn-notation-comment">{item.comment}</div>
              )}
            </div>
            <div className="turn-notation-actions">
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                title={isZh ? '编辑批注' : 'Edit notation'}
                onClick={() => {
                  setEditingId(item.id);
                  setEditValue(item.comment);
                }}
              >
                <Pencil size={11} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                title={isZh ? '移除此标记' : 'Remove notation'}
                onClick={() => onRemove(item.id)}
                data-testid={`remove-notation-${item.id}`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * 3. 右击超链接 / 本地文件与目录上下文菜单
 * ========================================================================== */

export interface TargetContextMenuProps {
  x: number;
  y: number;
  detected: DetectedContextTarget;
  cwd: string;
  sessionId?: string;
  locale: ClientLocale;
  onClose: () => void;
  onError?: (msg: string) => void;
}

export function TargetContextMenu({
  x,
  y,
  detected,
  cwd,
  sessionId,
  locale,
  onClose,
  onError,
}: TargetContextMenuProps): React.ReactElement {
  const isZh = locale === 'zh-CN';
  const clampedLeft = typeof window !== 'undefined' ? Math.max(12, Math.min(x, window.innerWidth - 260)) : x;
  const clampedTop = typeof window !== 'undefined' ? Math.max(12, Math.min(y, window.innerHeight - 180)) : y;

  /** 将当前工作目录和会话号随目标一并传给主进程，以便解析相对路径。复制操作另有浏览器剪贴板后备路径。 */
  async function invokeOpen(action: 'browser' | 'default-app' | 'reveal-in-folder' | 'copy' | 'copy-image'): Promise<void> {
    onClose();
    if (action === 'copy-image') {
      const ok = await copyMessageImageToClipboard({
        source: detected.target,
        resolvedUrl: detected.imageUrl || detected.target,
        imgEl: detected.imageEl,
        cwd,
        sessionId,
      });
      if (!ok && onError) {
        onError(isZh ? '复制图片到剪贴板失败' : 'Failed to copy image to clipboard');
      }
      return;
    }
    try {
      await getDesktopBridge().openLinkOrFileTarget({
        target: detected.target,
        action,
        cwd,
        sessionId,
      });
    } catch (err) {
      if (action === 'copy') {
        void navigator.clipboard?.writeText(detected.displayPath).catch(() => {});
        return;
      }
      if (onError) {
        onError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  const isLocalImage = detected.kind === 'image' && !/^(?:data:|https?:|blob:)/i.test(detected.target);

  const menuEl = (
    <div
      className="popover target-context-menu"
      style={{ position: 'fixed', left: clampedLeft, top: clampedTop, zIndex: 220, minWidth: 236 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="target-context-menu"
    >
      <div className="menu-label truncate" title={detected.displayPath}>
        {detected.displayPath}
      </div>
      {detected.kind === 'image' && (
        <>
          <button
            type="button"
            className="menu-item"
            onClick={() => void invokeOpen('copy-image')}
            data-testid="ctx-copy-image"
          >
            <ImageIcon size={13} />
            <span>{isZh ? '复制图片' : 'Copy image'}</span>
          </button>
          {isLocalImage && (
            <button
              type="button"
              className="menu-item"
              onClick={() => void invokeOpen('reveal-in-folder')}
              data-testid="ctx-reveal-folder"
            >
              <FolderOpen size={13} />
              <span>{isZh ? '在文件管理器中定位' : 'Show in File Explorer'}</span>
            </button>
          )}
        </>
      )}
      {detected.kind === 'url' && (
        <button
          type="button"
          className="menu-item"
          onClick={() => void invokeOpen('browser')}
          data-testid="ctx-open-browser"
        >
          <ExternalLink size={13} />
          <span>{isZh ? '在本地浏览器中打开' : 'Open in local browser'}</span>
        </button>
      )}
      {detected.kind === 'openable-file' && (
        <>
          <button
            type="button"
            className="menu-item"
            onClick={() => void invokeOpen('default-app')}
            data-testid="ctx-open-default-app"
          >
            <FileCode2 size={13} />
            <span>{isZh ? '使用默认应用打开' : 'Open with default app'}</span>
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => void invokeOpen('reveal-in-folder')}
            data-testid="ctx-reveal-folder"
          >
            <FolderOpen size={13} />
            <span>{isZh ? '在文件管理器中定位' : 'Show in File Explorer'}</span>
          </button>
        </>
      )}
      {(detected.kind === 'executable-file' || detected.kind === 'directory') && (
        <button
          type="button"
          className="menu-item"
          onClick={() => void invokeOpen('reveal-in-folder')}
          data-testid="ctx-reveal-folder"
        >
          <FolderOpen size={13} />
          <span>
            {detected.kind === 'directory'
              ? isZh
                ? '在文件管理器中打开目录'
                : 'Open folder in File Explorer'
              : isZh
                ? '在文件管理器中定位文件'
                : 'Reveal executable in Explorer'}
          </span>
        </button>
      )}
      {(detected.kind !== 'image' || isLocalImage) && (
        <>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item"
            onClick={() => void invokeOpen('copy')}
            data-testid="ctx-copy-target"
          >
            <Copy size={13} />
            <span>
              {detected.kind === 'url'
                ? isZh
                  ? '复制链接地址'
                  : 'Copy link URL'
                : isZh
                  ? '复制本地路径'
                  : 'Copy local path'}
            </span>
          </button>
        </>
      )}
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(menuEl, document.body) : menuEl;
}
