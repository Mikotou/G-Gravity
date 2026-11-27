export async function readBoundedText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return '';
  signal?.throwIfAborted();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        cancel();
        throw new Error('独立模型响应超限');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
