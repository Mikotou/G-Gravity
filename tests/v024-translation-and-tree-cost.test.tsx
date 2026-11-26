import React from 'react';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { formatUsd } from '../src/renderer/components/ContextStatusBar';
import { resetDismissedQuestionsCacheForTests } from '../src/renderer/lib/dismissed-questions';
import { CoreService } from '../src/main/core-service';
import { redactSecretsForReviewer } from '../src/main/security/redaction';
import { sanitizeStoredTranslationConfig, type SecretCipher } from '../src/main/services/secret-vault';
import { callIndependentModelWithUsage, IndependentModelCallError } from '../src/main/approval/external-reviewer';
import { ClientStore } from '../src/main/storage/client-store';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { LocalTranslator } from '../src/main/translation/local-translator';
import { translatorCircuit } from '../src/main/llm/external-llm-transport';
import {
  testExternalTranslator,
  translateWithExternalModel,
} from '../src/main/translation/external-translator';
import { findNextSegmentEnd } from '../src/main/translation/thought-segmenter';
import {
  needsModelTranslation,
  STREAM_IDLE_FLUSH_MS,
  ThoughtTranslator,
  type ThoughtTranslateResult,
} from '../src/main/translation/thought-translator';
import {
  computeConversationTreeTotalCost,
  DEFAULT_TRANSLATION_CONFIG,
  EXTERNAL_TRANSLATOR_DEFAULTS,
  isExternalTranslatorConnected,
  type ConversationTreeState,
  type DualTrackThoughtBlock,
  type ExternalTranslatorConfig,
  type ExternalReviewerModelsDiscoveryResult,
  type TelemetryDashboardSnapshot,
} from '../src/shared';
import { createCoreBridge } from './helpers/core-bridge';
import { prepareMockAcp } from './helpers/stdio-rpc';

interface PipelineModule {
  MAX_SENTINELS_PER_SENTENCE: number;
  GLOSSARY_ENTRIES: ReadonlyArray<{ en: string; zh: string; aliases?: readonly string[] }>;
  pickSentinelPrefix(sentence: string, preferredPrefix?: string): string;
  splitSentences(text: string): string[];
  protectSentence(
    sentence: string,
    options?: { maxSentinels?: number; prefix?: string }
  ): {
    text: string;
    masked: string;
    prefix: string;
    placeholders: Array<{
      token: string;
      original: string;
      replacement: string;
      tier: 1 | 2;
      start: number;
      end: number;
    }>;
    allSpans: Array<{
      original: string;
      replacement: string;
      tier: 1 | 2;
      start: number;
      end: number;
    }>;
    overflowTier1: boolean;
  };
  restoreSentence(
    translated: string,
    protectedOrPlaceholders: unknown
  ): {
    ok: boolean;
    text: string;
    missing: string[];
    duplicated: string[];
    unexpected: string[];
  };
  normalizeZhPunctuation(text: string): string;
  tidyZhSpacing(text: string): string;
  translateWithPipeline(text: string, batchTranslateFn: (inputs: string[]) => string[]): string;
}

const require = createRequire(import.meta.url);
const pipeline = require('../assets/local-translation/pipeline.cjs') as PipelineModule;

function createMockSecretCipher(): SecretCipher {
  const prefix = 'GRAVITY_ENC_V024:';
  return {
    isAvailable: () => true,
    encrypt: (plaintext: string) => Buffer.from(`${prefix}${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8'),
    decrypt: (ciphertext: Buffer) => {
      const raw = ciphertext.toString('utf8');
      if (!raw.startsWith(prefix)) throw new Error('invalid ciphertext');
      return Buffer.from(raw.slice(prefix.length), 'base64').toString('utf8');
    },
  };
}

class StubThoughtAcpClient extends EventEmitter {
  private handlers = new Map<string, (params: unknown, id: number) => unknown | Promise<unknown>>();
  options: { args?: string[]; cwd?: string } = { args: ['acp'] };
  connected = true;
  binaryPath = 'agy';
  initializeResult = {
    protocolVersion: 1,
    agentInfo: { name: 'stub-acp-v024', version: '0.2.4' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
  };
  private seq = 0;

  registerRequestHandler(method: string, handler: (params: unknown, id: number) => unknown | Promise<unknown>) {
    this.handlers.set(method, handler);
  }
  async start() {
    this.connected = true;
    return this.initializeResult;
  }
  async stop() {
    this.connected = false;
  }
  async request(method: string, params?: Record<string, unknown>) {
    if (method === 'session/new') {
      const id = `stub-sess-${++this.seq}`;
      return {
        sessionId: id,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        models: {
          currentModelId: 'gemini-4-neon',
          availableModels: [{ modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
        },
      };
    }
    if (method === 'session/load') {
      const sid = String(params?.sessionId || `stub-sess-${++this.seq}`);
      return {
        sessionId: sid,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        models: {
          currentModelId: 'gemini-4-neon',
          availableModels: [{ modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
        },
      };
    }
    if (method === 'session/prompt') {
      return { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 } };
    }
    if (method === 'session/close' || method === 'session/cancel') return {};
    return { ok: true, method, params };
  }
  emitThoughtChunk(sessionId: string, text: string) {
    this.emit('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
    });
  }
  emitMessageChunk(sessionId: string, text: string) {
    this.emit('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
  }
}

function makeJsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ============================================================================
// Area 1: Local Bergamot Pipeline (pipeline.cjs + real 44MB Bergamot WASM)
// ============================================================================
describe('Area 1: Local Bergamot translation pipeline (pipeline.cjs + real 44MB WASM)', () => {
  it('preserves paths and URLs containing Chinese in the shipped offline model', async () => {
    const local = new LocalTranslator();
    try {
      const file = 'C:\\项目\\foo.ts';
      const url = 'https://example.com/文档xyz';
      const result = await local.translate(`Inspect the file in ${file} and read the documentation at ${url}.`);
      expect(result).toContain(file);
      expect(result).toContain(url);
      expect(await local.translate('Inspect the `<source>` element.')).toContain('`<source>`');
    } finally { local.dispose(); }
  });
  it('1.1 XQ00 sentinel assignment, dynamic collision prefix switching, and <=6 cap prioritizing Tier 1 over Tier 2', () => {
    expect(pipeline.MAX_SENTINELS_PER_SENTENCE).toBe(6);

    // Basic XQ00 assignment + non-mangling of sentence-initial normal words (Check / First / Update / APIs)
    const sentence =
      'Check how ThoughtTranslator and CoreService read src/main/core-service.ts with --noEmit before First Update of APIs.';
    const prot = pipeline.protectSentence(sentence);
    expect(prot.prefix).toBe('XQ');
    const originals = prot.placeholders.map((p) => p.original);
    expect(originals).toContain('ThoughtTranslator');
    expect(originals).toContain('CoreService');
    expect(originals).toContain('src/main/core-service.ts');
    expect(originals).toContain('--noEmit');
    expect(originals).not.toContain('Check');
    expect(originals).not.toContain('First');
    expect(originals).not.toContain('Update');
    expect(originals).not.toContain('APIs');
    expect(prot.masked).toContain('XQ00');

    // Dynamic prefix collision switching: XQ -> QK -> VX -> ZK
    expect(pipeline.pickSentinelPrefix('Inspect `foo` right now.')).toBe('XQ');
    expect(pipeline.pickSentinelPrefix('Inspect XQ00 and `foo` right now.')).toBe('QK');
    expect(pipeline.pickSentinelPrefix('Inspect XQ00, QK01 and `foo` right now.')).toBe('VX');
    expect(pipeline.pickSentinelPrefix('Inspect XQ00, QK01, VX02 and `foo` right now.')).toBe('ZK');

    const collisionProt = pipeline.protectSentence('Check XQ00 in `approval-engine.ts` for race condition.');
    expect(collisionProt.prefix).toBe('QK');
    expect(collisionProt.masked).toContain('QK00');
    expect(collisionProt.masked).toContain('XQ00');

    // <= 6 sentinel cap: 5 Tier 1 spans + 3 Tier 2 glossary terms -> all 5 Tier 1 kept, only 1 Tier 2 takes slot #6
    const mixed =
      'Inspect `alpha.ts`, `beta.ts`, screenCommand, run_command, and --noEmit to avoid race condition in worker thread with backticks.';
    const capped = pipeline.protectSentence(mixed);
    expect(capped.placeholders).toHaveLength(6);
    expect(capped.overflowTier1).toBe(false);
    const tier1Count = capped.placeholders.filter((p) => p.tier === 1).length;
    const tier2Count = capped.placeholders.filter((p) => p.tier === 2).length;
    expect(tier1Count).toBe(5);
    expect(tier2Count).toBe(1);
    expect(capped.allSpans.length).toBeGreaterThan(6);

    // > 6 Tier 1 spans flags overflowTier1
    const overflow =
      'Compare `a.ts`, `b.ts`, `c.ts`, `d.ts`, `e.ts`, `f.ts`, and `g.ts` together.';
    const overflowProt = pipeline.protectSentence(overflow);
    expect(overflowProt.overflowTier1).toBe(true);
    expect(overflowProt.placeholders).toHaveLength(6);
  });

  it('1.2 Strict 1:1 sentinel verification + missing/duplicated/unexpected fallback with ZERO XQ00 leakage', () => {
    const prot = pipeline.protectSentence(
      'Inspect `approval-engine.ts` and `screenCommand` for a race condition.'
    );
    expect(prot.placeholders).toHaveLength(3);

    // Missing sentinel
    const missingRes = pipeline.restoreSentence('检查 XQ00 和 XQ02。', prot);
    expect(missingRes.ok).toBe(false);
    expect(missingRes.missing).toEqual(['XQ01']);

    // Duplicated sentinel
    const dupRes = pipeline.restoreSentence('检查 XQ00 与 XQ00 和 XQ01 的 XQ02。', prot);
    expect(dupRes.ok).toBe(false);
    expect(dupRes.duplicated).toEqual(['XQ00']);

    // Unexpected hallucinated sentinel
    const halluRes = pipeline.restoreSentence('检查 XQ00 和 XQ01 以及 XQ02 与 XQ99。', prot);
    expect(halluRes.ok).toBe(false);
    expect(halluRes.unexpected).toEqual(['XQ99']);

    // End-to-end translateWithPipeline when model drops or duplicates sentinels -> clean atomic fallback, zero leak
    const dropModel = (inputs: string[]) =>
      inputs.map((inp) => (inp.includes('XQ00') ? '模型丢掉了哨兵占位符。' : `译(${inp})`));
    const dropOut = pipeline.translateWithPipeline(
      'Inspect `approval-engine.ts` when `screenCommand` handles `run_command` and a race condition.',
      dropModel
    );
    expect(dropOut).toContain('`approval-engine.ts`');
    expect(dropOut).toContain('`screenCommand`');
    expect(dropOut).toContain('`run_command`');
    expect(dropOut).toContain('竞态条件');
    expect(dropOut).not.toMatch(/[A-Z]{2}\d{2}/);

    const dupModel = (inputs: string[]) =>
      inputs.map((inp) => (inp.includes('XQ00') ? '重复 XQ00 与 XQ00。' : `译(${inp})`));
    const dupOut = pipeline.translateWithPipeline(
      'Check `package.json` and `worker.cjs` for worker thread backticks.',
      dupModel
    );
    expect(dupOut).toContain('`package.json`');
    expect(dupOut).toContain('`worker.cjs`');
    expect(dupOut).toContain('工作线程');
    expect(dupOut).toContain('反引号');
    expect(dupOut).not.toMatch(/[A-Z]{2}\d{2}/);
  });

  it('1.3 Markdown structure, fenced code blocks, unquoted paths/identifiers, smart sentence split, and CJK punctuation/spacing', () => {
    // Smart sentence splitting skips abbreviations, versions, decimals, ellipsis, file extensions, list markers, backticks
    const tricky =
      '1. Check e.g. package.json and i.e. v0.2.3 with ratio 3.14 and `foo.bar()`... Still same sentence. Second sentence here!';
    const sents = pipeline.splitSentences(tricky);
    expect(sents).toHaveLength(2);
    expect(sents[0]).toContain('v0.2.3');
    expect(sents[0]).toContain('3.14');
    expect(sents[1]).toBe('Second sentence here!');

    // Markdown fenced code block + line prefixes + bold wrappers + unquoted paths/identifiers
    const mdInput = [
      '## Plan for `CoreService`',
      '',
      '- [x] **Step 1:** Check src/main/core-service.ts, package.json, SKILL.md, screenCommand, run_command, STREAM_IDLE_FLUSH_MS, @verifier, and --noEmit.',
      '> **Inspecting the worker thread**',
      '```ts',
      'const raceCondition = "do not translate backticks or regex inside code fence";',
      '```',
    ].join('\n');

    const stubTranslator = (inputs: string[]) => inputs.map((s) => `已处理 ${s}`);
    const mdOut = pipeline.translateWithPipeline(mdInput, stubTranslator);
    const outLines = mdOut.split('\n');
    expect(outLines[0].startsWith('## ')).toBe(true);
    expect(outLines[0]).toContain('`CoreService`');
    expect(outLines[1]).toBe('');
    expect(outLines[2].startsWith('- [x] **')).toBe(true);
    expect(outLines[2]).toContain('src/main/core-service.ts');
    expect(outLines[2]).toContain('package.json');
    expect(outLines[2]).toContain('SKILL.md');
    expect(outLines[2]).toContain('screenCommand');
    expect(outLines[2]).toContain('run_command');
    expect(outLines[2]).toContain('STREAM_IDLE_FLUSH_MS');
    expect(outLines[2]).toContain('@verifier');
    expect(outLines[2]).toContain('--noEmit');
    expect(outLines[3].startsWith('> **')).toBe(true);
    expect(outLines[3]).toContain('工作线程');
    expect(outLines[4]).toBe('```ts');
    expect(outLines[5]).toBe('const raceCondition = "do not translate backticks or regex inside code fence";');
    expect(outLines[6]).toBe('```');

    // CJK punctuation normalization & spacing preserves URLs, Windows paths, times, numbers, and inline code
    const punctRaw =
      '检查中文,然后看 `a, b: c` 和 https://generativelanguage.googleapis.com:443/v1 以及 C:\\temp\\a.ts 在 12:30 共 1,000 条;对吗?好!';
    const punctNorm = pipeline.tidyZhSpacing(pipeline.normalizeZhPunctuation(punctRaw));
    expect(punctNorm).toContain('检查中文，然后看 `a, b: c`');
    expect(punctNorm).toContain('https://generativelanguage.googleapis.com:443/v1');
    expect(punctNorm).toContain('C:\\temp\\a.ts');
    expect(punctNorm).toContain('12:30');
    expect(punctNorm).toContain('1,000');
    expect(punctNorm).toContain('；对吗？好！');
  });

  it('1.4 REAL 44MB Bergamot WASM (LocalTranslator) quality assertions on real coding thoughts', async () => {
    const translator = new LocalTranslator();
    try {
      const out1 = await translator.translate(
        "Let's inspect `approval-engine.ts` to see how `screenCommand` handles `run_command` before we update the cache."
      );
      expect(out1).toContain('`approval-engine.ts`');
      expect(out1).toContain('`screenCommand`');
      expect(out1).toContain('`run_command`');
      expect(out1).toContain('处理');
      expect(out1).not.toContain('手柄');
      expect(out1).not.toContain('XQ0');
      expect(out1).not.toMatch(/[A-Z]{2}\d{2}/);

      const out2 = await translator.translate(
        'This causes a race condition in the worker thread when backticks break the regex.'
      );
      expect(out2).toContain('竞态条件');
      expect(out2).toContain('工作线程');
      expect(out2).toContain('反引号');
      expect(out2).toContain('正则表达式');
      expect(out2).not.toContain('种族状况');
      expect(out2).not.toContain('工人线程');
      expect(out2).not.toContain('背踞');
      expect(out2).not.toContain('低音');
      expect(out2).not.toContain('XQ0');
      expect(out2).not.toMatch(/[A-Z]{2}\d{2}/);
    } finally {
      translator.dispose();
    }
  }, 30000);
});

// ============================================================================
// Area 2: ThoughtTranslator streaming & two-stage refine
// ============================================================================
describe('Area 2: ThoughtTranslator smart segmentation, two-stage refine, epoch guard, and translationSource', () => {
  it('保留代码字面标签，空闲时等待未闭合的代码，纯代码块不调用翻译', async () => {
    vi.useFakeTimers();
    const code = ['~~~js', 'const count = ready;', '~~~'].join('\n');
    expect(needsModelTranslation(code)).toBe(false);
    expect(needsModelTranslation('``some `code` here``')).toBe(false);
    const translate = vi.fn(async () => '检查 `<source>` 元素。');
    const translator = new ThoughtTranslator(translate);
    let latest: DualTrackThoughtBlock | undefined;
    translator.on('block', block => { latest = block; });
    translator.append('tags', 'Inspect the `<sou');
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_FLUSH_MS + 1);
    expect(translate).not.toHaveBeenCalled();
    translator.append('tags', 'rce>` element. ');
    translator.complete('tags');
    await vi.advanceTimersByTimeAsync(0);
    expect(latest!.translatedZhText).toContain('`<source>`');
    translate.mockClear();
    translator.append('code', '~~~js\nconst count = ');
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_FLUSH_MS + 1);
    translator.append('code', 'ready;\n~~~');
    expect(translator.complete('code')!.translatedZhText).toBe(code);
    expect(translate).not.toHaveBeenCalled();
    translator.dispose();
  });
  it('cancels dispatched work when a thought reopens or is cleared', () => {
    const signals: AbortSignal[] = [];
    const thoughts = new ThoughtTranslator((_text, _id, signal) => new Promise(() => { signals.push(signal!); }));
    thoughts.append('one', 'Check the complete sentence. ');
    thoughts.complete('one');
    thoughts.append('one', 'More text. ');
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    thoughts.clear('one');
    expect(signals[1].aborted).toBe(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('2.1 Smart sentence boundary skips e.g./i.e./v0.2.3/1. and does not cut 120-char sentence prematurely', () => {
    expect(STREAM_IDLE_FLUSH_MS).toBe(900);

    // Abbreviations & versions & ordered list markers must not cut prematurely
    expect(findNextSegmentEnd('Check e.g. the cache and i.e. v0.2.3 right now', 0, false)).toBeNull();
    expect(findNextSegmentEnd('1. Inspecting the config handler without period', 0, false)).toBeNull();
    // Leading whitespace peels off as prefix (offset 10), then indented "12. ..." does NOT cut on "12."
    expect(findNextSegmentEnd('          12. Indented list item still streaming', 0, false)).toBe(10);
    expect(findNextSegmentEnd('          12. Indented list item still streaming', 10, false)).toBeNull();
    expect(findNextSegmentEnd('The value 3.14 in approval-engine.ts is still streaming', 0, false)).toBeNull();

    // 120-character sentence without sentence punctuation must NOT cut (old 96-char cut removed; threshold is 280)
    const len120 =
      'Checking the streaming translation buffer carefully so a normal hundred twenty character thought sentence stays intact here';
    expect(len120.length).toBeGreaterThanOrEqual(115);
    expect(len120.length).toBeLessThan(200);
    expect(findNextSegmentEnd(len120, 0, false)).toBeNull();

    // Real sentence boundary cuts cleanly after trailing space
    const twoSents = 'We inspected the cache handler. Next we update telemetry';
    const cut = findNextSegmentEnd(twoSents, 0, false);
    expect(cut).toBe('We inspected the cache handler. '.length);

    // Emergency cut triggers once >= 280 chars
    const longNoPunct = `${'analyzing streaming token buffer '.repeat(9)}tail`;
    expect(longNoPunct.length).toBeGreaterThanOrEqual(280);
    const emergencyCut = findNextSegmentEnd(longNoPunct, 0, false);
    expect(emergencyCut).not.toBeNull();
    expect(emergencyCut!).toBeGreaterThanOrEqual(160);
    expect(emergencyCut!).toBeLessThanOrEqual(300);
  });

  it('2.2 Fragmented paragraph triggers ONE whole-paragraph refine on \\n or complete(); single-pass paragraph does NOT re-translate', async () => {
    const calls: string[] = [];
    const translator = new ThoughtTranslator(async (text): Promise<ThoughtTranslateResult> => {
      calls.push(text);
      if (text.includes('First sentence.') && text.includes('Second sentence.')) {
        return { text: '【整段精修】第一句与第二句流畅合并。', source: 'external-api' };
      }
      if (text.includes('First sentence.')) {
        return { text: '第一句预览。', source: 'external-api' };
      }
      if (text.includes('Second sentence.')) {
        return { text: '第二句预览。', source: 'external-api' };
      }
      return { text: `单段直译:${text}`, source: 'local-model' };
    });

    const blocks: DualTrackThoughtBlock[] = [];
    translator.on('block', (b: DualTrackThoughtBlock) => blocks.push(b));

    // Fragmented paragraph closed by \n: piece 1 cuts at sentence end, piece 2 closes with \n -> triggers 1 refine
    translator.append('t-frag-nl', 'First sentence. ');
    await waitFor(() => expect(calls).toHaveLength(1));

    translator.append('t-frag-nl', 'Second sentence.\n');
    await waitFor(() => {
      const latest = blocks.at(-1)!;
      expect(latest.translatedZhText).toBe('【整段精修】第一句与第二句流畅合并。\n');
      expect(latest.translationSource).toBe('external-api');
      expect(latest.isTranslating).toBe(false);
    });
    expect(calls).toEqual([
      'First sentence.',
      'Second sentence.',
      'First sentence. Second sentence.',
    ]);

    // Fragmented paragraph without \n closed by complete() -> triggers 1 refine
    calls.length = 0;
    const blocks2: DualTrackThoughtBlock[] = [];
    const translator2 = new ThoughtTranslator(async (text): Promise<ThoughtTranslateResult> => {
      calls.push(text);
      if (text.includes('Alpha clause.') && text.includes('Beta ending')) {
        return { text: '【完成精修】甲乙完整译文。', source: 'local-model' };
      }
      return { text: `片段:${text}`, source: 'local-model' };
    });
    translator2.on('block', (b: DualTrackThoughtBlock) => blocks2.push(b));

    translator2.append('t-frag-complete', 'Alpha clause. ');
    await waitFor(() => expect(calls).toHaveLength(1));
    translator2.append('t-frag-complete', 'Beta ending');
    translator2.complete('t-frag-complete');

    await waitFor(() => {
      const latest = blocks2.at(-1)!;
      expect(latest.translatedZhText).toBe('【完成精修】甲乙完整译文。');
      expect(latest.translationSource).toBe('local-model');
      expect(latest.isTranslating).toBe(false);
    });
    expect(calls).toEqual([
      'Alpha clause.',
      'Beta ending',
      'Alpha clause. Beta ending',
    ]);

    // Unfragmented single-pass paragraph must NEVER be re-translated on \n or complete()
    calls.length = 0;
    const translator3 = new ThoughtTranslator(async (text) => {
      calls.push(text);
      return `一次译文:${text}`;
    });
    translator3.append('t-single', 'Single complete sentence in one pass.\n');
    await waitFor(() => expect(calls).toHaveLength(1));
    translator3.complete('t-single');
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toHaveLength(1);

    translator.dispose();
    translator2.dispose();
    translator3.dispose();
  });

  it('2.3 Epoch guard drops stale whole-paragraph refine callbacks after reopen or clear', async () => {
    let resolveStaleRefine!: (val: ThoughtTranslateResult) => void;
    let refineCallCount = 0;
    const translator = new ThoughtTranslator(async (text): Promise<ThoughtTranslateResult> => {
      if (text.includes('Part one.') && text.includes('Part two') && !text.includes('Part three')) {
        refineCallCount++;
        return new Promise((resolve) => {
          resolveStaleRefine = resolve;
        });
      }
      if (text.includes('Part three')) {
        return { text: '最新整段译文（含第三部分）', source: 'external-api' };
      }
      return { text: `初译(${text})`, source: 'external-api' };
    });

    const blocks: DualTrackThoughtBlock[] = [];
    translator.on('block', (b: DualTrackThoughtBlock) => blocks.push(b));

    translator.append('t-epoch', 'Part one. ');
    await waitFor(() => expect(blocks.some((b) => b.translatedZhText.includes('初译(Part one.)'))).toBe(true));

    translator.append('t-epoch', 'Part two');
    translator.complete('t-epoch');
    await waitFor(() => expect(refineCallCount).toBe(1));

    // Reopen block (increments epoch) before stale refine resolves
    translator.append('t-epoch', ' Part three.');
    translator.complete('t-epoch');
    await waitFor(() => {
      const latest = blocks.at(-1)!;
      expect(latest.translatedZhText).toContain('最新整段译文（含第三部分）');
      expect(latest.isTranslating).toBe(false);
    });

    const textBeforeStale = blocks.at(-1)!.translatedZhText;
    // Resolve stale refine from old epoch — must be completely ignored!
    resolveStaleRefine({ text: '过期精修绝对不能覆写！', source: 'local-model' });
    await new Promise((r) => setTimeout(r, 30));

    expect(blocks.at(-1)!.translatedZhText).toBe(textBeforeStale);
    expect(blocks.at(-1)!.translatedZhText).not.toContain('过期精修');
    expect(blocks.at(-1)!.translationSource).toBe('external-api');

    translator.dispose();
  });
});

// ============================================================================
// Area 3: Independent External Translation API + Encrypted Persistence in CoreService
// ============================================================================
describe('Area 3: Independent External Translation API, encrypted persistence, fallback, and compliance', () => {
  const dirs: string[] = [];
  const services: CoreService[] = [];

  afterEach(async () => {
    for (const s of services.splice(0)) await s.dispose();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeDir(prefix: string): string {
    const d = mkdtempSync(path.join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  it('翻译示例核对原句含义，明确拒答、过滤和截断不算完成且保留已报告用量', async () => {
    const cfg: ExternalTranslatorConfig = { ...DEFAULT_TRANSLATION_CONFIG.externalTranslator, enabled: true,
      provider: 'openai-compatible', model: 'fixture', endpoint: 'http://127.0.0.1:42031' };
    const response = (content: string, finish_reason: string, refusal?: string) => async () => makeJsonResponse({
      choices: [{ finish_reason, message: { content, refusal } }], usage: { prompt_tokens: 4, completion_tokens: 6 },
    });
    for (const fetcher of [response('很抱歉，我不能提供译文。', 'stop'), response('无关的中文句子。', 'stop'),
        response('正在检查配置文件。', 'content_filter'), response('正在检查配置文件。', 'stop', 'refused')]) {
      expect(await testExternalTranslator(cfg, fetcher)).toMatchObject({ ok: false, usage: { outputTokens: 6 } });
    }
    expect(await testExternalTranslator(cfg, response('正在核对设置文件。', 'stop'))).toMatchObject({ ok: true });
    const decision = JSON.stringify({ recommended: 'approve', reason: '样例', riskLevel: 'low' });
    for (const fetcher of [response(decision, 'length'), response(decision, 'content_filter'), response(decision, 'stop', 'refused')]) {
      await expect(callIndependentModelWithUsage(cfg, 'sample', 'sample', fetcher)).rejects.toMatchObject({ usage: { outputTokens: 6 } });
    }
  });
  it('模型枚举和界面传来的已连接标志都无法启用，改模型需要重测，旧配置保留字段', async () => {
    const chosen: ExternalTranslatorConfig = { ...DEFAULT_TRANSLATION_CONFIG.externalTranslator, provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434', model: 'fixture', enabled: true, connectionStatus: 'connected', lastVerifiedAt: 'legacy' };
    expect(sanitizeStoredTranslationConfig({ engine: 'external-api', externalTranslator: chosen })).toMatchObject({
      engine: 'local', externalTranslator: { model: 'fixture', enabled: false, connectionStatus: 'untested' },
    });
    const answer = vi.fn(async () => ({ text: '正在检查配置文件。', latencyMs: 1 }));
    const core = new CoreService({ dataDir: makeDir('gravity-translator-proof-'), acp: new StubThoughtAcpClient() as never, externalTranslator: answer });
    services.push(core);
    await expect(core.updateTranslationConfig({ engine: 'external-api', externalTranslator: { ...chosen, verifiedBy: 'translation-call' } })).rejects.toThrow(/测试/);
    expect((await core.testExternalTranslatorConnection(chosen)).ok).toBe(true);
    await expect(core.updateTranslationConfig({ engine: 'external-api', externalTranslator: { ...chosen, model: 'another' } })).rejects.toThrow(/测试/);
    await core.updateTranslationConfig({ engine: 'external-api', externalTranslator: chosen });
    answer.mockResolvedValueOnce({ text: 'no translation', latencyMs: 1 });
    expect((await core.testExternalTranslatorConnection(chosen)).ok).toBe(false);
    expect(await core.getTranslationConfig()).toMatchObject({ engine: 'local', externalTranslator: { enabled: false } });
    expect(core.telemetry.snapshot().externalTranslator?.cumulativeAllTime.callCount ?? 0).toBe(0);
  });
  it('外部与本地翻译都失败时只计一次错误并保留原文', async () => {
    const acp = new StubThoughtAcpClient();
    const external = vi.fn(async () => ({ text: '正在检查配置文件。', latencyMs: 1 }));
    const core = new CoreService({ dataDir: makeDir('gravity-double-translation-error-'), acp: acp as never, externalTranslator: external });
    services.push(core);
    const chosen: ExternalTranslatorConfig = { ...DEFAULT_TRANSLATION_CONFIG.externalTranslator, provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434', model: 'fixture', enabled: true };
    expect((await core.testExternalTranslatorConnection(chosen)).ok).toBe(true);
    await core.updateTranslationConfig({ engine: 'external-api', externalTranslator: chosen });
    external.mockRejectedValueOnce(new Error('external failed'));
    vi.spyOn(LocalTranslator.prototype, 'translate').mockRejectedValueOnce(new Error('local failed'));
    const session = await core.createSession({ cwd: process.cwd() });
    acp.emitThoughtChunk(session.sessionId, 'Check the configuration file. ');
    acp.emitMessageChunk(session.sessionId, 'done');
    await waitFor(() => expect(core.telemetry.snapshot().externalTranslator?.cumulativeAllTime).toMatchObject({callCount: 1, errorCount: 1, fallbackCount: 0}));
    expect((await core.getSessionMessagePage(session.sessionId)).messages[0].thoughts?.[0].originalText).toContain('Check the configuration file.');
  });
  it('keeps billed usage on truncated nonempty translations and never counts a cooldown as a network call', async () => {
    const cfg: ExternalTranslatorConfig = { ...DEFAULT_TRANSLATION_CONFIG.externalTranslator, provider: 'openai-compatible', endpoint: 'http://127.0.0.1:49819', enabled: true };
    await expect(translateWithExternalModel('original', cfg, async () => makeJsonResponse({
      choices: [{ finish_reason: 'length', message: { content: '一部分' } }], usage: { completion_tokens: 9 },
    }))).rejects.toMatchObject({ usage: { outputTokens: 9 } });
    const fetcher = vi.fn(async () => makeJsonResponse({}, 429))
      .mockResolvedValueOnce(makeJsonResponse({ choices: [{ message: { content: '配置文件已检查。' } }] }));
    const acp = new StubThoughtAcpClient();
    const svc = new CoreService({ dataDir: makeDir('gravity-translation-cooldown-'), acp: acp as never, modelDiscoveryFetcher: fetcher });
    services.push(svc);
    try {
      expect((await svc.testExternalTranslatorConnection(cfg)).ok).toBe(true);
      fetcher.mockClear();
      await svc.updateTranslationConfig({ engine: 'external-api', externalTranslator: cfg });
      const session = await svc.createSession({ cwd: process.cwd() });
      acp.emitThoughtChunk(session.sessionId, 'Check the first sentence. ');
      await waitFor(() => expect(svc.telemetry.snapshot().externalTranslator?.cumulativeAllTime.fallbackCount).toBe(1), { timeout: 8000 });
      acp.emitThoughtChunk(session.sessionId, 'Read the second sentence. ');
      acp.emitMessageChunk(session.sessionId, 'done');
      await waitFor(async () => {
        const block = (await svc.getSessionMessagePage(session.sessionId)).messages[0].thoughts?.[0];
        expect(block?.translationSource).toBe('local-model');
        expect(block?.isTranslating).toBe(false);
      }, { timeout: 8000 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(svc.telemetry.snapshot().externalTranslator?.cumulativeAllTime.callCount).toBe(1);
    } finally { translatorCircuit.reset(cfg.endpoint); }
  });

  it('accounts for spontaneous replies and estimates replayed history without inventing another paid turn', async () => {
    const acp = new StubThoughtAcpClient();
    const svc = new CoreService({ dataDir: makeDir('gravity-unprompted-usage-'), acp: acp as never });
    services.push(svc);
    const session = await svc.createSession({ cwd: process.cwd() });
    acp.emitMessageChunk(session.sessionId, 'background work finished');
    acp.emit('session/update', { sessionId: session.sessionId, update: { sessionUpdate: 'usage_update', usage: { inputTokens: 30, outputTokens: 12 } } });
    expect(svc.telemetry.getSessionTelemetry(session.sessionId)?.costSummary.totalTokens).toBe(42);
    await waitFor(() => expect(svc.sessions.get(session.sessionId).status).toBe('idle'));
    await svc.closeSession(session.sessionId);
    const history = await svc.createSession({ cwd: process.cwd() });
    await svc.closeSession(history.sessionId);
    const original = acp.request.bind(acp);
    vi.spyOn(acp, 'request').mockImplementation(async (method, params) => {
      if (method === 'session/load') {
        acp.emit('session/update', { sessionId: history.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old user' } } });
        acp.emitMessageChunk(history.sessionId, 'old text');
      }
      return original(method, params);
    });
    await svc.resumeSession(history.sessionId, process.cwd());
    expect(svc.telemetry.getSessionTelemetry(history.sessionId)?.costSummary.totalTokens).toBe(4);
    expect(svc.telemetry.snapshot().costByRange.today.totalTokens).toBe(42);
  });

  it('failed and cancelled compact commands do not manufacture a compression record', async () => {
    const acp = new StubThoughtAcpClient();
    const svc = new CoreService({ dataDir: makeDir('gravity-compact-failed-'), acp: acp as never });
    services.push(svc);
    const session = await svc.createSession({ cwd: process.cwd() });
    svc.telemetry.addChunk(session.sessionId, 'existing content'.repeat(50));
    const before = svc.telemetry.getSessionTelemetry(session.sessionId)!.usedContextTokens;
    vi.spyOn(acp, 'request').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ stopReason: 'cancelled' } as never);
    await expect(svc.sendPrompt({ sessionId: session.sessionId, text: '/compact' })).rejects.toThrow('offline');
    await svc.sendPrompt({ sessionId: session.sessionId, text: '/compact' });
    const after = svc.telemetry.getSessionTelemetry(session.sessionId)!;
    expect(after.compactions).toEqual([]);
    expect(after.usedContextTokens).toBeGreaterThanOrEqual(before);
  });

  it('does not restore another origin’s keys when switching while system encryption is unavailable', async () => {
    const dataDir = makeDir('gravity-key-origins-');
    const cipher = createMockSecretCipher();
    const svc = new CoreService({ dataDir, secretCipher: cipher, acp: new StubThoughtAcpClient() as never });
    services.push(svc);
    const service: ExternalTranslatorConfig = {
      ...DEFAULT_TRANSLATION_CONFIG.externalTranslator, enabled: true, provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:48730', model: 'fixture', apiKey: 'synthetic-key',
    };
    await svc.updateTranslationConfig({ externalTranslator: service });
    await svc.updateApprovalConfig({ externalReviewer: { ...service, enabled: false } });
    cipher.isAvailable = () => false;
    const changed = { ...service, endpoint: 'http://127.0.0.1:48731', apiKey: undefined };
    expect((await svc.updateTranslationConfig({ externalTranslator: changed })).externalTranslator.apiKey).toBeFalsy();
    expect((await svc.updateApprovalConfig({ externalReviewer: { ...changed, enabled: false } })).externalReviewer.apiKey).toBeFalsy();
    await svc.dispose();
    services.pop();
    cipher.isAvailable = () => true;
    const reopened = new CoreService({ dataDir, secretCipher: cipher, acp: new StubThoughtAcpClient() as never });
    services.push(reopened);
    expect((await reopened.getTranslationConfig()).externalTranslator.apiKey).toBeFalsy();
    expect(reopened.approval.getConfig().externalReviewer.apiKey).toBeFalsy();
  });

  it('3.1 Independent provider/model/key from external reviewer, encrypted translator-secret.enc, zero plaintext JSON, .bak backup, and cold restart recovery', async () => {
    const dataDir = makeDir('gravity-v024-persist-');
    const cipher = createMockSecretCipher();
    const acp = new StubThoughtAcpClient();

    const core1 = new CoreService({
      dataDir,
      acp: acp as never,
      externalTranslator: async () => ({ text: '已检查配置。', latencyMs: 1 }),
      reviewer: async () => ({ recommended: 'approve', riskLevel: 'low', reason: 'Test review', latencyMs: 1 }),
      secretCipher: cipher,
    });
    services.push(core1);

    // Default engine must be 'local'
    const initialCfg = await core1.getTranslationConfig();
    expect(initialCfg.engine).toBe('local');
    expect(DEFAULT_TRANSLATION_CONFIG.engine).toBe('local');
    expect(initialCfg.externalTranslator.enabled).toBe(false);
    expect(initialCfg.externalTranslator.model).toBe(EXTERNAL_TRANSLATOR_DEFAULTS.model);
    expect(initialCfg.externalTranslator.thinkingLevel).toBe('off');
    expect(initialCfg.externalTranslator.timeoutMs).toBe(8000);
    expect(initialCfg.externalTranslator.maxOutputTokens).toBe(2048);

    // Configure External Reviewer with Google AI Studio (Gemini)
    const reviewerKey = 'AIzaSyReviewerSecretOnly1234567890';
    const reviewerConfig = {
        enabled: true,
        provider: 'gemini-api-key' as const,
        endpoint: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash-lite',
        apiKey: reviewerKey,
        thinkingLevel: 'low' as const,
        maxOutputTokens: 4096,
        timeoutMs: 8000,
    };
    expect((await core1.testExternalReviewerConnection(reviewerConfig)).ok).toBe(true);
    await core1.updateApprovalConfig({ mode: 'hybrid', externalReviewer: reviewerConfig });

    // Configure External Translator with completely different provider: OpenAI-Compatible (gpt-4o-mini)
    const translatorKey = 'sk-proj-TranslatorOnlySecret9876543210';
    const chosen: ExternalTranslatorConfig = {
        enabled: true,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: translatorKey,
        thinkingLevel: 'off',
        maxOutputTokens: 2048,
        timeoutMs: 6500,
        connectionStatus: 'connected',
    };
    expect((await core1.testExternalTranslatorConnection(chosen)).ok).toBe(true);
    const updated1 = await core1.updateTranslationConfig({ engine: 'external-api', externalTranslator: chosen });
    expect(updated1.engine).toBe('external-api');
    expect(updated1.externalTranslator.provider).toBe('openai-compatible');
    // D4：公开配置投影严禁明文回传 apiKey，仅暴露 hasApiKey: true
    expect(updated1.externalTranslator.apiKey).toBeUndefined();
    expect(updated1.externalTranslator.hasApiKey).toBe(true);

    expect((await core1.testExternalTranslatorConnection({ timeoutMs: 7000 })).ok).toBe(true);
    // Trigger a second write so .bak shadow backup is created for translation-config.json
    await core1.updateTranslationConfig({
      externalTranslator: { timeoutMs: 7000 },
    });

    // Verify independent files on disk & ZERO plaintext secrets in JSON
    const transJsonPath = path.join(dataDir, 'translation-config.json');
    const transBakPath = path.join(dataDir, 'translation-config.json.bak');
    const transEncPath = path.join(dataDir, 'translator-secret.enc');
    const revJsonPath = path.join(dataDir, 'approval-config.json');
    const revEncPath = path.join(dataDir, 'reviewer-secret.enc');

    expect(existsSync(transJsonPath)).toBe(true);
    expect(existsSync(transBakPath)).toBe(true);
    expect(existsSync(transEncPath)).toBe(true);
    expect(existsSync(revJsonPath)).toBe(true);
    expect(existsSync(revEncPath)).toBe(true);

    const transJsonRaw = readFileSync(transJsonPath, 'utf8');
    const revJsonRaw = readFileSync(revJsonPath, 'utf8');
    expect(transJsonRaw).not.toContain(translatorKey);
    expect(transJsonRaw).not.toContain(reviewerKey);
    expect(transJsonRaw).not.toContain('"apiKey"');
    expect(revJsonRaw).not.toContain(reviewerKey);
    expect(revJsonRaw).not.toContain(translatorKey);
    expect(revJsonRaw).not.toContain('"apiKey"');

    // Ciphertext files must be encrypted (not raw plaintext) and distinct
    const transEncRaw = readFileSync(transEncPath, 'utf8');
    const revEncRaw = readFileSync(revEncPath, 'utf8');
    expect(transEncRaw).not.toContain(translatorKey);
    expect(revEncRaw).not.toContain(reviewerKey);
    expect(transEncRaw).not.toBe(revEncRaw);

    // Verify zero cross-interference between Reviewer and Translator configs
    expect(core1.approval.getConfig().externalReviewer.provider).toBe('gemini-api-key');
    expect(core1.approval.getConfig().externalReviewer.apiKey).toBe(reviewerKey);

    // Dispose and simulate cold restart / cross-version upgrade on the same dataDir
    await core1.dispose();
    services.pop();

    let restoredRuntimeKey: string | undefined;
    const core2 = new CoreService({
      dataDir,
      acp: new StubThoughtAcpClient() as never,
      externalTranslator: async (_text, cfg) => {
        restoredRuntimeKey = cfg.apiKey;
        return { text: '已检查配置。', latencyMs: 1 };
      },
      secretCipher: cipher,
    });
    services.push(core2);

    const restoredTrans = await core2.getTranslationConfig();
    expect(restoredTrans.engine).toBe('external-api');
    expect(restoredTrans.externalTranslator.enabled).toBe(true);
    expect(restoredTrans.externalTranslator.provider).toBe('openai-compatible');
    expect(restoredTrans.externalTranslator.endpoint).toBe('https://api.openai.com');
    expect(restoredTrans.externalTranslator.model).toBe('gpt-4o-mini');
    expect(restoredTrans.externalTranslator.timeoutMs).toBe(7000);
    // D4：冷重启后公开 getter 仅投影 hasApiKey，不暴露明文；同源测连由主进程内部解密复用
    expect(restoredTrans.externalTranslator.apiKey).toBeUndefined();
    expect(restoredTrans.externalTranslator.hasApiKey).toBe(true);
    expect((await core2.testExternalTranslatorConnection({ timeoutMs: 7000 })).ok).toBe(true);
    expect(restoredRuntimeKey).toBe(translatorKey);

    const restoredRev = core2.approval.getConfig();
    expect(restoredRev.externalReviewer.provider).toBe('gemini-api-key');
    expect(restoredRev.externalReviewer.apiKey).toBe(reviewerKey);

    // If secretCipher is unavailable on restart, engine safely degrades to 'local' while keeping all filled fields
    const coreNoKey = new CoreService({
      dataDir,
      acp: new StubThoughtAcpClient() as never,
    });
    services.push(coreNoKey);
    const degraded = await coreNoKey.getTranslationConfig();
    expect(degraded.engine).toBe('local');
    expect(degraded.externalTranslator.enabled).toBe(false);
    expect(degraded.externalTranslator.provider).toBe('openai-compatible');
    expect(degraded.externalTranslator.model).toBe('gpt-4o-mini');
    expect(degraded.externalTranslator.timeoutMs).toBe(7000);

    // sanitizeStoredTranslationConfig direct check
    const sanitized = sanitizeStoredTranslationConfig(
      {
        engine: 'external-api',
        externalTranslator: {
          enabled: true,
          provider: 'gemini-api-key',
          endpoint: 'https://generativelanguage.googleapis.com',
          model: 'gemini-2.5-flash-lite',
        },
      },
      undefined
    );
    expect(sanitized.engine).toBe('local');
    expect(sanitized.externalTranslator.model).toBe('gemini-2.5-flash-lite');
  });

  it('3.2 Secret redaction before external translation call, translationSource=external-api, zero SwarmTracker workers, and cross-provider key isolation', async () => {
    const dataDir = makeDir('gravity-v024-redact-');
    const cipher = createMockSecretCipher();
    const acp = new StubThoughtAcpClient();
    const seenInputs: Array<{ text: string; config: ExternalTranslatorConfig }> = [];

    const core = new CoreService({
      dataDir,
      acp: acp as never,
      secretCipher: cipher,
      externalTranslator: async (text, cfg) => {
        seenInputs.push({ text, config: cfg });
        return {
          text: '正在检查配置文件并脱敏密钥。',
          latencyMs: 42,
          usage: {
            inputTokens: 80,
            cachedInputTokens: 10,
            outputTokens: 18,
            thinkingTokens: 0,
            totalTokens: 108,
            providerReported: true,
          },
        };
      },
    });
    services.push(core);

    const savedOpenAiKey = 'sk-proj-OpenAiTranslatorSecretKey999999';
    const chosen: ExternalTranslatorConfig = {
        enabled: true,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: savedOpenAiKey,
        thinkingLevel: 'off',
        timeoutMs: 8000,
        connectionStatus: 'connected',
    };
    expect((await core.testExternalTranslatorConnection(chosen)).ok).toBe(true);
    await core.updateTranslationConfig({ engine: 'external-api', externalTranslator: chosen });

    seenInputs.length = 0;
    // Cross-provider test call without apiKey MUST NOT leak saved OpenAI key to Gemini
    const crossTest = await core.testExternalTranslatorConnection({
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
    });
    expect(crossTest.ok).toBe(false);
    expect(seenInputs).toHaveLength(0);

    // Create session & emit thought containing sensitive keys
    const session = await core.createSession({ cwd: 'C:\\Workspace\\DemoApp', title: 'External Translation Redaction' });
    const rawSecretThought =
      'Inspecting credentials sk-proj-LeakMeSecretToken1234567890abcdef and AIzaSyLeakMeGeminiKey1234567890abcdefg right now.\n';
    expect(redactSecretsForReviewer(rawSecretThought)).not.toContain('sk-proj-LeakMeSecretToken');
    expect(redactSecretsForReviewer(rawSecretThought)).not.toContain('AIzaSyLeakMeGeminiKey');

    acp.emitThoughtChunk(session.sessionId, rawSecretThought);
    await waitFor(() => expect(seenInputs.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });

    // Secrets MUST be redacted before leaving the process to external translator
    expect(seenInputs[0].text).not.toContain('sk-proj-LeakMeSecretToken');
    expect(seenInputs[0].text).not.toContain('AIzaSyLeakMeGeminiKey');
    expect(seenInputs[0].text).toContain('REDACTED');

    // Resulting DualTrackThoughtBlock reflects 'external-api'
    await waitFor(async () => {
      const msgs = (await core.getSessionMessagePage(session.sessionId)).messages;
      const thought = msgs.find((m) => m.role === 'assistant')?.thoughts?.[0];
      expect(thought?.translationSource).toBe('external-api');
      expect(thought?.translatedZhText).toContain('正在检查配置文件并脱敏密钥。');
    });

    // Telemetry recorded external translation success under session
    const snap = await core.getTelemetryDashboard();
    expect(snap.externalTranslator?.cumulativeAllTime.callCount).toBe(1);
    expect(snap.externalTranslator?.cumulativeAllTime.successCount).toBe(1);
    expect(snap.externalTranslator?.bySession[session.sessionId]?.totalTokens).toBe(108);

    // Zero fake subagents injected into SwarmTracker
    const swarmState = core.swarm.getState(session.sessionId);
    expect(swarmState.workers).toHaveLength(0);

    // Switching provider in updateTranslationConfig without passing a new apiKey must clear old key & translator-secret.enc
    const switchedProvider = await core.updateTranslationConfig({
      externalTranslator: {
        enabled: false,
        provider: 'gemini-api-key',
        endpoint: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash-lite',
      },
    });
    expect(switchedProvider.engine).toBe('local');
    expect(switchedProvider.externalTranslator.apiKey).toBeUndefined();
    expect(existsSync(path.join(dataDir, 'translator-secret.enc'))).toBe(false);
  });

  it('3.3 External translation error & timeout transparently fall back to Bergamot local-model and record fallback telemetry with billed usage', async () => {
    const dataDir = makeDir('gravity-v024-fallback-');
    const cipher = createMockSecretCipher();
    const acp = new StubThoughtAcpClient();
    let mode: 'billed-error' | 'timeout' = 'billed-error';

    const core = new CoreService({
      dataDir,
      acp: acp as never,
      secretCipher: cipher,
      externalTranslator: async text => {
        if (text === 'Checking the configuration file.') return { text: '已检查配置。', latencyMs: 1 };
        if (mode === 'billed-error') {
          throw new IndependentModelCallError('外部翻译输出达到上限被截断', {
            inputTokens: 150,
            cachedInputTokens: 0,
            outputTokens: 25,
            thinkingTokens: 0,
            totalTokens: 175,
            providerReported: true,
          });
        }
        // Hang beyond timeoutMs (150ms)
        return new Promise(() => {});
      },
    });
    services.push(core);

    const chosen: ExternalTranslatorConfig = {
        enabled: true,
        provider: 'gemini-api-key',
        endpoint: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash-lite',
        apiKey: 'AIzaSyFallbackTestKey123456789012',
        thinkingLevel: 'off',
        timeoutMs: 150,
        connectionStatus: 'connected',
    };
    expect((await core.testExternalTranslatorConnection(chosen)).ok).toBe(true);
    await core.updateTranslationConfig({ engine: 'external-api', externalTranslator: chosen });

    const session = await core.createSession({ cwd: 'C:\\Workspace\\DemoApp', title: 'Fallback Test' });

    // 1) Billed error triggers fallback to real local Bergamot WASM
    acp.emitThoughtChunk(session.sessionId, 'Checking the configuration file for race condition.\n');
    await waitFor(
      async () => {
        const msgs = (await core.getSessionMessagePage(session.sessionId)).messages;
        const thought = msgs.find((m) => m.role === 'assistant')?.thoughts?.[0];
        expect(thought?.translationSource).toBe('local-model');
        expect(thought?.translatedZhText).toContain('竞态条件');
      },
      { timeout: 25000 }
    );

    // 2) Timeout triggers fallback to local Bergamot WASM
    mode = 'timeout';
    acp.emitThoughtChunk(session.sessionId, 'Updating the worker thread callback.\n');
    await waitFor(
      async () => {
        const msgs = (await core.getSessionMessagePage(session.sessionId)).messages;
        const thought = msgs.find((m) => m.role === 'assistant')?.thoughts?.[0];
        expect(thought?.translationSource).toBe('local-model');
        expect(thought?.translatedZhText).toContain('工作线程');
        expect(thought?.translatedZhText).toContain('回调');
      },
      { timeout: 15000 }
    );

    // Telemetry records 2 fallback calls including the 175 billed tokens from call #1
    const snap = await core.getTelemetryDashboard();
    expect(snap.externalTranslator?.cumulativeAllTime.callCount).toBe(2);
    expect(snap.externalTranslator?.cumulativeAllTime.fallbackCount).toBe(2);
    expect(snap.externalTranslator?.cumulativeAllTime.successCount).toBe(0);
    expect(snap.externalTranslator?.cumulativeAllTime.inputTokens).toBe(150);
    expect(snap.externalTranslator?.cumulativeAllTime.outputTokens).toBe(25);
    expect(snap.externalTranslator?.cumulativeAllTime.totalTokens).toBe(175);
    expect(snap.externalTranslator?.bySession[session.sessionId]?.fallbackCount).toBe(2);
    expect(core.swarm.getState(session.sessionId).workers).toHaveLength(0);
  }, 30000);

  it('3.4 translateWithExternalModel & testExternalTranslator reject private Google endpoints and parse Gemini/OpenAI/Ollama usage cleanly', async () => {
    // Reject private Google endpoint (cloudcode-pa)
    await expect(
      translateWithExternalModel('Check cache.', {
        enabled: true,
        provider: 'gemini-api-key',
        endpoint: 'https://cloudcode-pa.googleapis.com',
        model: 'gemini-2.5-flash-lite',
        apiKey: 'AIzaSyFakeKey1234567890',
        timeoutMs: 5000,
      })
    ).rejects.toThrow();

    expect(
      isExternalTranslatorConnected({
        enabled: true,
        provider: 'gemini-api-key',
        endpoint: 'https://cloudcode-pa.googleapis.com',
        model: 'gemini-2.5-flash-lite',
        apiKey: 'AIzaSyFakeKey1234567890',
      })
    ).toBe(false);

    // Gemini: skips part.thought, uses x-goog-api-key header, extracts usageMetadata
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const geminiFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers || {}) as Record<string, string>;
      return makeJsonResponse({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { thought: true, text: 'Internal thinking should be skipped.' },
                { text: '正在检查配置文件。' },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 20,
          candidatesTokenCount: 15,
          thoughtsTokenCount: 5,
          totalTokenCount: 120,
        },
      });
    }) as typeof fetch;

    const geminiTest = await testExternalTranslator(
      {
        enabled: true,
        provider: 'gemini-api-key',
        endpoint: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash-lite',
        apiKey: 'AIzaSyTestHeaderOnlyKey123456',
        thinkingLevel: 'off',
        maxOutputTokens: 2048,
        timeoutMs: 5000,
      },
      geminiFetcher
    );
    expect(geminiTest.ok).toBe(true);
    expect(geminiTest.sampleTranslation).toBe('正在检查配置文件。');
    expect(capturedUrl).not.toContain('AIzaSyTestHeaderOnlyKey123456');
    expect(capturedHeaders['x-goog-api-key']).toBe('AIzaSyTestHeaderOnlyKey123456');
    expect(geminiTest.usage?.totalTokens).toBeGreaterThan(0);

    // Local Ollama: http://127.0.0.1 allowed without apiKey, parses prompt_eval_count/eval_count
    const ollamaFetcher = (async () =>
      makeJsonResponse({
        message: { content: '本地模型译文。' },
        prompt_eval_count: 64,
        eval_count: 16,
      })) as typeof fetch;
    const ollamaRes = await translateWithExternalModel(
      'Check config.',
      {
        enabled: true,
        provider: 'local-ollama',
        endpoint: 'http://127.0.0.1:11434',
        model: 'qwen2.5:7b',
        thinkingLevel: 'off',
        timeoutMs: 5000,
      },
      ollamaFetcher
    );
    expect(ollamaRes.text).toBe('本地模型译文。');
    expect(ollamaRes.usage?.inputTokens).toBe(64);
    expect(ollamaRes.usage?.outputTokens).toBe(16);
  });
});

// ============================================================================
// Area 4: TelemetryStore external translation multi-provider ledger
// ============================================================================
describe('Area 4: TelemetryStore external translation multi-provider ledger & restart recovery', () => {
  const dirs: string[] = [];
  const stores: TelemetryStore[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) s.dispose();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('4.1 Multi-provider ledger (Gemini + OpenAI + local-ollama=$0), 24h/7d/30d buckets, .bak backup, and cold restart recovery', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gravity-v024-telemetry-'));
    dirs.push(dir);
    const nowTs = Date.UTC(2026, 10, 20, 14, 0, 0);
    const disk = new ClientStore(dir);
    const store1 = new TelemetryStore({ store: disk, now: () => nowTs });
    stores.push(store1);

    // 1) Gemini call today (inside 24h / today / 7d / 30d)
    store1.recordExternalTranslationUsage({
      sessionId: 'sess-root',
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      modelId: 'gemini-2.5-flash-lite',
      outcome: 'success',
      latencyMs: 120,
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 500_000, thinkingTokens: 0 },
      timestamp: nowTs,
    });

    // 2) OpenAI fallback call with billed tokens 2 days ago (inside 7d & 30d, outside today/24h)
    store1.recordExternalTranslationUsage({
      sessionId: 'sess-branch-a',
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      modelId: 'gpt-4o-mini',
      outcome: 'fallback',
      latencyMs: 340,
      usage: { inputTokens: 200_000, cachedInputTokens: 0, outputTokens: 100_000, thinkingTokens: 0, directCostUsd: 0.25 },
      timestamp: nowTs - 2 * 86_400_000,
    });

    // 3) Local Ollama call 10 days ago (inside 30d, outside 7d) -> MUST cost strictly $0
    store1.recordExternalTranslationUsage({
      sessionId: 'sess-branch-b',
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434',
      modelId: 'qwen2.5:7b',
      outcome: 'success',
      latencyMs: 90,
      usage: { inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 250_000, thinkingTokens: 0 },
      timestamp: nowTs - 10 * 86_400_000,
    });

    // 4) Error call today
    store1.recordExternalTranslationUsage({
      sessionId: 'sess-root',
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      modelId: 'gpt-4o-mini',
      outcome: 'error',
      latencyMs: 50,
      timestamp: nowTs,
    });

    const snap1 = store1.snapshot();
    const ext = snap1.externalTranslator!;
    expect(ext).toBeDefined();
    expect(ext.cumulativeAllTime.callCount).toBe(4);
    expect(ext.cumulativeAllTime.successCount).toBe(2);
    expect(ext.cumulativeAllTime.fallbackCount).toBe(1);
    expect(ext.cumulativeAllTime.errorCount).toBe(1);
    expect(ext.cumulativeAllTime.providerCount).toBe(3);

    // Ollama must be $0 even with 750k tokens
    const ollamaItem = ext.cumulativeProviders.find((p) => p.provider === 'local-ollama')!;
    expect(ollamaItem).toBeDefined();
    expect(ollamaItem.totalTokens).toBe(750_000);
    expect(ollamaItem.totalCostUsd).toBe(0);

    // OpenAI directCostUsd preserved
    const openAiItem = ext.cumulativeProviders.find((p) => p.provider === 'openai-compatible')!;
    expect(openAiItem.totalCostUsd).toBeCloseTo(0.25, 6);

    // Gemini cost > 0
    const geminiItem = ext.cumulativeProviders.find((p) => p.provider === 'gemini-api-key')!;
    expect(geminiItem.totalCostUsd).toBeGreaterThan(0);

    // Buckets & range scoping
    expect(ext.hourly24h).toHaveLength(24);
    expect(ext.matrix7d).toHaveLength(168);
    expect(ext.calendar30d).toHaveLength(30);
    expect(ext.costByRange.today.callCount).toBe(2);
    expect(ext.costByRange['7d'].callCount).toBe(3);
    expect(ext.costByRange['30d'].callCount).toBe(4);
    expect(ext.costByRange['7d'].totalCostUsd).toBeCloseTo(ext.costByRange.today.totalCostUsd + 0.25, 6);
    expect(ext.costByRange['30d'].totalCostUsd).toBeCloseTo(ext.costByRange['7d'].totalCostUsd, 6); // Ollama adds $0

    // Flush twice to exercise replacement of the permanent ledger and its shadow copy.
    store1.flush();
    store1.flush();
    expect(existsSync(path.join(dir, 'v2-external-translator-totals.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'v2-external-translator-totals.json.bak'))).toBe(true);
    expect(existsSync(path.join(dir, 'v2-external-translator-hours.json'))).toBe(true);

    store1.dispose();
    stores.pop();

    // Cold restart on the exact same dataDir
    const store2 = new TelemetryStore({ store: new ClientStore(dir), now: () => nowTs });
    stores.push(store2);
    const snap2 = store2.snapshot().externalTranslator!;
    expect(snap2.cumulativeAllTime.callCount).toBe(4);
    expect(snap2.cumulativeAllTime.providerCount).toBe(3);
    expect(snap2.cumulativeAllTime.totalCostUsd).toBeCloseTo(ext.cumulativeAllTime.totalCostUsd, 8);
    expect(snap2.cumulativeAllTime.totalTokens).toBe(ext.cumulativeAllTime.totalTokens);
    expect(snap2.bySession['sess-root'].callCount).toBe(2);
    expect(snap2.bySession['sess-branch-a'].totalCostUsd).toBeCloseTo(0.25, 6);
    expect(snap2.bySession['sess-branch-b'].totalCostUsd).toBe(0);
    expect(snap2.costByRange['30d'].callCount).toBe(4);
  });
});

// ============================================================================
// Area 5: Renderer UI Full-Stack Verification (Settings, 3-Way Context Inspector, Tree Total Cost)
// ============================================================================
describe('Area 5: Renderer UI full-stack (Settings translator card, 6-tab Right Inspector 3-way Context switch, multi-branch tree total cost)', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  let core: CoreService | undefined;
  let dataDir = '';

  beforeAll(async () => {
    fixture = await prepareMockAcp();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  afterEach(async () => {
    cleanup();
    resetDismissedQuestionsCacheForTests();
    try {
      window.localStorage.clear();
    } catch {
      /* noop */
    }
    delete window.gravityDesktop;
    await core?.dispose();
    core = undefined;
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = '';
    }
  });

  it('clears both settings keys on provider change and ignores old discovery and verification replies', async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-provider-draft-'));
    core = new CoreService({ dataDir, acp: new StubThoughtAcpClient() as never });
    const service = { ...DEFAULT_TRANSLATION_CONFIG.externalTranslator, enabled: true, apiKey: 'synthetic-provider-key-0001' };
    await core.updateTranslationConfig({ externalTranslator: service });
    await core.updateApprovalConfig({ externalReviewer: { ...service, enabled: false } });
    const bridge = createCoreBridge(core);
    let finishDiscovery!: (reply: ExternalReviewerModelsDiscoveryResult) => void;
    let finishTest!: (reply: { ok: boolean; latencyMs: number; sampleTranslation: string }) => void;
    const pending = new Promise<ExternalReviewerModelsDiscoveryResult>(resolve => { finishDiscovery = resolve; });
    bridge.discoverExternalTranslationModels = vi.fn(async () => pending);
    bridge.testExternalTranslatorConnection = vi.fn(() => new Promise<{ ok: boolean; latencyMs: number; sampleTranslation: string }>(resolve => { finishTest = resolve; }));
    bridge.discoverExternalReviewerModels = vi.fn(async () => pending);
    window.gravityDesktop = bridge;
    render(<App />);
    fireEvent.click(await screen.findByTestId('open-theme-modal-btn'));
    fireEvent.click(await screen.findByTestId('settings-tab-general'));
    fireEvent.click(await screen.findByTestId('discover-translator-models-btn'));
    fireEvent.click(screen.getByTestId('test-translator-connection-btn'));
    fireEvent.change(screen.getByTestId('translator-provider-select'), { target: { value: 'openai-compatible' } });
    expect((screen.getByTestId('translator-apikey-input') as HTMLInputElement).value).toBe('');
    await act(async () => {
      finishDiscovery({ provider: 'gemini-api-key', endpoint: service.endpoint, fetchedAt: 'now', models: [{ id: 'previous-model', displayName: 'old', supportsThinking: false, supportedThinkingLevels: ['auto'] }] });
      finishTest({ ok: true, latencyMs: 1, sampleTranslation: '过期译文' });
    });
    expect(screen.queryByTestId('translator-test-result')).toBeNull();
    expect(screen.queryByTestId('translator-model-select')).toBeNull();
    expect((screen.getByTestId('translator-model-input') as HTMLInputElement).value).toBe('gpt-4o-mini');
    fireEvent.click(screen.getByTestId('settings-tab-approvals'));
    fireEvent.click(await screen.findByTestId('drawer-tab-reviewer'));
    const provider = within(screen.getByTestId('approval-drawer')).getAllByRole('combobox')
      .find(el => (el as HTMLSelectElement).value === 'gemini-api-key')!;
    fireEvent.change(provider, { target: { value: 'openai-compatible' } });
    expect((screen.getByTestId('reviewer-apikey-input') as HTMLInputElement).value).toBe('');
    expect(bridge.discoverExternalReviewerModels).not.toHaveBeenCalled();
  });

  it('5.1 computeConversationTreeTotalCost accurately sums model + reviewer + translator across root + sibling + nested child (excluding unrelated sessions)', () => {
    const mkNode = (
      branchId: string,
      parentBranchId: string | null,
      depth: number,
      childrenIds: string[],
      isActiveBranch: boolean
    ) => ({
      branchId,
      rootSessionId: 'root',
      parentBranchId,
      forkAfterMessageId: parentBranchId ? 'm-1' : null,
      forkUserTurnIndex: parentBranchId ? depth : -1,
      forkPromptPreview: branchId,
      createdAt: '2026-11-20T00:00:00Z',
      updatedAt: '2026-11-20T00:00:00Z',
      childrenIds,
      depth,
      siblingIndex: 1,
      siblingCount: 1,
      isActiveBranch,
      isOnActivePath: true,
      userTurnCount: 2,
      ownMessageCount: 2,
      latestUserPreview: branchId,
      latestAssistantPreview: 'ok',
      status: 'idle' as const,
      modelId: 'gemini-4-neon',
      usedContextTokens: 1000,
      maxContextTokens: 256_000,
      usageRatio: 0.01,
      totalCostUsd: 0,
    });
    const nodes = [
      mkNode('root', null, 0, ['sibling-a'], false),
      mkNode('sibling-a', 'root', 1, ['child-nested'], false),
      mkNode('child-nested', 'sibling-a', 2, [], true),
    ];
    const tree: ConversationTreeState = {
      rootSessionId: 'root',
      rootTitle: 'Main',
      activeBranchId: 'child-nested',
      totalBranches: 3,
      nodes,
      nodesById: Object.fromEntries(nodes.map((n) => [n.branchId, n])),
      updatedAt: '2026-11-20T00:02:00Z',
    };

    const mkCost = (usd: number) => ({
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 500,
      thinkingTokens: 0,
      totalTokens: 1500,
      inputCostUsd: usd,
      cachedInputCostUsd: 0,
      outputCostUsd: 0,
      thinkingCostUsd: 0,
      totalCostUsd: usd,
    });

    const dashboard = {
      activeSessions: {
        root: { costSummary: mkCost(1.1) },
        'sibling-a': { costSummary: mkCost(2.2) },
        'child-nested': { costSummary: mkCost(3.3) },
        'unrelated-session': { costSummary: mkCost(99.99) },
      },
      externalReviewer: {
        bySession: {
          root: { ...mkCost(0.11) },
          'sibling-a': { ...mkCost(0.22) },
          'child-nested': { ...mkCost(0.33) },
          'unrelated-session': { ...mkCost(50.0) },
        },
      },
      externalTranslator: {
        bySession: {
          root: { ...mkCost(0.05) },
          'sibling-a': { ...mkCost(0.07) },
          'child-nested': { ...mkCost(0.09) },
          'unrelated-session': { ...mkCost(25.0) },
        },
      },
    } as unknown as TelemetryDashboardSnapshot;

    for (const activeId of ['root', 'sibling-a', 'child-nested']) {
      const result = computeConversationTreeTotalCost(activeId, tree, dashboard);
      expect(result.branchCount).toBe(3);
      expect(result.modelCostUsd).toBeCloseTo(6.6, 6);
      expect(result.reviewerCostUsd).toBeCloseTo(0.66, 6);
      expect(result.translatorCostUsd).toBeCloseTo(0.21, 6);
      expect(result.totalCostUsd).toBeCloseTo(7.47, 6);
    }
  });

  it('5.2 Settings General 2-way engine switch (default local), unconnected guidance, independent external translator card (discover/test/save), and Right Inspector 6-tab + 3-way Context stats', async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-v024-ui-settings-'));
    const cipher = createMockSecretCipher();
    const spawnSpy = vi.fn((_binary, _args, options) => spawn(fixture.executable, fixture.args, options));

    const discoveryFetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/models')) {
        return makeJsonResponse({
          data: [
            { id: 'gpt-4o-mini' },
            { id: 'gpt-4.1-mini' },
          ],
        });
      }
      return makeJsonResponse({ data: [] });
    }) as typeof fetch;

    core = new CoreService({
      dataDir,
      acpOptions: { spawn: spawnSpy },
      secretCipher: cipher,
      modelDiscoveryFetcher: discoveryFetcher,
      externalTranslator: async () => ({
        text: '正在检查配置文件。',
        latencyMs: 66,
        usage: {
          inputTokens: 20,
          cachedInputTokens: 0,
          outputTokens: 10,
          thinkingTokens: 0,
          totalTokens: 30,
          providerReported: true,
        },
      }),
    });

    const sess = await core.createSession({ cwd: 'F:\\UiQA', title: 'UI 设置与三视图测试' });
    // Seed multi-provider translation & reviewer telemetry
    core.telemetry.recordExternalTranslationUsage({
      sessionId: sess.sessionId,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      modelId: 'gemini-2.5-flash-lite',
      outcome: 'success',
      latencyMs: 110,
      usage: { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 50_000, thinkingTokens: 0, directCostUsd: 0.12 },
    });
    core.telemetry.recordExternalTranslationUsage({
      sessionId: sess.sessionId,
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      modelId: 'gpt-4o-mini',
      outcome: 'fallback',
      latencyMs: 250,
      usage: { inputTokens: 40_000, cachedInputTokens: 0, outputTokens: 20_000, thinkingTokens: 0, directCostUsd: 0.08 },
    });

    await core.saveWorkspaceLayout({
      openTabSessionIds: [sess.sessionId],
      activePrimarySessionId: sess.sessionId,
      layoutMode: 'single',
      rightInspectorCollapsed: false,
      activeInspectorTab: 'context',
    });

    window.gravityDesktop = createCoreBridge(core);
    render(<App />);
    await screen.findByTestId('agy-app-root');

    // 1) D1 (v0.3.4): Right Inspector strictly 5 top-level tabs (Tree moved under Context) + sub-view switches inside Context
    const inspectorHead = document.querySelector('.inspector-head')!;
    expect(inspectorHead).toBeTruthy();
    const headTabs = within(inspectorHead as HTMLElement).getAllByRole('tab');
    expect(headTabs).toHaveLength(5);

    expect(screen.getByTestId('ctx-view-switch-context')).toBeTruthy();
    expect(screen.getByTestId('ctx-view-switch-reviewer')).toBeTruthy();
    expect(screen.getByTestId('ctx-view-switch-translator')).toBeTruthy();

    // Switch to reviewer view
    fireEvent.click(screen.getByTestId('ctx-view-switch-reviewer'));
    await screen.findByTestId('external-reviewer-telemetry-view');

    // Switch to translator view -> verify multi-provider stats, outcome bar, 24h/7d/30d heatmap, donut
    fireEvent.click(screen.getByTestId('ctx-view-switch-translator'));
    await screen.findByTestId('external-translator-telemetry-view');
    expect(screen.getByTestId('translator-alltime-summary').textContent).toContain('$0.200');
    expect(screen.getByTestId('translator-alltime-summary').textContent).toContain('2');
    expect(screen.getByTestId('translator-outcome-bar')).toBeTruthy();
    expect(screen.getByTestId('translator-provider-breakdown').textContent).toContain('gemini-2.5-flash-lite');
    expect(screen.getByTestId('translator-provider-breakdown').textContent).toContain('gpt-4o-mini');
    expect(screen.getByTestId('translator-cost-donut-svg')).toBeTruthy();

    fireEvent.click(screen.getByTestId('translator-heatmap-range-7d'));
    await screen.findByTestId('translator-heatmap-7d-matrix');
    fireEvent.click(screen.getByTestId('translator-heatmap-range-30d'));
    await screen.findByTestId('translator-heatmap-30d-calendar');

    // Switch back to Context window view
    fireEvent.click(screen.getByTestId('ctx-view-switch-context'));
    expect(screen.queryByTestId('external-translator-telemetry-view')).toBeNull();

    // 2) Open Settings -> General: default 'local', unconnected prompt, independent external translator card
    fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
    fireEvent.click(await screen.findByTestId('settings-tab-general'));
    await screen.findByTestId('translation-engine');

    const localBtn = screen.getByTestId('translation-engine-local');
    const extBtn = screen.getByTestId('translation-engine-external');
    expect(localBtn.className).toContain('is-active');
    expect(extBtn.className).not.toContain('is-active');

    // Clicking 'external-api' while unconnected shows guidance and expands the independent config card
    fireEvent.click(extBtn);
    await screen.findByTestId('translation-external-connect-prompt');
    await screen.findByTestId('external-translator-form');

    // Configure OpenAI-Compatible in the translator card
    expect((screen.getByTestId('translator-enable-switch') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('translator-provider-select'), {
      target: { value: 'openai-compatible' },
    });
    fireEvent.change(screen.getByTestId('translator-apikey-input'), {
      target: { value: 'sk-proj-UiTranslatorKey1234567890' },
    });

    // Discover models
    fireEvent.click(screen.getByTestId('discover-translator-models-btn'));
    const modelSelect = await screen.findByTestId('translator-model-select');
    expect(modelSelect.textContent).toContain('gpt-4o-mini');
    expect(modelSelect.textContent).toContain('gpt-4.1-mini');

    // Test connection
    fireEvent.click(screen.getByTestId('test-translator-connection-btn'));
    const testResult = await screen.findByTestId('translator-test-result');
    expect(testResult.textContent).toContain('正在检查配置文件。');

    // Save config -> because user previously clicked external-api (connectPrompt), engine upgrades to 'external-api'
    fireEvent.click(screen.getByTestId('save-translator-config-btn'));
    await waitFor(async () => {
      const saved = await core!.getTranslationConfig();
      expect(saved.engine).toBe('external-api');
      expect(saved.externalTranslator.provider).toBe('openai-compatible');
      expect(saved.externalTranslator.enabled).toBe(true);
    });

    expect(screen.getByTestId('translation-engine-external').className).toContain('is-active');
    expect(screen.getByTestId('translator-connection-badge').textContent).toMatch(/已连接|Connected/);
    // External Reviewer config remains completely untouched!
    expect(core.approval.getConfig().externalReviewer.enabled).toBe(false);
    expect(core.approval.getConfig().externalReviewer.provider).toBe('gemini-api-key');
  }, 20000);

  it('5.3 Multi-branch conversation tree (root + sibling + nested child): Composer bottom cost equals full tree total across ALL branches while ctx stays per-branch', async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-v024-tree-cost-'));
    const spawnSpy = vi.fn((_binary, _args, options) => spawn(fixture.executable, fixture.args, options));
    core = new CoreService({ dataDir, acpOptions: { spawn: spawnSpy } });

    const waitIdle = async (sessionId: string) => {
      await waitFor(
        async () => {
          expect(core!.sessions.isBusy(sessionId)).toBe(false);
          const msgs = (await core!.getSessionMessagePage(sessionId)).messages;
          expect(msgs.at(-1)?.role).toBe('assistant');
          expect(msgs.at(-1)?.isStreaming).toBe(false);
        },
        { timeout: 10000 }
      );
    };

    const root = await core.createSession({ cwd: 'F:\\TreeCostQA', title: '多分支总花费验证' });
    await core.sendPrompt({ sessionId: root.sessionId, text: 'Root Turn 1' });
    await core.sendPrompt({ sessionId: root.sessionId, text: 'Root Turn 2 Original' });

    const rootMsgs = (await core.getSessionMessagePage(root.sessionId)).messages;
    const rootTurn2 = rootMsgs.find((m) => m.role === 'user' && m.content === 'Root Turn 2 Original')!;

    // Sibling Branch A forked from root Turn 2
    const branchA = await core.reviseMessage({
      sessionId: root.sessionId,
      messageId: rootTurn2.id,
      text: 'Branch A Turn 2',
    });
    await waitIdle(branchA.sessionId);
    await core.sendPrompt({ sessionId: branchA.sessionId, text: 'Branch A Turn 3' });
    await waitIdle(branchA.sessionId);

    const branchAMsgs = (await core.getSessionMessagePage(branchA.sessionId)).messages;
    const branchATurn3 = branchAMsgs.find((m) => m.role === 'user' && m.content === 'Branch A Turn 3')!;

    // Nested Child Branch B forked from Branch A Turn 3
    const branchB = await core.reviseMessage({
      sessionId: branchA.sessionId,
      messageId: branchATurn3.id,
      text: 'Branch B Nested Turn 3',
    });
    await waitIdle(branchB.sessionId);

    // Record distinct main model context/tokens + external reviewer + external translator costs on EACH branch
    // 1) Root branch: ctx = 12,000; reviewer = $0.12; translator = $0.04
    core.telemetry.applyContextWindow(root.sessionId, 12_000, 256_000);
    core.telemetry.recordExternalReviewUsage({
      sessionId: root.sessionId,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      modelId: 'gemini-2.5-flash-lite',
      outcome: 'approve',
      latencyMs: 80,
      usage: { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000, thinkingTokens: 0, directCostUsd: 0.12 },
    });
    core.telemetry.recordExternalTranslationUsage({
      sessionId: root.sessionId,
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      modelId: 'gpt-4o-mini',
      outcome: 'success',
      latencyMs: 70,
      usage: { inputTokens: 5_000, cachedInputTokens: 0, outputTokens: 2_000, thinkingTokens: 0, directCostUsd: 0.04 },
    });

    // 2) Sibling Branch A: ctx = 48,000; reviewer = $0.25; translator = $0.09
    core.telemetry.applyContextWindow(branchA.sessionId, 48_000, 256_000);
    core.telemetry.recordExternalReviewUsage({
      sessionId: branchA.sessionId,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      modelId: 'gemini-2.5-flash-lite',
      outcome: 'ask',
      latencyMs: 90,
      usage: { inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 3_000, thinkingTokens: 0, directCostUsd: 0.25 },
    });
    core.telemetry.recordExternalTranslationUsage({
      sessionId: branchA.sessionId,
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      modelId: 'gpt-4o-mini',
      outcome: 'success',
      latencyMs: 60,
      usage: { inputTokens: 8_000, cachedInputTokens: 0, outputTokens: 3_000, thinkingTokens: 0, directCostUsd: 0.09 },
    });

    // 3) Nested Child Branch B: ctx = 96,000; reviewer = $0.40; translator = $0.15
    core.telemetry.applyContextWindow(branchB.sessionId, 96_000, 256_000);
    core.telemetry.recordExternalReviewUsage({
      sessionId: branchB.sessionId,
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      modelId: 'gpt-4o-mini',
      outcome: 'approve',
      latencyMs: 110,
      usage: { inputTokens: 30_000, cachedInputTokens: 0, outputTokens: 4_000, thinkingTokens: 0, directCostUsd: 0.4 },
    });
    core.telemetry.recordExternalTranslationUsage({
      sessionId: branchB.sessionId,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      modelId: 'gemini-2.5-flash-lite',
      outcome: 'success',
      latencyMs: 55,
      usage: { inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 4_000, thinkingTokens: 0, directCostUsd: 0.15 },
    });

    const treeState = await core.getConversationTree(root.sessionId);
    expect(treeState.totalBranches).toBe(3);

    const dashboard = await core.getTelemetryDashboard();
    const expectedTreeCost = computeConversationTreeTotalCost(branchB.sessionId, treeState, dashboard);
    expect(expectedTreeCost.branchCount).toBe(3);
    expect(expectedTreeCost.reviewerCostUsd).toBeCloseTo(0.12 + 0.25 + 0.4, 6);
    expect(expectedTreeCost.translatorCostUsd).toBeCloseTo(0.04 + 0.09 + 0.15, 6);
    expect(expectedTreeCost.totalCostUsd).toBeCloseTo(
      expectedTreeCost.modelCostUsd + expectedTreeCost.reviewerCostUsd + expectedTreeCost.translatorCostUsd,
      6
    );
    const expectedFormattedTotal = formatUsd(expectedTreeCost.totalCostUsd);

    await core.saveWorkspaceLayout({
      openTabSessionIds: [branchB.sessionId],
      activePrimarySessionId: branchB.sessionId,
      layoutMode: 'single',
      rightInspectorCollapsed: false,
      activeInspectorTab: 'tree',
    });

    window.gravityDesktop = createCoreBridge(core);
    render(<App />);
    await screen.findByTestId(`session-pane-${branchB.sessionId}`);

    // Verify Composer cost on Nested Child Branch B matches full tree total + 3-part tooltip, while ctx is 96k
    await waitFor(() => {
      const costEl = screen.getByTestId(`composer-tree-cost-${branchB.sessionId}`);
      expect(costEl.textContent?.trim()).toBe(expectedFormattedTotal);
      const tooltip = costEl.getAttribute('title') || '';
      expect(tooltip).toContain('3');
      expect(tooltip).toContain(formatUsd(expectedTreeCost.modelCostUsd));
      expect(tooltip).toContain(formatUsd(expectedTreeCost.reviewerCostUsd));
      expect(tooltip).toContain(formatUsd(expectedTreeCost.translatorCostUsd));
      expect(tooltip).toMatch(/主模型|Model/);
      expect(tooltip).toMatch(/外部代审|Reviewer/);
      expect(tooltip).toMatch(/外部翻译|Translator/);
    });
    expect(screen.getByTestId(`context-inspector-trigger-${branchB.sessionId}`).textContent).toContain('96k/256k');

    // Switch to Sibling Branch A via Right Inspector Conversation Tree UI: total cost MUST remain identical while ctx updates to 48k
    await screen.findByTestId('conversation-tree-panel');
    fireEvent.click(screen.getByTestId(`tree-node-${branchA.sessionId}`));
    await screen.findByTestId(`session-pane-${branchA.sessionId}`);
    await waitFor(() => {
      expect(screen.getByTestId(`composer-tree-cost-${branchA.sessionId}`).textContent?.trim()).toBe(
        expectedFormattedTotal
      );
      expect(screen.getByTestId(`context-inspector-trigger-${branchA.sessionId}`).textContent).toContain('48k/256k');
    });

    // Switch to Root branch via Right Inspector Conversation Tree UI: total cost MUST remain identical while ctx updates to 12k
    fireEvent.click(screen.getByTestId(`tree-node-${root.sessionId}`));
    await screen.findByTestId(`session-pane-${root.sessionId}`);
    await waitFor(() => {
      expect(screen.getByTestId(`composer-tree-cost-${root.sessionId}`).textContent?.trim()).toBe(
        expectedFormattedTotal
      );
      expect(screen.getByTestId(`context-inspector-trigger-${root.sessionId}`).textContent).toContain('12k/256k');
    });

    // Cold restart with telemetry-sessions.json removed: calling switchConversationBranch hydrates ALL tree branches
    cleanup();
    await core.dispose();
    core = undefined;
    rmSync(path.join(dataDir, 'telemetry-sessions.json'), { force: true });

    const restartedCore = new CoreService({ dataDir, acp: new StubThoughtAcpClient() as never });
    core = restartedCore;
    await restartedCore.switchConversationBranch({
      sessionId: root.sessionId,
      targetBranchId: branchA.sessionId,
    });
    const hydratedSnap = await restartedCore.getTelemetryDashboard();
    expect(hydratedSnap.activeSessions[root.sessionId]?.usedContextTokens).toBeGreaterThan(0);
    expect(hydratedSnap.activeSessions[branchA.sessionId]?.usedContextTokens).toBeGreaterThan(0);
    expect(hydratedSnap.activeSessions[branchB.sessionId]?.usedContextTokens).toBeGreaterThan(0);
  }, 25000);
});
