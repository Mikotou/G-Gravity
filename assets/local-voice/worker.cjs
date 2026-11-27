'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const createWhisper = require('./whisper.cjs');

// Apply the published traditional-to-simplified phrase and character mappings only for zh-CN.
async function simplifiedChinese() {
  const names = ['TSCharacters.txt', 'TSPhrases.txt'];
  const dictionaries = await Promise.all(names.map(name => readFile(join(__dirname, name), 'utf8')));
  const entries = new Map();
  let longest = 1;
  for (const dictionary of dictionaries) {
    for (const line of dictionary.split(/\r?\n/)) {
      const [source, alternatives] = line.split('\t');
      if (!alternatives || source.startsWith('#')) continue;
      entries.set(source, alternatives.split(' ')[0]);
      longest = Math.max(longest, Array.from(source).length);
    }
  }
  return text => {
    const chars = Array.from(text);
    let out = '';
    for (let i = 0; i < chars.length;) {
      let size = Math.min(longest, chars.length - i), replacement;
      while (size > 0) {
        replacement = entries.get(chars.slice(i, i + size).join(''));
        if (replacement !== undefined) break;
        size--;
      }
      out += replacement ?? chars[i];
      i += size || 1;
    }
    return out;
  };
}

async function initialize() {
  const wasmBinary = await readFile(join(__dirname, 'whisper.wasm'));
  const runtime = await createWhisper({ wasmBinary, print() {}, printErr() {} });
  const bytes = new Uint8Array(workerData.model);
  const address = runtime._malloc(bytes.length);
  if (!address) throw Error('Model allocation failed');
  let context;
  try {
    runtime.HEAPU8.set(bytes, address);
    context = runtime._voice_init(address, bytes.length);
  } finally { runtime._free(address); }
  if (!context) throw Error('Model initialization failed');
  workerData.model = null;
  const language = workerData.language === 'zh' ? 1 : workerData.language === 'en' ? 2 : 0;
  const script = language === 1 ? await simplifiedChinese() : text => text;
  function recognize(pcm16) {
    const pcm = new Int16Array(pcm16);
    const address = runtime._malloc(pcm.length * 4);
    if (!address) throw Error('Audio allocation failed');
    try {
      const samples = runtime.HEAPF32.subarray(address / 4, address / 4 + pcm.length);
      for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
      const text = runtime._voice_run(context, address, pcm.length, language, 96);
      if (!text) throw Error('Inference failed');
      return script(runtime.UTF8ToString(text).trim());
    } finally { runtime._free(address); }
  }
  if (workerData.pcm16) {
    try { parentPort.postMessage({ text: recognize(workerData.pcm16) }); } finally { runtime._voice_free(context); }
  } else {
    parentPort.on('message', ({ id, pcm16 }) => {
      try { parentPort.postMessage({ id, text: recognize(pcm16) }); }
      catch { parentPort.postMessage({ id, error: '离线语音转写失败' }); }
    });
    parentPort.once('close', () => runtime._voice_free(context));
  }
}
initialize().catch(() => { throw Error('离线语音运行时初始化失败'); });
