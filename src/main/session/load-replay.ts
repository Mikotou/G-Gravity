import type { AcpSessionUpdatePayload } from '../../shared/acp-protocol';
import type { SemanticToolCallCard } from '../../shared/session-contract';
import type { TurnHost } from '../core-contracts';
import { HistoryReplay } from './history-replay';
import { normalizePlan } from './session-plan';

/** Staging belongs to this profile's message store and this particular load attempt. */
export class LoadReplay {
  private readonly attempts = new Map<string, {
    consume(update: AcpSessionUpdatePayload): void;
    clear(): void;
  }>();
  constructor(private readonly app: TurnHost) {}
  keys() { return this.attempts.keys(); }
  delete(id: string) { this.attempts.get(id)?.clear(); this.attempts.delete(id); }
  consume(id: string, update: AcpSessionUpdatePayload): boolean {
    const attempt = this.attempts.get(id);
    if (!attempt) return false;
    attempt.consume(update);
    return true;
  }

  begin(id: string, compact: Set<string>) {
    this.delete(id);
    const { messages, inspector, swarm } = this.app;
    const profile = this.app.accounts.activeProfileId;
    const first = !messages.recent(id).length;
    const recovering = messages.needsRecovery(id);
    const history = first || recovering ? new HistoryReplay(id, this.app.mediaContext) : undefined;
    const tools: AcpSessionUpdatePayload[] = [];
    let latest: ReturnType<typeof normalizePlan>;
    let hasCompact: boolean | undefined;
    let committed = false;
    const attempt = {
      clear: () => history?.dispose(),
      consume: (update: AcpSessionUpdatePayload) => {
        swarm.consume(id, update, true);
        history?.consume(update);
        if (update.sessionUpdate === 'plan') latest = normalizePlan(update.entries) ?? latest;
        if (first && ['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) tools.push(update);
        if (update.sessionUpdate === 'available_commands_update') {
          const commands = (update as { availableCommands?: Array<{ name: string }> }).availableCommands;
          if (Array.isArray(commands)) hasCompact = commands.some(command => command.name === 'compact');
        }
      },
    };
    this.attempts.set(id, attempt);
    const current = () => !this.app.disposed && this.attempts.get(id) === attempt && this.app.messages === messages &&
      this.app.accounts.activeProfileId === profile;
    return { current, first, recovering, discard: () => { if (this.attempts.get(id) === attempt) this.delete(id); },
      commit: () => {
        if (committed || !current()) throw new Error('恢复期间会话归属已改变');
        committed = true;
        const local = recovering ? messages.get(id) || [] : [];
        const added = first ? history?.all() : recovering ? history?.prefixFor(local) : undefined;
        if (added) {
          if (added.length) messages.set(id, [...added, ...local]);
          messages.markRecovered(id);
          messages.flush();
        }
        if (latest) inspector.applyPlan(id, latest);
        const cards = new Map<string, SemanticToolCallCard>();
        for (const update of tools) {
          const card = inspector.consume(id, update, cards.get(update.toolCallId || ''));
          if (card) cards.set(card.toolCallId, card);
        }
        if (hasCompact === true) compact.add(id);
        if (hasCompact === false) compact.delete(id);
        if (first) for (const message of added || []) this.app.emit('message-upserted', { sessionId: id, message: structuredClone(message) });
      },
    };
  }
}
