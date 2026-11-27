import { randomUUID } from 'node:crypto';
import type { AcpSessionUpdatePayload } from '../../shared/acp-protocol';
import type { ChatMessageItem } from '../../shared/session-contract';
import { restoreAnnotatedMessage } from './annotation-prompt';
import { InspectorStore } from './inspector-store';
import { appendImage } from './message-images';
import type { LocalTargetContext } from '../services/local-media-inspector';

/** A complete ACP load may supply the missing prefix of a legacy 500-message snapshot.
 * Assemble it privately until the service confirms the load; no duplicate UI, usage or translation events. */
export class HistoryReplay {
  private messages: ChatMessageItem[] = [];
  private inspector = new InspectorStore();
  constructor(private sessionId: string, private mediaContext?: () => LocalTargetContext) {}

  consume(update: AcpSessionUpdatePayload): void {
    const kind = update.sessionUpdate;
    if (!['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(kind)) return;
    const role = kind === 'user_message_chunk' ? 'user' : 'assistant';
    let m = this.messages.at(-1);
    if (m?.role !== role) {
      const id = randomUUID();
      m = { id, originMessageId: id, sessionId: this.sessionId, role, content: '', isStreaming: false, createdAt: new Date().toISOString() };
      this.messages.push(m);
    }
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
      m.content += update.content?.text || '';
      appendImage(m, update.content, this.mediaContext);
    } else if (kind === 'agent_thought_chunk') {
      const block = (m.thoughts ||= [])[0] ||= { id: randomUUID(), originalText: '', translatedZhText: '',
        isStreaming: false, isTranslating: false, languageDetected: 'mixed', translationSource: 'pending' };
      block.originalText += update.content?.text || '';
    } else if (kind === 'plan') {
      const todos = this.inspector.consume(this.sessionId, { ...update, sessionUpdate: 'plan' });
      if (todos) m.todos = todos;
    } else if (update.toolCallId) {
      const cards = m.toolCalls ||= [];
      const index = cards.findIndex(c => c.toolCallId === update.toolCallId);
      const card = this.inspector.consume(this.sessionId, update, cards[index]);
      if (card) { if (index === -1) cards.push(card); else cards[index] = card; }
      appendImage(m, update.toolContent || update.content, this.mediaContext);
    }
  }

  all(): ChatMessageItem[] { return this.messages.map(restoreAnnotatedMessage); }
  dispose(): void { this.inspector.clear(); }

  prefixFor(local: ChatMessageItem[]): ChatMessageItem[] | undefined {
    const replay = this.all();
    // Identify a unique overlapping sequence. Ambiguous or unrecognizable copies remain untouched.
    const anchor = local.filter(m => m.role !== 'system').slice(0, 3);
    if (!anchor.length || !anchor.some(m => m.content.trim() || m.annotations?.length || m.attachments?.length || m.references?.length)) return;
    const fingerprint = (m: ChatMessageItem) => JSON.stringify([m.role, m.content,
      m.annotations?.map(a => [a.excerpt, a.comment, a.originMessageId || a.messageId, a.messageNumber]) ?? [],
      m.references?.map(r => [r.kind, r.value]) ?? [],
      m.attachments?.map(a => [a.name, a.mimeType, a.sizeBytes, a.uri, a.textContent, a.dataUrl, a.dataBase64]) ?? []]);
    const keys = anchor.map(fingerprint);
    const replayKeys = replay.map(fingerprint);
    const matches = replayKeys.flatMap((_, i) => keys.every((key, j) => key === replayKeys[i + j]) ? [i] : []);
    if (matches.length === 1) return replay.slice(0, matches[0]);
    if (matches.length || local.length < 8) return;
    // Some legacy ACP servers echoed plain text but omitted client-only decorations. Recover only
    // when the entire tail aligns, with a long unique fully matching suffix and no conflicting metadata.
    const tail = local.filter(m => m.role !== 'system');
    const offset = replay.length - tail.length;
    if (offset < 0 || tail.length < 8) return;
    const bare = (m: ChatMessageItem) => !m.annotations?.length && !m.references?.length && !m.attachments?.length;
    if (!tail.every((m, i) => fingerprint(m) === replayKeys[offset + i] ||
        (bare(replay[offset + i]) && m.role === replay[offset + i].role && m.content.trim() && m.content === replay[offset + i].content))) return;
    const suffix = tail.slice(-6).map(fingerprint);
    if (new Set(suffix).size !== suffix.length || !suffix.every((key, i) => key === replayKeys[replay.length - 6 + i])) return;
    const suffixStarts = replayKeys.filter((key, i) => key === suffix[0] && suffix.every((s, j) => s === replayKeys[i + j]));
    return suffixStarts.length === 1 ? replay.slice(0, offset) : undefined;
  }
}
