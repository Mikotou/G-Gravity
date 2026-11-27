import type { ChatMessageItem } from '../../shared/session-contract';
import type { QuestionFollowupState } from '../../shared/user-question';
import type { ConversationMessages } from '../storage/conversation-messages';
import type { SubmittedQuestion } from './question-submission';

const transitions: Record<QuestionFollowupState, readonly QuestionFollowupState[]> = {
  queued: ['sending', 'failed-unsent'], sending: ['sent', 'failed-unsent', 'unknown'],
  'failed-unsent': ['queued'], sent: [], unknown: [],
};

/** FIFO holds only work from the live transport. The authoritative state and content live in the transcript. */
export class QuestionFollowups {
  private queue = new Map<string, ChatMessageItem[]>();
  private active = new Map<string, ChatMessageItem>();
  constructor(private messages: () => ConversationMessages, private publish: (message: ChatMessageItem) => void) {}

  has(id: string) { return this.queue.has(id); }
  add(message: ChatMessageItem): void {
    const rows = this.queue.get(message.sessionId) ?? [];
    rows.push(message);
    this.queue.set(message.sessionId, rows);
  }
  take(id: string): ChatMessageItem | undefined {
    const rows = this.queue.get(id);
    const next = rows?.shift();
    if (!rows?.length) this.queue.delete(id);
    if (next) this.active.set(id, next);
    return next;
  }

  retry(question: SubmittedQuestion): ChatMessageItem {
    const id = question.submissionRecord?.receipt.followupMessageId;
    const message = id && this.messages().findMessage(question.sessionId, id);
    if (!message || message.questionFollowup?.state !== 'failed-unsent') throw Error('仅可重试已确认未发送的跟进');
    const copy = { ...message };
    this.change(copy, 'queued');
    return copy;
  }

  change(message: ChatMessageItem, state: QuestionFollowupState): void {
    const current = message.questionFollowup!;
    const store = this.messages();
    const original = store.findMessage(message.sessionId, current.questionMessageId) as SubmittedQuestion | undefined;
    if (!original?.questionFollowup || original.questionFollowup.submissionId !== current.submissionId ||
        original.submissionRecord?.receipt.followupMessageId !== message.id) throw Error('跟进消息归属已改变');
    if (original.questionFollowup.state !== current.state || !transitions[current.state].includes(state)) {
      throw Error('跟进发送状态已改变');
    }
    const meta = { ...current, state };
    const user = { ...message, sendFailed: undefined, questionFollowup: meta };
    const question = { ...original, questionFollowup: meta };
    store.commitInteraction(message.sessionId, [question, user]);
    message.questionFollowup = meta;
    if (state !== 'sending' && this.active.get(message.sessionId) === message) this.active.delete(message.sessionId);
    this.publish(question);
    this.publish(user);
  }
  end(id: string): void {
    const current = this.active.get(id);
    if (current) this.change(current, current.questionFollowup?.state === 'sending' ? 'unknown' : 'failed-unsent');
    this.failQueued(id);
  }
  failQueued(id?: string): void {
    for (const [sid, rows] of this.queue) {
      if (id !== undefined && sid !== id) continue;
      while (rows.length) {
        this.change(rows[0], 'failed-unsent');
        rows.shift();
      }
      this.queue.delete(sid);
    }
  }
  sessions() { return new Set([...this.queue.keys(), ...this.active.keys()]); }
}
