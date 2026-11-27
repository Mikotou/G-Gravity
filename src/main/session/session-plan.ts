import type { SessionPlanSummary, SessionTodoItem } from '../../shared/session-contract';

export const unreceivedPlan = (): SessionPlanSummary => ({
  state: 'unreceived', revision: 0, totalCount: 0, completedCount: 0, failedCount: 0, truncated: false,
});

export function normalizePlan(entries: unknown) {
  if (!Array.isArray(entries)) return;
  const todos: SessionTodoItem[] = [];
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
    if (index < 100) {
      const rawStatus = status === 'unknown' && raw !== 'unknown' ? raw : undefined;
      todos.push({ id: 'todo-' + index, content: entry.content, status,
        ...(typeof rawStatus === 'string' && { rawStatus: Array.from(rawStatus.slice(0, 128)).slice(0, 64).join('') }),
        ...(['high', 'medium', 'low'].includes(entry.priority) && { priority: entry.priority }) });
    }
  }
  const plan: Omit<SessionPlanSummary, 'revision'> = { state: entries.length ? 'present' : 'empty',
    totalCount: entries.length, completedCount, failedCount, truncated: entries.length > todos.length };
  return { todos, plan };
}
