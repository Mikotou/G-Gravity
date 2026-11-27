/**
 * v0.3.6 PCM 编码：任意采样率 Float32 单声道 → 16 kHz 小端 PCM16，按 0.5 秒（8,000 样本 = 16,000 字节）切片。
 * 每片为独立定长 ArrayBuffer（零偏移整段，可 transfer），满足 `VOICE_APPEND` 二进制白名单。
 * 纯计算模块，同时被 AudioWorklet 与 ScriptProcessorNode 降级路径使用。
 */
export const TARGET_RATE = 16_000;
export const CHUNK_SAMPLES = 8_000;

export class Pcm16Chunker {
  private readonly ratio: number;
  private pos = 0;
  private buf = new Int16Array(CHUNK_SAMPLES);
  private fill = 0;

  constructor(inputRate: number, private readonly emit: (chunk: ArrayBuffer) => void) {
    this.ratio = inputRate / TARGET_RATE;
  }

  /** 线性插值降采样并写入当前片；满 0.5 秒即输出一片。 */
  push(input: Float32Array): void {
    let pos = this.pos;
    while (pos < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = input[i];
      const b = i + 1 < input.length ? input[i + 1] : a;
      const v = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.buf[this.fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.fill === CHUNK_SAMPLES) this.flushFull();
      pos += this.ratio;
    }
    this.pos = pos - input.length;
  }

  /** 输出剩余不足 0.5 秒的尾片（至少 1 个样本）。 */
  flush(): void {
    if (this.fill === 0) return;
    const out = new ArrayBuffer(this.fill * 2);
    writeLe(out, this.buf, this.fill);
    this.fill = 0;
    this.emit(out);
  }

  private flushFull(): void {
    const out = new ArrayBuffer(CHUNK_SAMPLES * 2);
    writeLe(out, this.buf, CHUNK_SAMPLES);
    this.fill = 0;
    this.emit(out);
  }
}

function writeLe(out: ArrayBuffer, samples: Int16Array, count: number): void {
  const view = new DataView(out);
  for (let i = 0; i < count; i++) view.setInt16(i * 2, samples[i], true);
}
