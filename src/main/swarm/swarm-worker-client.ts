import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AcpSessionUpdatePayload } from '../../shared/acp-protocol';
import type { SwarmHistoryCursor, SwarmTopologyState } from '../../shared/swarm-contract';
import type { SwarmCommand, SwarmReply, SwarmWorkerData } from './swarm-worker-protocol';

export class SwarmWorkerClient extends EventEmitter {
  private worker?: Worker;
  private closing?: Promise<void>;
  private terminating?: Worker;
  private sequence = 0;
  private fatal?: Error;
  private waiters = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private snapshots = new Map<string, SwarmTopologyState>();
  constructor(private data: SwarmWorkerData) { super(); }

  private connect(): Worker {
    if (this.fatal) throw this.fatal;
    if (this.closing) throw new Error('Swarm 存储线程正在关闭');
    if (this.worker) return this.worker;
    const packaged = join(__dirname, 'swarm-worker.js');
    const entry = existsSync(packaged) ? packaged : join(__dirname, '../../../dist/main/swarm/swarm-worker.js');
    const worker = new Worker(entry, { workerData: this.data });
    this.worker = worker;
    const failed = (error: Error) => {
      if (this.worker !== worker || this.terminating === worker) return;
      this.worker = undefined;
      if (this.waiters.size) this.fatal = error;
      this.snapshots.clear();
      for (const waiter of this.waiters.values()) waiter.reject(error);
      this.waiters.clear();
      this.emit('storage-failed', error);
    };
    worker.on('error', failed);
    worker.on('exit', code => failed(new Error('Swarm 存储线程意外退出 (' + code + ')')));
    worker.on('message', (reply: SwarmReply) => {
      if (this.worker !== worker) return;
      if ('updated' in reply) {
        this.cache(reply.updated);
        this.emit('updated', reply.updated);
        return;
      }
      const waiter = this.waiters.get(reply.id);
      if (!waiter) return;
      this.waiters.delete(reply.id);
      if (!this.waiters.size) worker.unref();
      if (reply.error !== undefined) waiter.reject(new Error(reply.error)); else waiter.resolve(reply.value);
    });
    return worker;
  }
  private request<T>(command: SwarmCommand): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const worker = this.connect();
      const id = ++this.sequence;
      worker.ref();
      this.waiters.set(id, { resolve: value => resolve(value as T), reject });
      try { worker.postMessage({ id, ...command }); }
      catch (error) {
        this.waiters.delete(id);
        if (!this.waiters.size) worker.unref();
        reject(error);
      }
    });
  }
  private enqueue(command: SwarmCommand): void {
    const duringClose = Boolean(this.closing);
    void this.request(command).catch(error => {
      if (!duringClose) this.fatal ??= error;
      this.emit('storage-failed', error);
    });
  }
  private cache(state: SwarmTopologyState): void {
    this.snapshots.delete(state.sessionId);
    this.snapshots.set(state.sessionId, state);
    if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
  /** Most recent committed push. Use readState to await all preceding writes and load history. */
  getState(sessionId: string): SwarmTopologyState {
    return structuredClone(this.snapshots.get(sessionId) ?? { sessionId, isActive: false, swarmTitle: '', workers: [],
      boardMessages: [], actionTimeline: [], channels: [], stats: { total: 0, working: 0, waiting: 0, completed: 0, killed: 0 }, updatedAt: '', historyUnavailable: true });
  }
  async readState(id: string, before?: SwarmHistoryCursor): Promise<SwarmTopologyState> {
    const result = await this.request<SwarmTopologyState>({ method: 'getState', args: [id, before] });
    if (!before) {
      const recovered = this.snapshots.get(id)?.historyUnavailable && !result.historyUnavailable;
      this.cache(result);
      if (recovered) this.emit('updated', result);
    }
    return result;
  }
  needsReplay(id: string) { return this.request<boolean>({ method: 'needsReplay', args: [id] }); }
  beginReplay(id: string) { this.enqueue({ method: 'beginReplay', args: [id] }); }
  finishReplay(id: string) { return this.request<void>({ method: 'finishReplay', args: [id] }); }
  discardReplay(id: string) { this.enqueue({ method: 'discardReplay', args: [id] }); }
  trackNew(id: string) { this.enqueue({ method: 'trackNew', args: [id] }); }
  markUnconfirmed(id: string, zh?: string, en?: string) { this.enqueue({ method: 'markUnconfirmed', args: [id, zh, en] }); }
  disconnected() { if (this.worker) this.enqueue({ method: 'disconnected', args: [] }); }
  consume(id: string, update: AcpSessionUpdatePayload, replay = false) {
    if (update.toolCallId && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
      this.enqueue({ method: 'consume', args: [id, update, replay] });
    }
  }
  async remove(id: string) {
    await this.request({ method: 'remove', args: [id] });
    this.snapshots.delete(id);
  }
  async flush(): Promise<string[]> {
    if (this.fatal) throw this.fatal;
    return this.worker ? this.request<string[]>({ method: 'flush', args: [] }) : [];
  }
  async clear(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.fatal) throw this.fatal;
    const worker = this.worker;
    if (!worker) return;
    this.closing = this.request<string[]>({ method: 'clear', args: [] }).then(async failed => {
      if (failed.length) throw new Error('Swarm 仍有未保存记录：' + failed.join(', '));
      this.terminating = worker;
      try { await worker.terminate(); } finally { this.terminating = undefined; }
      this.worker = undefined;
      this.snapshots.clear();
    });
    try { await this.closing; } finally { this.closing = undefined; }
  }
}
