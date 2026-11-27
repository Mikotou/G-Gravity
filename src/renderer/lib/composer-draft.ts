import { createContext, useContext, useMemo, useSyncExternalStore, type SetStateAction } from 'react';
import type { SendPromptInput } from '@shared';

export interface DraftAttachment {
  id: string; name: string; mimeType: string; sizeBytes: number;
  dataBase64?: string; textContent?: string; previewUrl?: string;
}
type Reference = NonNullable<SendPromptInput['references']>[number];
interface DraftState { text: string; references: Reference[]; attachments: DraftAttachment[]; sending: boolean }

class ComposerDraft {
  private value: DraftState = { text: '', references: [], attachments: [], sending: false };
  private listeners = new Set<() => void>();
  read = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  set<K extends keyof DraftState>(key: K, change: SetStateAction<DraftState[K]>) {
    const current = this.value[key];
    const next = typeof change === 'function' ? change(current) : change;
    if (next === current) return;
    this.value = { ...this.value, [key]: next };
    this.listeners.forEach(listener => listener());
  }
}

/** Belongs to one mounted profile. Moving a pane preserves text, references and in-memory image previews. */
export const ComposerDrafts = createContext<Map<string, ComposerDraft> | null>(null);
export function useComposerDraft(id: string) {
  const drafts = useContext(ComposerDrafts);
  const store = useMemo(() => {
    const saved = drafts?.get(id);
    if (saved) return saved;
    const created = new ComposerDraft();
    drafts?.set(id, created);
    return created;
  }, [drafts, id]);
  const state = useSyncExternalStore(store.subscribe, store.read);
  return { ...state, isSending: () => store.read().sending,
    setDraft: (v: SetStateAction<string>) => store.set('text', v),
    setReferences: (v: SetStateAction<Reference[]>) => store.set('references', v),
    setAttachments: (v: SetStateAction<DraftAttachment[]>) => store.set('attachments', v),
    setSending: (v: boolean) => store.set('sending', v) };
}

/** v0.3.6：语音听写在开始时捕获当前 Profile 的草稿表，切换窗格 / Profile 后仍写回原会话草稿（纯本地，0 上传）。 */
export function useComposerDraftRegistry(): Map<string, ComposerDraft> | null {
  return useContext(ComposerDrafts);
}
export function readComposerDraftText(drafts: Map<string, ComposerDraft> | null, id: string): string {
  return drafts?.get(id)?.read().text ?? '';
}
export function writeComposerDraftText(drafts: Map<string, ComposerDraft> | null, id: string, change: SetStateAction<string>): void {
  if (!drafts) return;
  let store = drafts.get(id);
  if (!store) {
    store = new ComposerDraft();
    drafts.set(id, store);
  }
  store.set('text', change);
}
