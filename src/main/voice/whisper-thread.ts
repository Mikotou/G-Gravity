import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { VoiceLocale } from '../../shared/voice-contract';

/** Each capture owns one model context and can terminate it during inference. */
export class WhisperThread {
  private worker: Worker;
  private next = 0;
  private pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
  private termination?: Promise<void>;
  private readonly abort = () => { void this.close(); };
  constructor(root: string, model: ArrayBuffer, locale: VoiceLocale, private signal: AbortSignal) {
    signal.throwIfAborted();
    this.worker = new Worker(join(root, 'worker.cjs'), {
      workerData: { model, language: locale === 'zh-CN' ? 'zh' : locale === 'en-US' ? 'en' : 'auto' }, transferList: [model],
    });
    this.worker.on('message', value => {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      if (typeof value.text === 'string') pending.resolve(value.text);
      else pending.reject(Error('离线语音转写失败'));
    });
    this.worker.once('error', this.abort);
    this.worker.once('exit', this.abort);
    signal.addEventListener('abort', this.abort, { once: true });
  }
  run(pcm: Uint8Array): Promise<string> {
    if (this.termination || this.signal.aborted) return Promise.reject(Error('离线转写已结束'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const pcm16 = Uint8Array.from(pcm).buffer;
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, pcm16 }, [pcm16]); }
      catch { this.pending.delete(id); reject(Error('无法提交离线语音')); }
    });
  }
  close(): Promise<void> {
    if (!this.termination) {
      this.signal.removeEventListener('abort', this.abort);
      for (const p of this.pending.values()) p.reject(Error('离线转写已结束'));
      this.pending.clear();
      this.termination = this.worker.terminate().then(() => {});
    }
    return this.termination;
  }
}
