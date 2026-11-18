import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/** One lazy offline engine serves concurrent sessions without blocking Electron's main loop. */
export class LocalTranslator {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  translate(text: string): Promise<string> {
    if (!this.worker) {
      const worker = new Worker(join(__dirname, '../../../assets/local-translation/worker.cjs'));
      this.worker = worker;
      worker.on('message', (result: { id: number; text?: string; error?: string }) => {
        const job = this.pending.get(result.id);
        if (!job || this.worker !== worker) return;
        this.pending.delete(result.id);
        if (result.error) job.reject(new Error(result.error));
        else job.resolve(result.text || '');
      });
      worker.on('error', error => this.stop(worker, error));
      worker.on('exit', () => this.stop(worker, new Error('本地翻译进程已关闭')));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker!.postMessage({ id, text }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private stop(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }

  dispose(): void {
    const worker = this.worker;
    if (worker) {
      this.stop(worker, new Error('本地翻译已关闭'));
      void worker.terminate();
    }
  }
}
