'use strict';
const { parentPort } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadBergamot = require('./bergamot.js');

async function initialize() {
  const engine = await new Promise((resolve, reject) => {
    const module = loadBergamot({
      wasmBinary: readFileSync(join(__dirname, 'engine.wasm')),
      INITIAL_MEMORY: 41943040,
      print() {},
      onAbort: () => reject(new Error('离线翻译引擎加载失败')),
      onRuntimeInitialized: () => queueMicrotask(() => resolve(module)),
    });
  });
  function aligned(filename, alignment) {
    const bytes = readFileSync(join(__dirname, filename));
    const buffer = new engine.AlignedMemory(bytes.length, alignment);
    buffer.getByteArrayView().set(bytes);
    return buffer;
  }
  const vocab = new engine.AlignedMemoryList();
  vocab.push_back(aligned('srcvocab.bin', 64));
  vocab.push_back(aligned('trgvocab.bin', 64));
  const config = [
    'beam-size: 1', 'normalize: 1', 'word-penalty: 0', 'max-length-break: 128',
    'mini-batch-words: 1024', 'workspace: 128', 'max-length-factor: 2',
    'skip-cost: true', 'cpu-threads: 0', 'quiet: true', 'quiet-translation: true',
    'gemm-precision: int8shiftAlphaAll', 'alignment: soft',
  ].join('\n') + '\n';
  const model = new engine.TranslationModel('en', 'zh-Hans', config, aligned('model.bin', 256),
    aligned('lex.bin', 64), vocab, null);
  const service = new engine.BlockingService({ cacheSize: 0 });
  return text => {
    const messages = new engine.VectorString();
    const options = new engine.VectorResponseOptions();
    let results;
    // Keep code, paths and URLs byte-for-byte, and batch the intervening English prose.
    const parts = text.split(/(\x60{3}[\s\S]*?\x60{3}|\x60[^\x60\n]+\x60|https?:\/\/[^\s<>]+|(?:[A-Za-z]:[\\/]|\.{0,2}\/)[\w./\\-]+)/g);
    const positions = [];
    try {
      parts.forEach((part, i) => {
        if (i % 2 || !/[a-z]{2}/i.test(part)) return;
        positions.push(i);
        messages.push_back(part.trim());
        options.push_back({ qualityScores: false, alignment: true, html: false });
      });
      if (positions.length) {
        results = service.translate(model, messages, options);
        positions.forEach((position, i) => {
          const response = results.get(i);
          const original = parts[position];
          try { parts[position] = original.match(/^\s*/)[0] + response.getTranslatedText().trim() + original.match(/\s*$/)[0]; }
          finally { response.delete(); }
        });
      }
      return parts.join('');
    } finally { results?.delete(); options.delete(); messages.delete(); }
  };
}
const ready = initialize();
parentPort.on('message', async ({ id, text }) => {
  try { const translate = await ready; parentPort.postMessage({ id, text: translate(text) }); }
  catch (error) { parentPort.postMessage({ id, error: String(error.message || error) }); }
});
