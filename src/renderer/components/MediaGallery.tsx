import React, { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ExternalLink,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Maximize2,
  Terminal,
  X,
} from 'lucide-react';
import {
  EXECUTABLE_OR_SCRIPT_EXT_RE,
  MAX_LOCAL_INSPECT_TARGETS,
  extractLineAnchorBadge,
  extractTargetBaseName,
  formatByteSize,
  stripLocalTargetAnchor,
  type InspectedLocalTarget,
  type MessageAttachmentPreview,
} from '@shared';
import { getDesktopBridge, isUsingNativeDesktopBridge } from '../services/desktop-bridge';
import { useI18n } from '../i18n/I18nContext';
import {
  ImageSessionContext,
  ImageWorkspace,
  MessageImage,
  imageFormatLabel,
  isLocalImageSource,
  resolveImage,
  type LightboxEntry,
} from './MessageImage';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { Icon } from './ui/Icon';

/* ============================================================================
 * 安全 URL 解析（拒绝 javascript:/vbscript:/data:text 等危险协议）
 * ========================================================================== */

export interface SafeHref {
  href: string;
  kind: 'external' | 'file' | 'anchor';
  tooltip: string;
}

const POSIX_ABSOLUTE_RE = /^\/[^/\\]/;
const HOME_RELATIVE_RE = /^~[\\/]/;
const LINE_ANCHOR_RE = /#L?\d+(?:-L?\d+)?$/i;

/**
 * 是否为本机绝对路径：Windows 盘符（`F:\` / `F:/`）、POSIX 绝对路径（`/Users/...`、`/Volumes/...`、`/tmp/...`）
 * 或主目录相对路径（`~/Desktop/...`）。允许空格，供 Markdown 显式链接 `[名](</Users/a/My Project/b.png>)` 使用；
 * 拒绝控制字符与 `//host` 网络路径。
 */
export function isAbsoluteLocalPath(raw: string): boolean {
  const value = raw.trim().replace(/^<|>$/g, '');
  if (!value || value.length > 1024 || /[\x00-\x1f]/.test(value)) return false;
  return /^[A-Za-z]:[\\/]/.test(value) || POSIX_ABSOLUTE_RE.test(value) || HOME_RELATIVE_RE.test(value);
}

/** 逐段编码 POSIX 路径为 `file://` URL 路径部分；保留 `/` 分隔与 `:行号` 后缀，已编码的片段不重复编码。 */
function encodePosixPath(path: string): string {
  return path.split('/').map(part => {
    let decoded = part;
    try { decoded = decodeURIComponent(part); } catch { /* 文件名中的字面量 % 原样编码 */ }
    return encodeURIComponent(decoded).replace(/%3A/gi, ':');
  }).join('/');
}

/** 将可交互目标区分为页内锚点、外部地址和本地文件。无法解析或使用未知协议时交由调用方显示普通文字。 */
export function resolveSafeHref(rawUrl: string, headingPrefix = ''): SafeHref | null {
  const trimmed = rawUrl.trim().replace(/^<|>$/g, '');
  if (!trimmed || /[\x00-\x1f]/.test(trimmed)) return null;
  if (trimmed.startsWith('#')) {
    return { href: '#' + headingPrefix + trimmed.slice(1), kind: 'anchor', tooltip: trimmed };
  }
  // 兼容模型直接输出的 Windows 绝对路径（如 C:/Workspace/DemoProject/src/index.ts#L10）
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const normalized = trimmed.replace(/\\/g, '/');
    return {
      href: `file:///${normalized}`,
      kind: 'file',
      tooltip: normalized,
    };
  }
  // macOS / Linux 绝对路径（如 /Users/alice/My Project/图 1.png#L10）：前导 `/` 始终保留，
  // 路径段按 URL 编码，`#L10-L20` 行号锚点保留为 hash，主进程据此剥离锚点后定位文件。
  if (POSIX_ABSOLUTE_RE.test(trimmed)) {
    const anchor = LINE_ANCHOR_RE.exec(trimmed)?.[0] ?? '';
    const body = anchor ? trimmed.slice(0, -anchor.length) : trimmed;
    return { href: 'file://' + encodePosixPath(body) + anchor, kind: 'file', tooltip: decodeLocalTarget(trimmed) };
  }
  // `~/Desktop/a.png` 交给主进程按当前用户主目录展开，渲染层不猜测主目录。
  if (HOME_RELATIVE_RE.test(trimmed)) {
    return { href: trimmed, kind: 'file', tooltip: trimmed };
  }
  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.toLowerCase();
    if (proto === 'https:' || proto === 'http:' || proto === 'mailto:') {
      return { href: parsed.toString(), kind: 'external', tooltip: parsed.toString() };
    }
    if (proto === 'file:') {
      return { href: trimmed, kind: 'file', tooltip: decodeLocalTarget(trimmed) };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 解码 `file:///` URI 为可读本地路径。仅在 Windows 盘符前（`/F:/...`）去掉前导斜杠；
 * POSIX 路径（`file:///Users/alice/a.png` → `/Users/alice/a.png`）的前导 `/` 始终保留。
 */
export function decodeLocalTarget(raw: string): string {
  let value = raw.trim();
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\/(?:localhost)?/i, '');
    if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 是否为需要主进程校验的本地目标（排除 data:/blob:/http(s)/mailto）。 */
export function isLocalTargetSource(source: string): boolean {
  return Boolean(source) && !/^(?:data|blob|https?|mailto):/i.test(source.trim());
}

/* ============================================================================
 * 文件链接（左键经桌面桥接打开，带 cwd / sessionId；失败时内联提示且可关闭）
 * ========================================================================== */

export function TargetLink({
  safe,
  title,
  children,
  lineBadge,
}: {
  safe: SafeHref;
  title?: string;
  children: React.ReactNode;
  lineBadge?: string;
}) {
  const cwd = useContext(ImageWorkspace);
  const sessionId = useContext(ImageSessionContext);
  const { dict } = useI18n();
  const [error, setError] = useState('');
  const isFile = safe.kind === 'file';
  return <>
    <a
      className={isFile ? 'md-link md-link-file' : 'md-link'}
      href={safe.href}
      data-link-href={safe.href}
      data-link-kind={safe.kind}
      data-link-path={isFile ? safe.tooltip : undefined}
      target={safe.kind === 'anchor' ? undefined : '_blank'}
      rel={safe.kind === 'anchor' ? undefined : 'noopener noreferrer'}
      title={title || safe.tooltip}
      onClick={
        isFile
          ? (e) => {
              e.preventDefault();
              setError('');
              void getDesktopBridge()
                .openLinkOrFileTarget({ target: safe.href, action: 'default-app', cwd: cwd || undefined, sessionId: sessionId || undefined })
                .catch(reason => setError(stripIpcErrorPrefix(reason)));
            }
          : undefined
      }
    >
      {isFile && <Icon icon={FileCode2} size="xs" className="md-link-icon md-link-icon-lead" />}
      <span className="md-link-label">{children}</span>
      {lineBadge && <span className="md-line-badge">{lineBadge}</span>}
      {safe.kind === 'external' && <Icon icon={ExternalLink} size="xs" className="md-link-icon" />}
    </a>
    {error && (
      <span role="alert" className="md-inline-error">
        <span>{dict.ui.v031.linkOpenFailed(error)}</span>
        <button type="button" className="md-inline-error-close" aria-label={dict.ui.v031.dismissAction} onClick={() => setError('')}>
          <Icon icon={X} size="xs" />
        </button>
      </span>
    )}
  </>;
}

/* ============================================================================
 * 主进程本地媒体检验（批量、缓存、无原生桥接时干净回退为启发式）
 * ========================================================================== */

type CacheEntry = { value: InspectedLocalTarget | 'failed'; at: number; bytes: number };
/** 有界 LRU：Map 按插入顺序迭代，命中时重新插入到末尾；超出条目数或预览字节预算时从最久未用处淘汰。 */
const inspectCache = new Map<string, CacheEntry>();
const inflight = new Set<string>();
/** 按缓存键精准订阅：某条检验完成只唤醒引用了它的 `<Markdown>`，不再全局广播。 */
const keyListeners = new Map<string, Set<() => void>>();
const FOUND_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 12_000;
const FAILED_TTL_MS = 20_000;
const CACHE_MAX_ENTRIES = 512;
/** Base64 预览图按字符数近似计入（UTF-16 下每字符 2 字节），总预算约 24 MB。 */
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
let cacheBytes = 0;

function cacheKey(cwd: string, sessionId: string, target: string): string {
  return `${cwd}\u0000${sessionId}\u0000${target}`;
}

function entryTtl(entry: CacheEntry): number {
  return entry.value === 'failed'
    ? FAILED_TTL_MS
    : entry.value.kind === 'missing' ? MISSING_TTL_MS : FOUND_TTL_MS;
}

function readCache(key: string): CacheEntry | undefined {
  const entry = inspectCache.get(key);
  if (!entry) return undefined;
  return Date.now() - entry.at > entryTtl(entry) ? { ...entry, at: -1 } : entry;
}

function deleteEntry(key: string): void {
  const entry = inspectCache.get(key);
  if (!entry) return;
  cacheBytes -= entry.bytes;
  inspectCache.delete(key);
}

function writeCache(key: string, value: InspectedLocalTarget | 'failed', at: number): void {
  deleteEntry(key);
  const bytes = 256 + (value === 'failed' ? 0 : (value.previewDataUrl?.length ?? 0) * 2);
  inspectCache.set(key, { value, at, bytes });
  cacheBytes += bytes;
  evictInspectCache(key, at);
}

/**
 * 超出条目数或字节预算时回收缓存：先清理已过期且无人订阅的条目，再按 LRU 顺序淘汰未订阅条目。
 * 正在屏幕上被订阅的条目不淘汰（否则对应引用会停在 pending），预算只会因当前可见内容暂时超出；
 * 这些条目解除订阅（会话切走 / 卸载）后会立即补做一次回收。`protectedKey` 为刚写入、需保留的条目。
 */
function evictInspectCache(protectedKey?: string, now = Date.now()): void {
  const overBudget = () => inspectCache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES;
  if (!overBudget()) return;
  for (const [k, entry] of inspectCache) {
    if (k !== protectedKey && now - entry.at > entryTtl(entry) && !keyListeners.has(k)) deleteEntry(k);
  }
  for (const k of inspectCache.keys()) {
    if (!overBudget()) break;
    if (k !== protectedKey && !keyListeners.has(k)) deleteEntry(k);
  }
}

function touchCache(key: string): CacheEntry | undefined {
  const entry = inspectCache.get(key);
  if (entry) {
    inspectCache.delete(key);
    inspectCache.set(key, entry);
  }
  return entry;
}

function notifyKeys(keys: Iterable<string>): void {
  const fns = new Set<() => void>();
  for (const key of keys) keyListeners.get(key)?.forEach(fn => fns.add(fn));
  fns.forEach(fn => fn());
}

function subscribeKeys(keys: string[], fn: () => void): () => void {
  for (const key of keys) {
    let set = keyListeners.get(key);
    if (!set) keyListeners.set(key, (set = new Set()));
    set.add(fn);
  }
  return () => {
    for (const key of keys) {
      const set = keyListeners.get(key);
      if (!set) continue;
      set.delete(fn);
      if (set.size === 0) keyListeners.delete(key);
    }
    // 解除订阅后这些条目不再受保护：若此前因可见内容超出预算，立即回收，释放已卸载会话的 Base64 预览图。
    if (inspectCache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) evictInspectCache(undefined, Date.now());
  };
}

/** 切换账号、删除会话或测试时清空检验缓存（释放全部 Base64 预览图）。 */
export function clearLocalTargetInspectionCache(): void {
  inspectCache.clear();
  inflight.clear();
  cacheBytes = 0;
  notifyKeys([...keyListeners.keys()]);
}

export type InspectionLookup = InspectedLocalTarget | 'pending' | 'failed' | undefined;

export interface LocalTargetInspection {
  /** native：主进程可校验，未确认存在的本地引用不显示；heuristic：浏览器预览/测试环境，按文本规则显示 */
  mode: 'native' | 'heuristic';
  lookup(target: string): InspectionLookup;
}

function canInspectNatively(): boolean {
  if (!isUsingNativeDesktopBridge()) return false;
  return typeof getDesktopBridge().inspectLocalTargets === 'function';
}

/**
 * 批量向主进程查询本地引用（每批 ≤ 48 个），结果按 cwd/sessionId 缓存；
 * 流式输出期间延迟查询，避免每个分片都触发一次 IPC。
 */
export function useLocalTargetInspection(targets: string[], options: { cwd: string; sessionId: string; deferMs?: number }): LocalTargetInspection {
  const { cwd, sessionId, deferMs = 0 } = options;
  const [, force] = useReducer((n: number) => n + 1, 0);
  const native = canInspectNatively();
  const targetsKey = useMemo(() => Array.from(new Set(targets)).sort().join('\n'), [targets]);

  // 仅原生桥接且确有本地引用时，按缓存键精准订阅；纯文本消息不再随任何预览完成而重渲染。
  useEffect(() => {
    if (!native || !targetsKey) return undefined;
    return subscribeKeys(targetsKey.split('\n').filter(Boolean).map(target => cacheKey(cwd, sessionId, target)), force);
  }, [native, targetsKey, cwd, sessionId]);

  useEffect(() => {
    if (!native || !targetsKey) return;
    const list = targetsKey.split('\n').filter(Boolean);
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const needed = list.filter(target => {
        const key = cacheKey(cwd, sessionId, target);
        const entry = readCache(key);
        return (!entry || entry.at < 0) && !inflight.has(key);
      });
      if (needed.length === 0) return;
      const bridge = getDesktopBridge();
      for (let i = 0; i < needed.length; i += MAX_LOCAL_INSPECT_TARGETS) {
        const batch = needed.slice(i, i + MAX_LOCAL_INSPECT_TARGETS);
        batch.forEach(target => inflight.add(cacheKey(cwd, sessionId, target)));
        let request: Promise<{ items: Record<string, InspectedLocalTarget> }>;
        try {
          request = bridge.inspectLocalTargets({ targets: batch, cwd: cwd || undefined, sessionId: sessionId || undefined, includePreviewData: true });
        } catch (error) {
          request = Promise.reject(error);
        }
        void Promise.resolve(request)
          .then(result => {
            const now = Date.now();
            for (const target of batch) {
              const item = result?.items?.[target];
              writeCache(cacheKey(cwd, sessionId, target), item ?? 'failed', now);
            }
          })
          .catch(() => {
            const now = Date.now();
            for (const target of batch) writeCache(cacheKey(cwd, sessionId, target), 'failed', now);
          })
          .finally(() => {
            const keys = batch.map(target => cacheKey(cwd, sessionId, target));
            keys.forEach(key => inflight.delete(key));
            notifyKeys(keys);
          });
      }
    };
    if (deferMs > 0) {
      const timer = window.setTimeout(run, deferMs);
      return () => { cancelled = true; window.clearTimeout(timer); };
    }
    run();
    return () => { cancelled = true; };
  }, [native, targetsKey, cwd, sessionId, deferMs]);

  return {
    mode: native ? 'native' : 'heuristic',
    lookup(target: string): InspectionLookup {
      if (!native) return undefined;
      const entry = touchCache(cacheKey(cwd, sessionId, target));
      if (!entry) return 'pending';
      return entry.value;
    },
  };
}

/* ============================================================================
 * 分区画廊：Zone A 仅图片，Zone B 仅非图片文件与目录
 * ========================================================================== */

export interface MediaPreviewItem {
  key: string;
  source: string;
  /** 已校验的受控预览地址（previewDataUrl / 附件 dataUrl） */
  displayUrl?: string;
  label: string;
  title?: string;
  kind: 'image' | 'file' | 'directory';
  text?: string;
  meta?: Partial<InspectedLocalTarget>;
  mimeType?: string;
}

const IMAGE_FOLD_LIMIT = 6;
const FILE_FOLD_LIMIT = 8;
const HERO_RATIO = 1.55;
const ALPHA_FORMATS = new Set(['PNG', 'SVG', 'WEBP', 'GIF', 'ICO', 'AVIF']);

const CODE_EXT = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'jsonl', 'html', 'htm', 'css', 'scss', 'less', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'sql', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'dart', 'vue', 'svelte']);
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'log', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'rtf']);
const SHEET_EXT = new Set(['csv', 'tsv', 'xls', 'xlsx']);
const ARCHIVE_EXT = new Set(['zip', '7z', 'tar', 'gz', 'rar', 'tgz', 'bz2', 'xz']);
const ICON_EXT = new Set(['ico', 'icns', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']);

function extOf(item: MediaPreviewItem): string {
  if (item.meta?.ext) return item.meta.ext.replace(/^\./, '').toLowerCase();
  const base = extractTargetBaseName(item.meta?.fileName || item.label || item.source);
  const m = /\.([a-z0-9]{1,8})$/i.exec(base);
  return m ? m[1].toLowerCase() : '';
}

function FileKindIcon({ item }: { item: MediaPreviewItem }) {
  if (item.kind === 'directory') return <Icon icon={Folder} size="md" />;
  const ext = extOf(item);
  // 可执行 / 脚本 / 安装包后缀与主进程同源（@shared EXECUTABLE_OR_SCRIPT_EXT_RE）；JS 等源码仍显示代码图标。
  if (item.meta?.isExecutable || (ext && !CODE_EXT.has(ext) && EXECUTABLE_OR_SCRIPT_EXT_RE.test('.' + ext))) return <Icon icon={Terminal} size="md" />;
  if (ICON_EXT.has(ext)) return <Icon icon={FileImage} size="md" />;
  if (ARCHIVE_EXT.has(ext)) return <Icon icon={FileArchive} size="md" />;
  if (SHEET_EXT.has(ext)) return <Icon icon={FileSpreadsheet} size="md" />;
  if (CODE_EXT.has(ext)) return <Icon icon={FileCode2} size="md" />;
  if (TEXT_EXT.has(ext) || item.text !== undefined) return <Icon icon={FileText} size="md" />;
  return <Icon icon={FileIcon} size="md" />;
}

/**
 * 启发式父目录提示：取文件名前的直接父目录名，与主进程检验结果（`basename(parent)`）保持一致。
 * `/Users/alice/proj/icon-studio/a.png` 与 `C:\Workspace\DemoApp\icon-studio\a.png` 均为 `icon-studio`；
 * 盘符根目录下的文件显示 `C:\`，POSIX 根目录下的文件不显示提示。
 */
export function deriveParentHint(source: string): string {
  if (!isLocalTargetSource(source)) return '';
  const clean = stripLocalTargetAnchor(decodeLocalTarget(source)).replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return '';
  const parent = parts[parts.length - 2];
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent;
}

function useRevealLabel(): string {
  const { dict, mac } = useI18n();
  return mac ? dict.ui.v031.revealInFinder : dict.ui.v031.revealInFolder;
}

function useOpenTarget() {
  const cwd = useContext(ImageWorkspace);
  const sessionId = useContext(ImageSessionContext);
  return useCallback(
    (target: string, action: 'default-app' | 'reveal-in-folder') =>
      getDesktopBridge().openLinkOrFileTarget({ target, action, cwd: cwd || undefined, sessionId: sessionId || undefined }),
    [cwd, sessionId]
  );
}

function MediaCard({
  item,
  entries,
  index,
  onSize,
}: {
  item: MediaPreviewItem;
  entries: LightboxEntry[];
  index: number;
  onSize: (key: string, w: number, h: number) => void;
}) {
  const { dict } = useI18n();
  const strings = dict.ui.v031;
  const revealLabel = useRevealLabel();
  const openTarget = useOpenTarget();
  const cardRef = useRef<HTMLElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const [error, setError] = useState('');
  // FE-06：图片地址变化（例如本地预览解析完成、换成 data URL）时重置损坏状态与尺寸，重新尝试加载。
  useEffect(() => {
    setBroken(false);
    setNatural(null);
  }, [item.source, item.displayUrl]);
  // FE-06：未解析出可预览地址的条目（index < 0）不回退复用 entries[0] 的格式徽标与灯箱位置。
  const entry = index >= 0 ? entries[index] : undefined;
  const width = item.meta?.width || natural?.w;
  const height = item.meta?.height || natural?.h;
  const ratio = item.meta?.aspectRatio || (width && height ? width / height : 0);
  const format = entry?.format || imageFormatLabel(item.source, item.meta?.ext, item.mimeType);
  const isVector = format === 'SVG';
  const dims = width && height ? `${width}×${height}` : isVector ? strings.vectorLabel : formatByteSize(item.meta?.sizeBytes);
  const fullPath = item.meta?.resolvedPath || (isLocalTargetSource(item.source) ? decodeLocalTarget(item.source) : item.title || item.label);
  const local = isLocalImageSource(item.source) && !/^(?:data|blob):/i.test(item.source);
  const isHero = ratio >= HERO_RATIO && (!width || width >= 320);
  const classes = [
    'md-media-card',
    isHero ? 'is-hero' : '',
    ALPHA_FORMATS.has(format) ? 'is-alpha' : '',
    broken ? 'is-broken' : '',
  ].filter(Boolean).join(' ');
  return (
    <figure ref={cardRef} className={classes} data-testid="md-media-card" data-media-format={format || undefined}>
      <div className="md-media-card-stage">
        <MessageImage
          source={item.source}
          displayUrl={item.displayUrl}
          alt={item.label}
          title={item.title}
          gallery={entry ? entries : undefined}
          galleryIndex={entry ? index : undefined}
          onNaturalSize={(w, h) => { setNatural({ w, h }); onSize(item.key, w, h); }}
          onLoadError={() => setBroken(true)}
        />
        <div className="md-media-actions">
          {/* 加载失败的坏图卡没有可放大的内容，隐藏缩放按钮（仍保留「在文件夹中显示」）。 */}
          {!broken && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label={strings.zoomImage}
              title={strings.zoomImage}
              data-testid="md-media-zoom-btn"
              onClick={() => cardRef.current?.querySelector<HTMLButtonElement>('button.message-image')?.click()}
            >
              <Icon icon={Maximize2} size="xs" />
            </button>
          )}
          {local && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label={revealLabel}
              title={revealLabel}
              data-testid="md-media-reveal-btn"
              onClick={() => {
                setError('');
                void openTarget(item.meta?.resolvedPath || item.source, 'reveal-in-folder')
                  .catch(reason => setError(stripIpcErrorPrefix(reason)));
              }}
            >
              <Icon icon={FolderOpen} size="xs" />
            </button>
          )}
        </div>
      </div>
      <figcaption className="md-media-meta">
        <span className="md-media-name" title={fullPath}>{item.label}</span>
        {format && <span className="md-media-format">{format}</span>}
        {dims && <span className="md-media-dims">{dims}</span>}
      </figcaption>
      {error && <span role="alert" className="md-inline-error">{strings.linkOpenFailed(error)}</span>}
    </figure>
  );
}

function FileTrayItem({ item }: { item: MediaPreviewItem }) {
  const { dict } = useI18n();
  const strings = dict.ui.v031;
  const revealLabel = useRevealLabel();
  const openTarget = useOpenTarget();
  const [error, setError] = useState('');
  const local = isLocalTargetSource(item.source) && Boolean(item.source);
  const safe = item.source ? resolveSafeHref(item.meta?.fileUrl || item.source) : null;
  const parent = item.meta?.parentHint || deriveParentHint(item.source);
  const size = item.kind === 'directory' ? strings.folderLabel : formatByteSize(item.meta?.sizeBytes);
  const sub = [parent, size].filter(Boolean).join(' · ');
  const fullPath = item.meta?.resolvedPath || (local ? decodeLocalTarget(item.source) : item.title || item.label);
  const badge = item.source ? extractLineAnchorBadge(item.source) : undefined;
  return (
    <div className="message-file md-file-item" data-kind={item.kind} data-testid="md-file-item">
      <div className="md-file-row">
        <span className="md-file-icon" aria-hidden="true"><FileKindIcon item={item} /></span>
        <span className="md-file-text">
          {safe && safe.kind !== 'anchor'
            ? <TargetLink safe={safe} title={fullPath} lineBadge={badge}>{item.label}</TargetLink>
            : <span className="md-file-name" title={fullPath}>{item.label}</span>}
          {sub && <span className="md-file-sub" title={fullPath}>{sub}</span>}
        </span>
        {local && (
          <button
            type="button"
            className="icon-btn icon-btn-sm md-file-reveal"
            aria-label={revealLabel}
            title={revealLabel}
            onClick={() => {
              setError('');
              void openTarget(item.meta?.resolvedPath || item.source, 'reveal-in-folder')
                .catch(reason => setError(stripIpcErrorPrefix(reason)));
            }}
          >
            <Icon icon={FolderOpen} size="sm" />
          </button>
        )}
      </div>
      {item.text !== undefined && (
        <details className="md-file-peek">
          <summary>{strings.filePreviewSummary}</summary>
          <pre>{item.text.slice(0, 3000)}</pre>
        </details>
      )}
      {error && <span role="alert" className="md-inline-error">{strings.linkOpenFailed(error)}</span>}
    </div>
  );
}

export function MediaGallery({ items }: { items: MediaPreviewItem[] }) {
  const { dict } = useI18n();
  const strings = dict.ui.v031;
  const workspace = useContext(ImageWorkspace);
  const [imagesOpen, setImagesOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [, setSizes] = useState(0);
  const sizesRef = useRef(new Map<string, { w: number; h: number }>());
  const images = items.filter(item => item.kind === 'image');
  const files = items.filter(item => item.kind !== 'image');

  const onSize = useCallback((key: string, w: number, h: number) => {
    const prev = sizesRef.current.get(key);
    if (prev && prev.w === w && prev.h === h) return;
    sizesRef.current.set(key, { w, h });
    setSizes(n => n + 1);
  }, []);

  const entries: LightboxEntry[] = images.map(item => {
    const natural = sizesRef.current.get(item.key);
    const local = isLocalImageSource(item.source) && !/^(?:data|blob):/i.test(item.source);
    return {
      source: item.source,
      url: item.displayUrl || resolveImage(item.source, workspace) || '',
      label: item.label,
      width: item.meta?.width || natural?.w,
      height: item.meta?.height || natural?.h,
      format: imageFormatLabel(item.source, item.meta?.ext, item.mimeType),
      revealTarget: local ? item.meta?.resolvedPath || item.source : undefined,
    };
  });
  const validEntries = entries.filter(entry => entry.url);

  if (items.length === 0) return null;
  const visibleImages = imagesOpen ? images : images.slice(0, IMAGE_FOLD_LIMIT);
  const visibleFiles = filesOpen ? files : files.slice(0, FILE_FOLD_LIMIT);
  return (
    <div className="message-images message-previews" data-testid="message-previews">
      {images.length > 0 && (
        <section
          className={`md-media-gallery ${images.length === 1 ? 'is-single' : 'is-multi'}`}
          data-testid="md-media-gallery"
          aria-label={strings.galleryTitle}
        >
          {visibleImages.map((item) => {
            const entryIndex = validEntries.findIndex(entry => entry.source === item.source && entry.label === item.label);
            return (
              <MediaCard
                key={item.key}
                item={item}
                entries={validEntries}
                index={entryIndex}
                onSize={onSize}
              />
            );
          })}
          {images.length > IMAGE_FOLD_LIMIT && (
            <button
              type="button"
              className="md-fold-toggle"
              data-testid="md-media-expand-btn"
              aria-expanded={imagesOpen}
              onClick={() => setImagesOpen(open => !open)}
            >
              {imagesOpen ? strings.collapseImages : strings.expandImages(images.length - IMAGE_FOLD_LIMIT)}
            </button>
          )}
        </section>
      )}
      {files.length > 0 && (
        <section className="md-files-tray" data-testid="md-files-tray" aria-label={strings.filesTrayTitle}>
          <header className="md-files-tray-head">
            <span>{strings.filesTrayTitle}</span>
            <span className="md-files-tray-count">· {files.length}</span>
          </header>
          <div className="md-files-list">
            {visibleFiles.map(item => <FileTrayItem key={item.key} item={item} />)}
          </div>
          {files.length > FILE_FOLD_LIMIT && (
            <button
              type="button"
              className="md-fold-toggle"
              data-testid="md-files-expand-btn"
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen(open => !open)}
            >
              {filesOpen ? strings.collapseFiles : strings.expandFiles(files.length - FILE_FOLD_LIMIT)}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/* ============================================================================
 * 预览项分类：结合附件、主进程检验结果与启发式规则
 * ========================================================================== */

export interface PreviewCandidate {
  key: string;
  source: string;
  label: string;
  image: boolean;
  title?: string;
  text?: string;
  /** mention：正文链接或路径；code：行内代码；attachment：消息附件 */
  origin: 'mention' | 'code' | 'attachment';
  attachment?: MessageAttachmentPreview;
}

/** 将候选引用转为画廊展示项。原生桥接可用时，缺失、被拦截或仍在检验中的本地引用一律不显示。 */
export function classifyPreviewCandidates(candidates: PreviewCandidate[], inspection: LocalTargetInspection): MediaPreviewItem[] {
  const out: MediaPreviewItem[] = [];
  const seenResolved = new Set<string>();
  for (const candidate of candidates) {
    const att = candidate.attachment;
    if (att) {
      const isImage = att.mimeType.startsWith('image/');
      const source = att.uri || att.dataUrl || candidate.source;
      out.push({
        key: candidate.key,
        source,
        displayUrl: isImage ? att.dataUrl : undefined,
        label: att.name || candidate.label,
        title: candidate.title,
        kind: isImage && Boolean(att.dataUrl || source) ? 'image' : 'file',
        text: att.textContent ?? candidate.text,
        meta: { sizeBytes: att.sizeBytes, mimeType: att.mimeType, fileName: att.name, ...(att.uri ? { parentHint: deriveParentHint(att.uri) || undefined } : {}) },
        mimeType: att.mimeType,
      });
      continue;
    }
    if (!isLocalTargetSource(candidate.source)) {
      out.push({
        key: candidate.key,
        source: candidate.source,
        label: candidate.label,
        title: candidate.title,
        kind: candidate.image ? 'image' : 'file',
        text: candidate.text,
      });
      continue;
    }
    const result = inspection.lookup(candidate.source);
    if (inspection.mode === 'native' && result !== 'failed') {
      if (!result || result === 'pending') continue;
      if (result.kind === 'missing' || result.kind === 'forbidden' || !result.exists) continue;
      const resolvedKey = result.resolvedPath || candidate.key;
      if (seenResolved.has(resolvedKey)) continue;
      seenResolved.add(resolvedKey);
      const kind: MediaPreviewItem['kind'] = result.kind === 'image' ? 'image' : result.kind === 'directory' ? 'directory' : 'file';
      out.push({
        key: candidate.key,
        source: candidate.source,
        displayUrl: kind === 'image' ? result.previewDataUrl || result.fileUrl || undefined : undefined,
        label: kind === 'image' && candidate.label && candidate.label !== candidate.source
          ? candidate.label
          : result.fileName || extractTargetBaseName(candidate.source) || candidate.label,
        title: candidate.title || result.resolvedPath,
        kind,
        text: candidate.text,
        meta: result,
        mimeType: result.mimeType,
      });
      continue;
    }
    // 启发式回退：行内代码里没有路径分隔符的裸文件名需要主进程确认，回退模式下不显示。
    if (candidate.origin === 'code' && !/[\\/]/.test(candidate.source)) continue;
    const base = extractTargetBaseName(candidate.source);
    const isDir = /[\\/]$/.test(stripLocalTargetAnchor(candidate.source)) || (!candidate.image && !/\.[a-z0-9]{1,10}$/i.test(base));
    out.push({
      key: candidate.key,
      source: candidate.source,
      label: candidate.image ? candidate.label : base || candidate.label,
      title: candidate.title,
      kind: candidate.image ? 'image' : isDir ? 'directory' : 'file',
      text: candidate.text,
    });
  }
  return out;
}
