import { getComponentCopy } from '../i18n/domains/copy';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ExternalLink, FileCode2, FolderOpen, Image as ImageIcon, MessageSquarePlus, Pencil, Quote, Trash2, X } from 'lucide-react';
import { EXECUTABLE_OR_SCRIPT_EXT_RE, isPlausibleLocalFileCandidate, type ClientLocale } from '@shared';
import { getDesktopBridge } from '../services/desktop-bridge';
import { copyMessageImageToClipboard } from './MessageImage';
import { decodeLocalTarget } from './MediaGallery';
import { useI18n } from '../i18n/I18nContext';
import { UI_DICTIONARIES, stripIpcErrorPrefix } from '../i18n/locales';
import { isImeComposing } from '../lib/platform-keys';
import { copyTextToClipboard } from '../lib/clipboard';
import { Icon } from './ui/Icon';

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

// 与主进程同源的可执行 / 脚本 / 安装包后缀（@shared EXECUTABLE_OR_SCRIPT_EXT_RE，另含 Windows `.url` 快捷方式）：
// 这类目标只提供「在访达 / 文件管理器中定位」。
function isExecutableTarget(base: string): boolean {
  return EXECUTABLE_OR_SCRIPT_EXT_RE.test(base) || /\.url$/i.test(base);
}
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
  if (isExecutableTarget(base)) {
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

/**
 * 判断文本是否像真实的本地文件或目录引用。统一委托共享契约 `isPlausibleLocalFileCandidate()`，
 * 裸扩展名（`.svg`、`.png`、`.ico`）、连字符后缀片段（`-mac.png`）、通配符与模板占位符一律不识别。
 */
export function looksLikePlausibleLocalTarget(rawText: string): boolean {
  return isPlausibleLocalFileCandidate(rawText);
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
        // decodeLocalTarget 只在 Windows 盘符前去掉斜杠，macOS 的 /Users/... 保留前导 `/`。
        display = decodeLocalTarget(rawSource);
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
      const decoded = decodeLocalTarget(rawHref);
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
  locale: _locale,
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

  const { keys, dict } = useI18n();
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
                <Icon icon={Quote} size="xs" />
                <span>{dict.ui.copy.quote}</span>
              </button>
              <span className="selection-pill-sep" />
              <button
                type="button"
                className="selection-pill-btn is-accent"
                onClick={() => setAnnotating(true)}
                data-testid="selection-annotate-btn"
              >
                <Icon icon={MessageSquarePlus} size="xs" />
                <span>{dict.ui.copy.notation}</span>
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
                  aria-label={dict.ui.copy.close}
                >
                  <Icon icon={X} size="xs" />
                </button>
              </div>
              <textarea
                ref={inputRef}
                className="input selection-notation-textarea"
                rows={2}
                placeholder={dict.ui.copy.fmtAddNotationForThis(keys(['enter']))}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  // 输入法组词时回车 / Esc 交给输入法（macOS 拼音确认、取消候选）。
                  if (isImeComposing(e)) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
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
                  <Icon icon={Quote} size="xs" />
                  <span>{dict.ui.copy.quoteInstead}</span>
                </button>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!comment.trim()}
                  onClick={submitNotation}
                  data-testid="selection-notation-save-btn"
                >
                  <Icon icon={Check} size="xs" />
                  <span>{dict.ui.copy.saveMark}</span>
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
                      if (isImeComposing(e)) return;
                      if (e.key === 'Enter' && editValue.trim()) {
                        onUpdate(item.id, editValue.trim());
                        setEditingId(null);
                      } else if (e.key === 'Escape') {
                        // 只取消本条批注编辑：阻止冒泡到窗格级 Esc，避免误中止运行中的 AI 回合。
                        e.preventDefault();
                        e.stopPropagation();
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
                    {getComponentCopy(locale).save2}
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
                title={getComponentCopy(locale).editNotation}
                aria-label={getComponentCopy(locale).editNotation}
                onClick={() => {
                  setEditingId(item.id);
                  setEditValue(item.comment);
                }}
              >
                <Icon icon={Pencil} size="sm" />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                title={getComponentCopy(locale).removeNotation2}
                aria-label={getComponentCopy(locale).removeNotation2}
                onClick={() => onRemove(item.id)}
                data-testid={`remove-notation-${item.id}`}
              >
                <Icon icon={Trash2} size="xs" />
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
  // macOS 使用「访达 / Finder」措辞；文案随菜单自身的 locale 取词典，平台取自 I18nProvider。
  const { mac, dict } = useI18n();
  const v031 = UI_DICTIONARIES[locale].ui.v031;
  const revealFileLabel = mac ? v031.ctxRevealFileFinder : v031.ctxRevealFile;
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
        onError(dict.ui.copy.failedToCopyImageTo);
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
        void copyTextToClipboard(detected.displayPath);
        return;
      }
      if (onError) {
        onError(stripIpcErrorPrefix(err));
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
            <Icon icon={ImageIcon} size="sm" />
            <span>{dict.ui.copy.copyImage}</span>
          </button>
          {isLocalImage && (
            <button
              type="button"
              className="menu-item"
              onClick={() => void invokeOpen('reveal-in-folder')}
              data-testid="ctx-reveal-folder"
            >
              <Icon icon={FolderOpen} size="sm" />
              <span>{revealFileLabel}</span>
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
          <Icon icon={ExternalLink} size="sm" />
          <span>{dict.ui.copy.openInLocalBrowser}</span>
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
            <Icon icon={FileCode2} size="sm" />
            <span>{dict.ui.copy.openWithDefaultApp}</span>
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => void invokeOpen('reveal-in-folder')}
            data-testid="ctx-reveal-folder"
          >
            <Icon icon={FolderOpen} size="sm" />
            <span>{revealFileLabel}</span>
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
          <Icon icon={FolderOpen} size="sm" />
          <span>
            {detected.kind === 'directory'
              ? mac ? v031.ctxOpenFolderFinder : v031.ctxOpenFolder
              : mac ? v031.ctxRevealExecutableFinder : v031.ctxRevealExecutable}
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
            <Icon icon={Copy} size="sm" />
            <span>
              {detected.kind === 'url'
                ? dict.ui.copy.copyLinkUrl
                : dict.ui.copy.copyLocalPath}
            </span>
          </button>
        </>
      )}
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(menuEl, document.body) : menuEl;
}
