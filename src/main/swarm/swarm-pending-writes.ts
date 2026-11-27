function isLock(error: unknown): boolean {
  const e = error as { code?: string; errcode?: number; message?: string } | undefined;
  return (typeof e?.errcode === 'number' && [5, 6].includes(e.errcode & 255)) ||
    /^SQLITE_(BUSY|LOCKED)(_|$)/.test(e?.code ?? '') || /\bSQLITE_(?:BUSY|LOCKED)\b|database (?:table )?is locked/i.test(e?.message ?? '');
}

/** Retry the head in order. A listener can synchronously read history while a write is publishing. */
export class SwarmPendingWrites {
  private queues = new Map<string, { operations: Array<() => void>; locked: boolean; draining: boolean }>();
  constructor(private warning: (id: string) => void, private batchComplete: (id: string) => void) {}
  has(id: string) { return this.queues.has(id); }
  draining(id: string) { return this.queues.get(id)?.draining === true; }
  ids() { return [...this.queues.keys()]; }
  remove(id: string) { this.queues.delete(id); }

  persist(id: string, operation: () => void): void {
    const queue = this.queues.get(id);
    if (queue) { queue.operations.push(operation); return; }
    try { operation(); }
    catch (error) {
      this.queues.set(id, { operations: [operation], locked: isLock(error), draining: false });
      this.warning(id);
    }
  }

  drain(id: string, onRead = false): boolean {
    const queue = this.queues.get(id);
    if (!queue || queue.draining || (onRead && !queue.locked)) return false;
    queue.draining = true;
    const limit = 32;
    let completed = 0;
    try {
      while (completed < limit && completed < queue.operations.length) {
        queue.operations[completed]();
        completed++;
      }
    } catch (error) {
      queue.locked = isLock(error);
    } finally {
      queue.operations.splice(0, completed);
      if (!queue.operations.length) this.queues.delete(id);
      try { if (completed) this.batchComplete(id); }
      finally { queue.draining = false; }
    }
    return completed === limit && queue.operations.length > 0;
  }
}
