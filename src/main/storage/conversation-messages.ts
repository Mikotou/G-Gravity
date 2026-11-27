import { planReferences as extractPlanReferences } from '../session/plan-references';
import { createHash } from 'node:crypto';
import type { ChatMessageItem, ConversationMessagePage, MessagePagePosition } from '../../shared/session-contract';
import { advanceMessagePosition, emptyMessagePosition, MESSAGE_PAGE_SIZE } from '../../shared/session-contract';
import { redactSecretsForReviewer } from '../security/redaction';
import { restoreAnnotatedMessage } from '../session/annotation-prompt';
import {
  mergeBranchMessageStats, summarizeBranchMessages, type BranchMessageStats,
} from '../session/conversation-tree-store';
import type { ClientStore } from './client-store';

interface PageRef {
  file: string;
  end: MessagePagePosition;
  stats?: BranchMessageStats;
}
interface SessionLog {
  pages: PageRef[];
  recent: ChatMessageItem[];
  recoverOlder?: boolean;
  planHistoryChecked?: boolean;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function restore(items: ChatMessageItem[], recoverDelivery = true): ChatMessageItem[] {
  return items.filter(m => m && typeof m.id === 'string').map(item => ({
    ...restoreAnnotatedMessage({ ...item, content: typeof item.content === 'string' ? item.content : '' }), isStreaming: false,
    ...(recoverDelivery && item.questionFollowup && { questionFollowup: { ...item.questionFollowup,
      state: item.questionFollowup.state === 'queued' ? 'failed-unsent' : item.questionFollowup.state === 'sending' ? 'unknown' : item.questionFollowup.state } }),
    question: item.question?.state === 'open' ? { ...item.question, state: 'cancelled' } : item.question,
    thoughts: Array.isArray(item.thoughts) ? item.thoughts.filter(Boolean).map(block => ({ ...block, isStreaming: false, isTranslating: false })) : undefined,
  }));
}

/** Recent messages live in the atomic per-profile snapshot. Older pages are immutable and
 * written before its index is replaced. An interrupted save can always be retried. */
export class ConversationMessages {
  private replaced = new Set<string>();
  private dirty = false;
  private profile = '';
  private liveIndex: Record<string, unknown> = Object.create(null);
  private logs = new Map<string, SessionLog>();
  private unreadable = new Map<string, unknown>();
  private planRefsByPage = new WeakMap<PageRef, string[]>();
  private cached = new Map<string, ChatMessageItem[]>();
  private liveDeliveryPages = new Set<string>();
  constructor(private store: ClientStore) {}

  load(profile: string, owned?: ReadonlySet<string>): void {
    this.flush();
    this.clear();
    this.profile = profile;
    // Older executables write messages-<profile>.json on exit, including when they have no rows.
    const saved = this.store.read<Record<string, SessionLog | ChatMessageItem[]> | null>(this.indexFile(), null)
      ?? this.store.read<Record<string, ChatMessageItem[]> | null>('messages-' + profile + '.json', null)
      ?? (profile === 'default' ? this.store.read<Record<string, ChatMessageItem[]>>('messages.json', {}) : {});
    for (const [id, raw] of Object.entries(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {})) {
      if (owned && !owned.has(id)) continue;
      this.liveIndex[id] = raw;
      if (Array.isArray(raw)) {
        this.logs.set(id, { pages: [], recent: restore(raw), recoverOlder: raw.length === 500 });
      } else if (raw && Array.isArray(raw.pages) && Array.isArray(raw.recent)) {
        const prefix = this.prefix(id);
        if (!raw.pages.every((ref, i) => ref && typeof ref.file === 'string' && ref.file.startsWith(prefix) &&
            /^[a-f0-9]{64}\.json$/.test(ref.file.slice(prefix.length)) && ref.end?.earlierCount === (i + 1) * MESSAGE_PAGE_SIZE)) {
          this.unreadable.set(id, raw);
          this.logs.set(id, { pages: [], recent: restore(raw.recent) });
          continue;
        }
        this.logs.set(id, { ...raw, recent: restore(raw.recent) });
      } else {
        this.unreadable.set(id, raw);
        if (Array.isArray(raw?.recent)) this.logs.set(id, { pages: [], recent: restore(raw.recent) });
      }
    }
  }
  clear(): void { this.dirty = false; this.liveIndex = Object.create(null); this.logs.clear(); this.cached.clear(); this.liveDeliveryPages.clear(); this.unreadable.clear(); this.replaced.clear(); }
  keys() { return this.logs.keys(); }
  private indexFile(): string { return 'message-index-v2-' + this.profile + '.json'; }
  private prefix(id: string): string { return 'messages-page-' + hash(this.profile + '\0' + id) + '-'; }
  private readPage(ref: PageRef): ChatMessageItem[] {
    let items = this.cached.get(ref.file);
    if (!items) {
      const raw = this.store.read<ChatMessageItem[] | null>(ref.file, null);
      if (!Array.isArray(raw) || raw.length !== MESSAGE_PAGE_SIZE) throw new Error('无法读取已保存的历史消息页');
      items = restore(raw, !this.liveDeliveryPages.has(ref.file));
      if (this.cached.size >= 8) this.cached.delete(this.cached.keys().next().value!);
      this.cached.set(ref.file, items);
    }
    return items;
  }
  recent(id: string): ChatMessageItem[] { return this.logs.get(id)?.recent || []; }
  private indexPlanReferences(ref: PageRef, items: ChatMessageItem[]): string[] {
    const paths = [...new Set(extractPlanReferences(items))];
    this.planRefsByPage.set(ref, paths);
    return paths;
  }
  *planReferences(id: string, readArchives: boolean): Generator<string> {
    const log = this.logs.get(id);
    if (!log) return;
    yield* extractPlanReferences(log.recent);
    for (let i = log.pages.length - 1; i >= 0; i--) {
      const ref = log.pages[i];
      let paths = this.planRefsByPage.get(ref);
      if (!paths && readArchives) {
        try { paths = this.indexPlanReferences(ref, this.readPage(ref)); }
        catch { continue; } // An unavailable page supplies no authority. The readable tail is still usable.
      }
      if (paths) yield* paths;
    }
  }
  needsRecovery(id: string): boolean { return this.logs.get(id)?.recoverOlder === true; }
  hasCheckedPlanHistory(id: string): boolean { return this.logs.get(id)?.planHistoryChecked === true; }
  markPlanHistoryChecked(id: string): void {
    const log = this.logs.get(id);
    if (log && !log.planHistoryChecked) { log.planHistoryChecked = true; this.dirty = true; }
  }
  markRecovered(id: string): void { const log = this.logs.get(id); if (log?.recoverOlder) { delete log.recoverOlder; this.dirty = true; } }
  get(id: string): ChatMessageItem[] | undefined {
    if (this.unreadable.has(id)) throw new Error('此会话的旧消息索引无法读取，本地副本已保留');
    const log = this.logs.get(id);
    if (!log || !log.pages.length) return log?.recent;
    return [...log.pages.flatMap(p => this.readPage(p)), ...log.recent];
  }
  tail(id: string, count = 30): ChatMessageItem[] | undefined {
    if (this.unreadable.has(id)) throw new Error('此会话的旧消息索引无法读取，本地副本已保留');
    const log = this.logs.get(id);
    if (!log) return;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('历史消息数量无效');
    if (!count) return [];
    let items = log.recent.slice(-count);
    for (let i = log.pages.length - 1; i >= 0 && items.length < count; i--) {
      items = [...this.readPage(log.pages[i]).slice(items.length - count), ...items];
    }
    return items;
  }
  forStatistics(id: string): ChatMessageItem[] {
    try { return this.get(id) || []; }
    catch { return []; }
  }
  private availablePage(ref: PageRef): ChatMessageItem[] {
    try { return this.readPage(ref); }
    catch { return []; }
  }
  firstTurns(id: string): ChatMessageItem[] {
    const log = this.logs.get(id);
    if (!log) return [];
    let user: ChatMessageItem | undefined, assistant: ChatMessageItem | undefined;
    for (let i = 0; i <= log.pages.length && (!user || !assistant); i++) {
      const items = i === log.pages.length ? log.recent : this.availablePage(log.pages[i]);
      user ??= items.find(m => m.role === 'user');
      assistant ??= items.find(m => m.role === 'assistant');
    }
    return [user, assistant].filter((m): m is ChatMessageItem => Boolean(m));
  }
  reviewContext(id: string): ChatMessageItem[] {
    const log = this.logs.get(id);
    if (!log) return [];
    let first: ChatMessageItem | undefined;
    for (let i = 0; !first && i <= log.pages.length; i++) {
      const items = i === log.pages.length ? log.recent : this.availablePage(log.pages[i]);
      first = items.find(m => m.role === 'user' && m.content?.trim());
    }
    const latest: ChatMessageItem[] = [];
    let assistant: ChatMessageItem | undefined;
    for (let i = log.pages.length; i >= 0 && (latest.length < 4 || !assistant); i--) {
      const items = i === log.pages.length ? log.recent : this.availablePage(log.pages[i]);
      for (let j = items.length - 1; j >= 0; j--) {
        const m = items[j];
        if (!m.content?.trim()) continue;
        if (m.role === 'user' && latest.length < 4) latest.push(m);
        if (m.role === 'assistant') assistant ??= m;
        if (latest.length === 4 && assistant) break;
      }
    }
    latest.reverse();
    if (first && !latest.some(m => m.id === first.id)) latest.unshift(first);
    if (assistant) latest.push(assistant);
    return latest.map(({ id, sessionId, role, content, createdAt }) => ({
      id, sessionId, role, createdAt, content: redactSecretsForReviewer(content).slice(0, 2800),
    }));
  }
  branchStats(id: string): BranchMessageStats {
    const log = this.logs.get(id);
    let stats = summarizeBranchMessages([]);
    if (log) {
      for (const page of log.pages) {
        stats = mergeBranchMessageStats(stats, page.stats ?? summarizeBranchMessages(this.availablePage(page)));
      }
      stats = mergeBranchMessageStats(stats, summarizeBranchMessages(log.recent));
    }
    return stats;
  }
  set(id: string, recent: ChatMessageItem[]): void { this.dirty = true; this.replaced.add(id); this.logs.set(id, { pages: [], recent }); }
  discardUnsavedReplay(id: string): void {
    if (!this.unreadable.has(id)) { this.logs.delete(id); this.dirty = true; }
  }
  delete(id: string): void {
    this.dirty = true;
    this.logs.delete(id);
    this.unreadable.delete(id);
    const prefix = this.prefix(id);
    for (const file of this.cached.keys()) if (file.startsWith(prefix)) this.cached.delete(file);
    this.store.removeMessagePages(prefix);
    const oldFiles = ['messages-' + this.profile + '.json'];
    if (this.profile === 'default') oldFiles.push('messages.json');
    for (const file of oldFiles) {
      const saved = this.store.read<Record<string, unknown> | null>(file, null);
      if (saved && Object.hasOwn(saved, id)) {
        delete saved[id];
        this.store.write(file, saved);
      }
    }
  }
  upsert(message: ChatMessageItem): void {
    this.dirty = true;
    let log = this.logs.get(message.sessionId);
    if (!log) { log = { pages: [], recent: [] }; this.logs.set(message.sessionId, log); }
    const index = log.recent.findIndex(m => m.id === message.id);
    if (index >= 0) log.recent[index] = message;
    else log.recent.push(message);
  }
  findMessage(id: string, messageId: string): ChatMessageItem | undefined {
    const log = this.logs.get(id);
    if (!log) return;
    const recent = log.recent.find(m => m.id === messageId);
    if (recent) return recent;
    for (let i = log.pages.length - 1; i >= 0; i--) {
      const message = this.readPage(log.pages[i]).find(m => m.id === messageId);
      if (message) return message;
    }
  }

  /** Commit question, receipt and visible follow-up in one index replacement, even for a paged retry. */
  commitInteraction(id: string, changes: ChatMessageItem[], appendedId?: string): void {
    const original = this.logs.get(id);
    if (!original) throw new Error('会话消息不存在');
    const log = { ...original, pages: [...original.pages], recent: [...original.recent] };
    const replacements = new Map(changes.map(m => [m.id, m]));
    for (const [index, message] of log.recent.entries()) {
      const next = replacements.get(message.id);
      if (next) { log.recent[index] = next; replacements.delete(next.id); }
    }
    const appended = appendedId && replacements.get(appendedId);
    if (appended) { log.recent.push(appended); replacements.delete(appended.id); }
    const rewritten: Array<{ old: string; live?: string }> = [];
    for (let i = log.pages.length - 1; replacements.size && i >= 0; i--) {
      const ref = log.pages[i];
      const page = this.readPage(ref);
      if (!page.some(m => replacements.has(m.id))) continue;
      const changed = page.map(m => {
        const next = replacements.get(m.id);
        replacements.delete(m.id);
        return next || m;
      });
      const file = this.prefix(id) + hash(JSON.stringify(changed)) + '.json';
      this.store.write(file, changed);
      const live = changed.some(m => m.questionFollowup?.state === 'queued' || m.questionFollowup?.state === 'sending');
      rewritten.push({ old: ref.file, live: live ? file : undefined });
      log.pages[i] = { ...ref, file, stats: summarizeBranchMessages(changed) };
      this.indexPlanReferences(log.pages[i], changed);
    }
    if (replacements.size) throw new Error('无法定位提问消息');
    this.logs.set(id, log);
    if (rewritten.length) this.replaced.add(id);
    try { this.save(); }
    catch (error) { this.logs.set(id, original); throw error; }
    for (const page of rewritten) {
      this.cached.delete(page.old);
      this.liveDeliveryPages.delete(page.old);
      if (page.live) this.liveDeliveryPages.add(page.live);
    }
  }
  page(id: string, before?: number): ConversationMessagePage {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new Error('历史消息位置无效');
    const log = this.logs.get(id);
    const historyIndexUnavailable = this.unreadable.has(id) || undefined;
    if (!log) return { ...emptyMessagePosition(), messages: [], historyIndexUnavailable };
    const archived = log.pages.length * MESSAGE_PAGE_SIZE;
    const end = Math.min(before ?? Infinity, archived + log.recent.length);
    const start = Math.max(0, end - MESSAGE_PAGE_SIZE);
    const first = Math.min(Math.floor(start / MESSAGE_PAGE_SIZE), log.pages.length);
    const offset = start - first * MESSAGE_PAGE_SIZE;
    let position = first > 0 ? log.pages[first - 1].end : emptyMessagePosition();
    const messages: ChatMessageItem[] = [];
    for (let i = first; i <= log.pages.length && i * MESSAGE_PAGE_SIZE < end; i++) {
      const items = i === log.pages.length ? log.recent : this.readPage(log.pages[i]);
      const from = i === first ? offset : 0;
      if (from) position = advanceMessagePosition(position, items.slice(0, from));
      messages.push(...items.slice(from, end - i * MESSAGE_PAGE_SIZE));
    }
    return { ...position, messages, historyIndexUnavailable };
  }
  saveStreaming(id: string): void {
    const log = this.logs.get(id);
    if (!log || this.unreadable.has(id)) return;
    this.liveIndex[id] = log;
    this.store.writeDebounced(this.indexFile(), this.liveIndex);
  }
  flush(): void {
    if (!this.profile) return;
    if (this.dirty) this.save(); else this.store.flushPending(this.indexFile());
  }

  save(): void {
    this.dirty = true;
    const output: Record<string, SessionLog> = Object.create(null);
    for (const [id, log] of this.logs) {
      if (this.unreadable.has(id)) continue;
      const pages = [...log.pages];
      let split = 0;
      while (log.recent.length - split >= 2 * MESSAGE_PAGE_SIZE) {
        const chunk = log.recent.slice(split, split + MESSAGE_PAGE_SIZE);
        if (chunk.some(m => m.questionFollowup?.state === 'queued' || m.questionFollowup?.state === 'sending' || m.isStreaming || m.question?.state === 'open' || m.thoughts?.some(b => b.isTranslating || b.isStreaming))) break;
        const file = this.prefix(id) + hash(JSON.stringify(chunk)) + '.json';
        this.store.write(file, chunk);
        const end = advanceMessagePosition(pages.at(-1)?.end || emptyMessagePosition(), chunk);
        const ref = { file, end, stats: summarizeBranchMessages(chunk) };
        this.indexPlanReferences(ref, chunk);
        pages.push(ref);
        split += chunk.length;
      }
      output[id] = { pages, recent: split ? log.recent.slice(split) : log.recent, recoverOlder: log.recoverOlder || undefined, planHistoryChecked: log.planHistoryChecked || undefined };
    }
    const preserved = Object.fromEntries([...this.unreadable].map(([id, raw]) => {
      const log = this.logs.get(id);
      if (!log) return [id, raw];
      return [id, { ...(raw && typeof raw === 'object' ? raw : { unreadableIndex: raw }), recent: log.recent }];
    }));
    const index = Object.assign(Object.create(null), preserved, output);
    this.store.write(this.indexFile(), index);
    this.liveIndex = index;
    for (const [id, log] of Object.entries(output)) this.logs.set(id, log);
    for (const id of this.replaced) {
      try {
        if (output[id]) this.store.removeMessagePages(this.prefix(id), new Set(output[id].pages.map(page => page.file)));
      } catch { continue; } // The index is committed. Retry orphan cleanup on a later save.
      this.replaced.delete(id);
    }
    this.dirty = false;
  }
}
