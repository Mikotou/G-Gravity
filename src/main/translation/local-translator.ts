import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

interface QueuedLocalJob {
  text: string;
  signal?: AbortSignal;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

function createAbortError(): Error {
  const err = new Error('本地翻译请求已取消');
  err.name = 'AbortError';
  return err;
}

/**
 * One lazy offline Bergamot worker serves concurrent sessions without blocking Electron's main loop.
 * Dispatches one job at a time so stale/aborted queued jobs from closed or reopened thoughts
 * are dropped before ever reaching the single-threaded WASM worker.
 */
export class LocalTranslator {
  private worker?: Worker;
  private nextId = 0;
  private activeJob?: { id: number; job: QueuedLocalJob };
  private queue: QueuedLocalJob[] = [];

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(join(__dirname, '../../../assets/local-translation/worker.cjs'));
    this.worker = worker;
    worker.on('message', (result: { id: number; text?: string; error?: string }) => {
      if (this.worker !== worker) return;
      const active = this.activeJob;
      if (!active || active.id !== result.id) return;
      this.activeJob = undefined;
      this.detachAbort(active.job);
      if (!active.job.signal?.aborted) {
        if (result.error) active.job.reject(new Error(result.error));
        else active.job.resolve(result.text || '');
      }
      this.pump();
    });
    worker.on('error', (error) => this.stop(worker, error));
    worker.on('exit', () => this.stop(worker, new Error('本地翻译进程已关闭')));
    return worker;
  }

  private detachAbort(job: QueuedLocalJob): void {
    if (job.signal && job.onAbort) {
      job.signal.removeEventListener('abort', job.onAbort);
      job.onAbort = undefined;
    }
  }

  private pump(): void {
    if (this.activeJob) return;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) {
        this.detachAbort(next);
        continue;
      }
      try {
        const worker = this.ensureWorker();
        const id = ++this.nextId;
        this.activeJob = { id, job: next };
        worker.postMessage({ id, text: next.text });
        return;
      } catch (error) {
        this.activeJob = undefined;
        this.detachAbort(next);
        next.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  translate(text: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    return new Promise((resolve, reject) => {
      const job: QueuedLocalJob = { text, signal, resolve, reject };
      if (signal) {
        const onAbort = () => {
          this.detachAbort(job);
          const idx = this.queue.indexOf(job);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
          }
          reject(createAbortError());
        };
        job.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private stop(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    const active = this.activeJob;
    this.activeJob = undefined;
    if (active) {
      this.detachAbort(active.job);
      if (!active.job.signal?.aborted) active.job.reject(error);
    }
    for (const job of this.queue.splice(0)) {
      this.detachAbort(job);
      if (!job.signal?.aborted) job.reject(error);
    }
  }

  dispose(): void {
    const worker = this.worker;
    if (worker) {
      this.stop(worker, new Error('本地翻译已关闭'));
      void worker.terminate();
    } else {
      for (const job of this.queue.splice(0)) {
        this.detachAbort(job);
        if (!job.signal?.aborted) job.reject(new Error('本地翻译已关闭'));
      }
    }
  }
}
