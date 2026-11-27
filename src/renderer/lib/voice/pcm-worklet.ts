/**
 * v0.3.6 AudioWorklet 处理器：经 `?worker&url` 打包为独立同源资产（CSP `script-src 'self'` 无放宽）。
 * 主线程 `port.postMessage('flush')` 输出尾片；每片 ArrayBuffer 以 transfer 方式交给主线程。
 */
import { Pcm16Chunker } from './pcm-encoder';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class GravityPcmProcessor extends AudioWorkletProcessor {
  private readonly chunker = new Pcm16Chunker(sampleRate, (chunk) => this.port.postMessage(chunk, [chunk]));

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data === 'flush') {
        this.chunker.flush();
        this.port.postMessage('flushed');
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel && channel.length) this.chunker.push(channel);
    return true;
  }
}

registerProcessor('gravity-pcm16', GravityPcmProcessor);
