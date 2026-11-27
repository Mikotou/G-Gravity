import type { ChatMessageItem } from '../../shared/session-contract';
import type { ConversationMessages } from '../storage/conversation-messages';

export class TurnActivity {
  private turns = new Map<string, { start: string; messages: Map<string, ChatMessageItem> }>();

  begin(id: string): void {
    if (!this.turns.has(id)) this.turns.set(id, { start: new Date().toISOString(), messages: new Map() });
  }
  stamp(message: ChatMessageItem): void {
    const turn = this.turns.get(message.sessionId);
    if (!turn || message.role !== 'assistant') return;
    message.turnStartedAt = turn.start;
    turn.messages.set(message.id, message);
  }
  clear(id?: string): void {
    if (id === undefined) this.turns.clear();
    else this.turns.delete(id);
  }
  settle(id: string, store: ConversationMessages, publish: (m: ChatMessageItem) => void): void {
    const turn = this.turns.get(id);
    if (!turn) return;
    let changes: ChatMessageItem[];
    try {
      const end = new Date().toISOString();
      changes = [...turn.messages.keys()].flatMap(messageId => {
        const item = store.findMessage(id, messageId);
        return item ? [{ ...item, turnSettledAt: end }] : [];
      });
      if (changes.length) store.commitInteraction(id, changes);
      for (const message of turn.messages.values()) message.turnSettledAt = end;
    } finally { this.turns.delete(id); }
    changes.forEach(publish);
  }
}
