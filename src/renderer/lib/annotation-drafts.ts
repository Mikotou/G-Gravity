import { useSyncExternalStore } from 'react';
import type { TextNotationItem, TextQuoteItem } from '../components/SelectionAnnotationTools';

interface Draft { quotes: TextQuoteItem[]; notes: TextNotationItem[] }
const empty: Draft = { quotes: [], notes: [] };
const cache = new Map<string, Draft>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function read(key: string): Draft {
  if (cache.has(key)) return cache.get(key)!;
  let value = empty;
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    if (Array.isArray(stored?.quotes) && Array.isArray(stored?.notes)) value = stored;
  } catch { /* Storage may be unavailable. */ }
  cache.set(key, value);
  return value;
}
function write(key: string, value: Draft) {
  cache.set(key, value);
  try {
    if (value.notes.length || value.quotes.length) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch { /* Keep the draft in memory. */ }
  listeners.forEach(fn => fn());
}
function draftKey(profile: string, id: string) { return 'gravity.annotations.' + JSON.stringify([profile, id]); }
export function clearAnnotationDraft(profile: string, id: string) { write(draftKey(profile, id), empty); }
export function useAnnotationDraft(profile: string, id: string) {
  const key = draftKey(profile, id);
  const draft = useSyncExternalStore(subscribe, () => read(key));
  function update(change: (prev: Draft) => Draft) { write(key, change(read(key))); }
  function takeSubmitted(quotes: TextQuoteItem[], notes: TextNotationItem[]) {
    const current = read(key);
    const sentQuotes = current.quotes.filter(q => quotes.some(sent => sent.id === q.id));
    const sentNotes = current.notes.filter(n => notes.some(sent => sent.id === n.id && sent.comment === n.comment));
    if (sentQuotes.length || sentNotes.length) {
      write(key, { quotes: current.quotes.filter(q => !sentQuotes.includes(q)), notes: current.notes.filter(n => !sentNotes.includes(n)) });
    }
    return () => {
      if (!sentQuotes.length && !sentNotes.length) return;
      update(d => ({
        quotes: [...sentQuotes.filter(q => !d.quotes.some(newer => newer.id === q.id)), ...d.quotes],
        notes: [...sentNotes.filter(n => !d.notes.some(newer => newer.id === n.id)), ...d.notes],
      }));
    };
  }
  return { ...draft, update, takeSubmitted };
}

const rangesByPane = new Map<HTMLElement, Range[]>();
export function showAnnotationRanges(pane: HTMLElement, notes: TextNotationItem[]) {
  const css = globalThis.CSS as typeof CSS & { highlights?: Map<string, unknown> };
  const HighlightType = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !HighlightType) return;
  const registry = css.highlights;
  const refresh = () => {
    const ranges = [...rangesByPane.values()].flat();
    if (ranges.length) registry.set('gravity-annotations', new HighlightType(...ranges));
    else registry.delete('gravity-annotations');
  };
  if (!notes.length) return;
  const ranges: Range[] = [];
  for (const note of notes) {
    if (note.start === undefined || !note.anchorText) continue;
    const body = pane.querySelector('[data-message-id="' + CSS.escape(note.messageId) + '"] [data-message-body]');
    if (!body || body.textContent?.slice(note.start, note.start + note.anchorText.length) !== note.anchorText) continue;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let offset = 0;
    const end = note.start + note.anchorText.length;
    const range = document.createRange();
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = offset + (node.textContent?.length || 0);
      if (!started && note.start < next) { range.setStart(node, note.start - offset); started = true; }
      if (started && end <= next) { range.setEnd(node, end - offset); ranges.push(range); break; }
      offset = next;
    }
  }
  rangesByPane.set(pane, ranges);
  refresh();
  return () => { rangesByPane.delete(pane); refresh(); };
}
