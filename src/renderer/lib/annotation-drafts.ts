/**
 * v0.3.6 划词标注草稿：单一有序条目数组（引用与批注同一条目，顺序只认数组下标）。
 *
 * - 新条目由前端生成 `ann-<UUID>`；
 * - 平滑迁移 localStorage 旧 `{ quotes, notes }` 草稿（保留旧 ID，按创建时间合并为单一序列）；
 * - 发送时整体取出、失败时按 ID 原序合并恢复（发送途中新增的条目排在其后）；
 * - 高亮：`gravity-annotations` 显示全部锚点，`gravity-annotation-active` 显示悬停条目。
 */
import { useSyncExternalStore } from 'react';
import { rangeFromAnchor } from './annotation-text';

export interface AnnotationDraftItem {
  id: string;
  messageId: string;
  originMessageId?: string;
  messageNumber?: number;
  excerpt: string;
  /** 批注；空串表示「仅引用」 */
  comment: string;
  start?: number;
  anchorText?: string;
  prefix?: string;
  suffix?: string;
  createdAt: string;
}

interface StoredDraft {
  version: 2;
  items: AnnotationDraftItem[];
}

const EMPTY: AnnotationDraftItem[] = [];
const cache = new Map<string, AnnotationDraftItem[]>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function newAnnotationId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `ann-${uuid}`;
}

function timeOf(item: { id?: string; createdAt?: string }): number {
  const parsed = item.createdAt ? Date.parse(item.createdAt) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const m = /^(?:qt|nt)-(\d{10,})/.exec(item.id ?? '');
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** 旧 `{ quotes, notes }` → 单一有序条目数组（纯函数，导出供测试）。 */
export function migrateLegacyDraft(stored: unknown): AnnotationDraftItem[] {
  if (!stored || typeof stored !== 'object') return EMPTY;
  const value = stored as Record<string, unknown>;
  if (Array.isArray(value.items)) {
    return value.items.filter(
      (i): i is AnnotationDraftItem =>
        Boolean(i) && typeof (i as AnnotationDraftItem).id === 'string' && typeof (i as AnnotationDraftItem).excerpt === 'string'
    ).map((i) => ({ ...i, comment: typeof i.comment === 'string' ? i.comment : '' }));
  }
  const quotes = Array.isArray(value.quotes) ? (value.quotes as Array<Record<string, unknown>>) : [];
  const notes = Array.isArray(value.notes) ? (value.notes as Array<Record<string, unknown>>) : [];
  const merged: Array<AnnotationDraftItem & { order: number }> = [];
  quotes.forEach((q, i) => {
    if (typeof q?.text !== 'string' || typeof q.id !== 'string') return;
    merged.push({ id: q.id, messageId: String(q.messageId ?? ''), excerpt: q.text, comment: '', createdAt: '', order: i });
  });
  notes.forEach((n, i) => {
    if (typeof n?.selectedText !== 'string' || typeof n.id !== 'string') return;
    merged.push({
      id: n.id,
      messageId: String(n.messageId ?? ''),
      excerpt: n.selectedText,
      comment: typeof n.comment === 'string' ? n.comment : '',
      ...(typeof n.messageNumber === 'number' ? { messageNumber: n.messageNumber } : {}),
      ...(typeof n.start === 'number' ? { start: n.start } : {}),
      ...(typeof n.anchorText === 'string' ? { anchorText: n.anchorText } : {}),
      createdAt: typeof n.createdAt === 'string' ? n.createdAt : '',
      order: quotes.length + i,
    });
  });
  merged.sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    return ta === tb ? a.order - b.order : ta - tb;
  });
  return merged.map(({ order: _order, ...item }) => item);
}

function read(key: string): AnnotationDraftItem[] {
  const hit = cache.get(key);
  if (hit) return hit;
  let value = EMPTY;
  try {
    value = migrateLegacyDraft(JSON.parse(localStorage.getItem(key) || 'null'));
  } catch {
    /* Storage may be unavailable. */
  }
  cache.set(key, value);
  return value;
}

function write(key: string, items: AnnotationDraftItem[]): void {
  cache.set(key, items);
  try {
    if (items.length) localStorage.setItem(key, JSON.stringify({ version: 2, items } satisfies StoredDraft));
    else localStorage.removeItem(key);
  } catch {
    /* Keep the draft in memory. */
  }
  listeners.forEach((fn) => fn());
}

function draftKey(profile: string, id: string): string {
  return 'gravity.annotations.' + JSON.stringify([profile, id]);
}

export function clearAnnotationDraft(profile: string, id: string): void {
  write(draftKey(profile, id), EMPTY);
}

/** 发送失败恢复：已发送条目按原序在前，发送途中新增（ID 不重复）的条目在后。 */
export function mergeRestoredAnnotations(
  sent: readonly AnnotationDraftItem[],
  current: readonly AnnotationDraftItem[]
): AnnotationDraftItem[] {
  const sentIds = new Set(sent.map((i) => i.id));
  return [...sent, ...current.filter((i) => !sentIds.has(i.id))];
}

export function sameAnnotationAnchor(a: Pick<AnnotationDraftItem, 'messageId' | 'excerpt' | 'start'>, b: Pick<AnnotationDraftItem, 'messageId' | 'excerpt' | 'start'>): boolean {
  if (a.messageId !== b.messageId || a.excerpt.trim() !== b.excerpt.trim()) return false;
  return a.start === undefined || b.start === undefined || a.start === b.start;
}

export function useAnnotationDraft(profile: string, id: string) {
  const key = draftKey(profile, id);
  const items = useSyncExternalStore(subscribe, () => read(key));
  function update(change: (prev: AnnotationDraftItem[]) => AnnotationDraftItem[]): void {
    write(key, change(read(key)));
  }
  /** 取出待发送条目（从草稿移除）；返回失败恢复函数。 */
  function takeSubmitted(sent: readonly AnnotationDraftItem[]): () => void {
    const current = read(key);
    const taken = current.filter((i) => sent.some((s) => s.id === i.id));
    if (taken.length) write(key, current.filter((i) => !taken.includes(i)));
    return () => {
      if (taken.length) write(key, mergeRestoredAnnotations(taken, read(key)));
    };
  }
  return { items, update, takeSubmitted };
}

/* ---------------------------------------------------------------------------
 * CSS Custom Highlight：全部锚点 + 悬停条目
 * ------------------------------------------------------------------------- */

type HighlightCtor = new (...ranges: Range[]) => unknown;
const rangesByPane = new Map<HTMLElement, Map<string, Range>>();
let activeId: string | null = null;

function registry(): { css: Map<string, unknown>; Highlight: HighlightCtor } | null {
  const css = (globalThis.CSS as typeof CSS & { highlights?: Map<string, unknown> })?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return css && Highlight ? { css, Highlight } : null;
}

function refreshHighlights(): void {
  const reg = registry();
  if (!reg) return;
  const all: Range[] = [];
  let active: Range | undefined;
  for (const map of rangesByPane.values()) {
    for (const [id, range] of map) {
      all.push(range);
      if (id === activeId) active = range;
    }
  }
  if (all.length) reg.css.set('gravity-annotations', new reg.Highlight(...all));
  else reg.css.delete('gravity-annotations');
  if (active) reg.css.set('gravity-annotation-active', new reg.Highlight(active));
  else reg.css.delete('gravity-annotation-active');
}

export function setActiveAnnotation(id: string | null): void {
  if (activeId === id) return;
  activeId = id;
  refreshHighlights();
}

export function showAnnotationRanges(pane: HTMLElement, items: readonly AnnotationDraftItem[]): (() => void) | undefined {
  if (!registry() || !items.length) return;
  const ranges = new Map<string, Range>();
  for (const item of items) {
    const anchorText = item.anchorText ?? item.excerpt;
    if (!anchorText) continue;
    const body = pane.querySelector(`[data-message-id="${CSS.escape(item.messageId)}"] [data-message-body]`);
    if (!body) continue;
    const range = rangeFromAnchor(body, { anchorText, start: item.start, prefix: item.prefix, suffix: item.suffix });
    if (range) ranges.set(item.id, range);
  }
  rangesByPane.set(pane, ranges);
  refreshHighlights();
  return () => {
    rangesByPane.delete(pane);
    refreshHighlights();
  };
}

/** 发送载荷：保序，`ann-*` 透传 ID，空批注归一为 undefined（仅引用）。 */
export function toWireAnnotations(items: readonly AnnotationDraftItem[]) {
  return items.map((i) => {
    const comment = i.comment.trim();
    return {
      ...(i.id.startsWith('ann-') ? { id: i.id } : {}),
      messageId: i.messageId,
      ...(i.originMessageId ? { originMessageId: i.originMessageId } : {}),
      ...(i.messageNumber !== undefined ? { messageNumber: i.messageNumber } : {}),
      excerpt: i.excerpt,
      ...(comment ? { comment } : {}),
      ...(i.createdAt ? { createdAt: i.createdAt } : {}),
    };
  });
}
