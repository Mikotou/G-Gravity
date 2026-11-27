import { createHash } from 'node:crypto';
import type { SessionPlanSummary, SessionTodoItem } from '../../shared/session-contract';

export const unreceivedPlan = (): SessionPlanSummary => ({
  state: 'unreceived', revision: 0, totalCount: 0, completedCount: 0, failedCount: 0, truncated: false,
});

export function normalizePlan(entries: unknown) {
  if (!Array.isArray(entries)) return;
  const todos: SessionTodoItem[] = [];
  const digest = createHash('sha256');
  const occurrences = new Map<string, number>();
  const suppliedIds = new Set(entries.slice(0, 100).map(e => typeof e?.id === 'string' ? e.id.trim() : ''));
  const used = new Set<string>();
  let completedCount = 0, failedCount = 0;
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry.content !== 'string' || !entry.content.trim() ||
        (entry.status !== undefined && typeof entry.status !== 'string')) return;
    const raw = entry.status;
    let status: SessionTodoItem['status'];
    switch (raw) {
      case undefined: case 'pending': status = 'pending'; break;
      case 'done': case 'completed': status = 'completed'; break;
      case 'in_progress': case 'skipped': case 'failed': status = raw; break;
      default: status = 'unknown';
    }
    if (status === 'completed') completedCount++;
    if (status === 'failed') failedCount++;
    digest.update(JSON.stringify([entry.id, entry.content, raw, entry.priority]));
    if (index < 100) {
      const rawStatus = status === 'unknown' && raw !== 'unknown' ? raw : undefined;
      const supplied = typeof entry.id === 'string' && entry.id.trim();
      const key = supplied || 'todo-' + createHash('sha256').update(entry.content.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex').slice(0, 24);
      const ordinal = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, ordinal);
      let id = ordinal === 1 ? key : key + '-' + ordinal;
      while (used.has(id) || (id !== supplied && suppliedIds.has(id))) id += '-';
      used.add(id);
      todos.push({ id, content: entry.content, status,
        ...(typeof rawStatus === 'string' && { rawStatus: Array.from(rawStatus.slice(0, 128)).slice(0, 64).join('') }),
        ...(['high', 'medium', 'low'].includes(entry.priority) && { priority: entry.priority }) });
    }
  }
  const plan: Omit<SessionPlanSummary, 'revision'> = { state: entries.length ? 'present' : 'empty',
    totalCount: entries.length, completedCount, failedCount, truncated: entries.length > todos.length };
  return { todos, plan, digest: digest.digest('hex') };
}
