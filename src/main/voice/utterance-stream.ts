/** Speech boundaries use 20 ms energy frames. Each sample is submitted at most once. */
export class UtteranceStream {
  private parts: Buffer[] = [];
  private bytes = 0;
  private frameEnergy = 0;
  private frameSamples = 0;
  private speech = false;
  private quietFrames = 0;
  private chain = Promise.resolve();
  private failed = false;

  constructor(private infer: (pcm: Buffer) => Promise<string>, private publish: (text: string) => void,
    private signal: AbortSignal) {}

  append(bytes: Buffer): void {
    let start = 0;
    for (let i = 0; i < bytes.length; i += 2) {
      const sample = bytes.readInt16LE(i);
      this.frameEnergy += sample * sample;
      if (++this.frameSamples < 320) continue;
      const voiced = this.frameEnergy >= 320 * 110 ** 2;
      this.speech ||= voiced;
      this.quietFrames = voiced ? 0 : this.quietFrames + 1;
      this.frameEnergy = this.frameSamples = 0;
      const size = this.bytes + i + 2 - start;
      if (size >= 320_000 || (this.quietFrames >= 18 && (this.speech || size >= 32_000))) {
        this.push(bytes.subarray(start, i + 2));
        this.flushSegment();
        start = i + 2;
      }
    }
    this.push(bytes.subarray(start));
  }

  private push(part: Buffer): void {
    if (part.length) { this.parts.push(part); this.bytes += part.length; }
  }
  private flushSegment(): void {
    const pcm = this.speech || this.frameEnergy > this.frameSamples * 110 ** 2 ? Buffer.concat(this.parts, this.bytes) : undefined;
    this.parts = [];
    this.bytes = this.frameSamples = this.frameEnergy = this.quietFrames = 0;
    this.speech = false;
    if (!pcm) return;
    this.chain = this.chain.then(async () => {
      try {
        if (this.signal.aborted || this.failed) return;
        const text = await this.infer(pcm);
        if (!this.signal.aborted && text) this.publish(text);
      } catch { this.failed = true; }
      finally { pcm.fill(0); }
    });
  }
  async finish(): Promise<void> {
    this.flushSegment();
    await this.chain;
    if (this.failed) throw Error('离线语音转写失败');
  }
}
