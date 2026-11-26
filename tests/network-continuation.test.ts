// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpRequestNotSentError, AcpRpcError } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { inspectStreamInterruption, type AcpSessionPromptParams, type AcpSessionPromptResult } from '../src/shared';
import { readAllSessionMessages } from './helpers/core-bridge';

const warning = '⚠ There was a network issue connecting to the server, please try again.';
let core: CoreService;
let directory: string;
let sessionId: string;
let prompts: AcpSessionPromptParams[];
let answer: (attempt: number) => Promise<AcpSessionPromptResult> | AcpSessionPromptResult;

function chunk(text: string) {
  core.client.emit('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
}
function run() { return core.sendPrompt({ sessionId, text: 'Finish the diagram' }); }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gravity-continuation-'));
  const client = new AcpClient();
  client.initializeResult = { protocolVersion: 1, agentInfo: { name: 'fixture', version: '1' }, agentCapabilities: { loadSession: true } };
  vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
  vi.spyOn(client, 'notify').mockImplementation(() => {});
  prompts = [];
  vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'session/new') return { sessionId: 'same-branch' };
    if (method === 'session/prompt') {
      prompts.push(params as AcpSessionPromptParams);
      return answer(prompts.length);
    }
    return {};
  });
  core = new CoreService({ acp: client, dataDir: directory, homeDir: join(directory, 'local-home') });
  sessionId = (await core.createSession({ cwd: directory })).sessionId;
});
afterEach(async () => {
  await core.dispose();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('one continuation per interrupted user prompt', () => {
  it('recognizes the recorded warning split across ACP messages after partial text and retains both turns of usage', async () => {
    answer = (attempt) => {
      if (attempt === 1) {
        chunk('Finished the outline.');
        chunk(warning.slice(0, 19));
        chunk(warning.slice(19));
      } else {
        chunk('Here is the diagram.');
      }
      return { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 12 } };
    };
    await run();
    expect(prompts.map(p => p.sessionId)).toEqual([sessionId, sessionId]);
    expect(prompts[1].prompt).not.toEqual(prompts[0].prompt);
    const rows = await readAllSessionMessages(core, sessionId);
    expect(rows.filter(r => r.role === 'user')).toHaveLength(1);
    expect(rows.filter(r => r.role === 'assistant').map(r => r.content)).toEqual(['Finished the outline.', 'Here is the diagram.']);
    expect(rows.filter(r => r.role === 'system' && r.content.includes('续接'))).toHaveLength(1);
    expect(core.telemetry.ensure(sessionId).costSummary.totalTokens).toBe(84);
  });

  it('retains the second interruption with manual recovery and sends no third request', async () => {
    answer = attempt => {
      if (attempt === 2) chunk('Recovered some work.\n');
      chunk(warning);
      return { stopReason: 'end_turn' };
    };
    await run();
    const last = (await readAllSessionMessages(core, sessionId)).at(-1)!;
    expect(prompts).toHaveLength(2);
    expect(last.autoResumeFailure).toEqual({});
    expect(inspectStreamInterruption(last.content)).toMatchObject({ content: 'Recovered some work.', trailing: true });
  });

  it('charges only the visible text estimate when the provider never reports output', async () => {
    answer = attempt => {
      if (attempt === 1) { chunk('Text.'); chunk('⚠'); chunk('\uFE0F' + warning.slice(1)); }
      else chunk('Done.');
      return { stopReason: 'end_turn' };
    };
    await run();
    const meter = core.telemetry.ensure(sessionId);
    expect(prompts).toHaveLength(2);
    expect(meter.breakdown.agentMessagesTokens).toBe(4);
    expect(meter.costSummary.outputTokens).toBe(4);
  });

  it('preserves official output and tools when an intervening usage event includes part of a fragmented warning', async () => {
    answer = attempt => {
      if (attempt === 1) {
        chunk('Kept');
        core.client.emit('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'read',
          title: 'read_file', kind: 'read', status: 'completed', rawInput: { path: 'example.txt' } } });
        chunk(warning.slice(0, 15));
        core.client.emit('session/update', { sessionId, update: { sessionUpdate: 'usage_update',
          usage: { inputTokens: 100, outputTokens: 40, thoughtTokens: 10, totalTokens: 140 } } });
        chunk(warning.slice(15, 25));
        chunk(warning.slice(25));
      } else chunk('OK');
      return { stopReason: 'end_turn' };
    };
    await run();
    const meter = core.telemetry.ensure(sessionId);
    expect(meter.breakdown.agentMessagesTokens).toBe(2);
    expect(meter.breakdown.toolCallsTokens).toBeGreaterThan(0);
    expect(meter.costSummary.outputTokens).toBe(31);
    expect(meter.costSummary.thinkingTokens).toBe(10);
  });

  it('recognizes an Error: marker split in the middle after partial reply text', async () => {
    answer = attempt => {
      if (attempt === 1) { chunk('Partial text.'); chunk('Er'); chunk('ror: There was a network issue'); chunk(' connecting to the server, please try again.'); }
      else chunk('Done.');
      return { stopReason: 'end_turn' };
    };
    await run();
    expect(prompts).toHaveLength(2);
    expect((await readAllSessionMessages(core, sessionId)).find(r => r.role === 'assistant')?.content).toBe('Partial text.');
  });

  it.each([true, false])('moves a warning estimate back to an official unclassified total, with extra fragment %s', async extraFragment => {
    answer = attempt => {
      if (attempt === 1) {
        chunk('ABCD');
        chunk(warning.slice(0, 19));
        core.client.emit('session/update', { sessionId, update: { sessionUpdate: 'usage_update',
          usage: { inputTokens: 1000, cachedReadTokens: 600, totalTokens: 1050 } } });
        if (extraFragment) chunk(warning.slice(19, 29));
        chunk(warning.slice(extraFragment ? 29 : 19));
        expect(core.telemetry.ensure(sessionId).costSummary).toMatchObject({ totalTokens: 1050, outputTokens: 1, unclassifiedTokens: 49 });
      } else {
        expect(core.telemetry.ensure(sessionId).costSummary).toMatchObject({ outputTokens: 1, unclassifiedTokens: 49 });
      }
      return { stopReason: 'end_turn' };
    };
    await run();
    expect(prompts).toHaveLength(2);
    expect(core.telemetry.ensure(sessionId).costSummary).toMatchObject({ outputTokens: 1, unclassifiedTokens: 49 });
  });

  it('reports a continuation closed by the provider without delivering a reply', async () => {
    answer = attempt => { if (attempt === 1) chunk(warning); return { stopReason: attempt === 1 ? 'end_turn' : 'refusal' }; };
    await run();
    expect(prompts).toHaveLength(2);
    expect((await readAllSessionMessages(core, sessionId)).at(-1)?.autoResumeFailure?.detail).toContain('refusal');
  });

  it('accepts a network RPC error on a live session and exposes a subsequent RPC rejection', async () => {
    answer = attempt => { throw new AcpRpcError(-32603, attempt === 1 ? warning.slice(2) : 'The server is unavailable'); };
    await run();
    const rows = await readAllSessionMessages(core, sessionId);
    expect(prompts).toHaveLength(2);
    expect(rows[0].sendFailed).toBeUndefined();
    expect(rows.at(-1)?.autoResumeFailure?.detail).toBe('The server is unavailable');
  });

  it('honours explicit cancellation while the first network warning is on screen', async () => {
    answer = async () => { chunk(warning); await core.cancelPrompt(sessionId); return { stopReason: 'cancelled' }; };
    await run();
    expect(prompts).toHaveLength(1);
    expect((await readAllSessionMessages(core, sessionId)).some(r => r.autoResumeFailure)).toBe(false);
  });

  it.each(['refusal', 'cancelled', 'max_tokens'])('honours the service stop reason %s', async stopReason => {
    answer = () => { chunk(warning); return { stopReason }; };
    await run();
    expect(prompts).toHaveLength(1);
  });

  it('does not retry an unsent prompt or a rate limit', async () => {
    for (const error of [new AcpRequestNotSentError(warning), new AcpRpcError(429, warning), new AcpRpcError(-32603, 'Network error: 429 RESOURCE_EXHAUSTED')]) {
      answer = () => { throw error; };
      await expect(run()).rejects.toBe(error);
    }
    expect(prompts).toHaveLength(3);
  });

  it('does not interpret a rate-limit warning delivered as text as a network interruption', async () => {
    answer = () => { chunk('⚠ Network error: 429 RESOURCE_EXHAUSTED'); return { stopReason: 'end_turn' }; };
    await run();
    expect(prompts).toHaveLength(1);
  });

  it('preserves quoted, fenced and inline documentation without continuing or removing any text', async () => {
    const quoted = ['An example: ' + warning, '> ' + warning, '~~~text', warning, '~~~', '    ' + warning].join('\n');
    answer = () => { for (const line of quoted.split('\n')) chunk(line + '\n'); return { stopReason: 'end_turn' }; };
    await run();
    expect(prompts).toHaveLength(1);
    expect((await readAllSessionMessages(core, sessionId)).at(-1)?.content).toBe(quoted + '\n');
  });

  it('clears a one-off warning when normal output resumes without a newline', async () => {
    answer = () => { chunk(warning); chunk('The connection recovered.'); return { stopReason: 'end_turn' }; };
    await run();
    expect(prompts).toHaveLength(1);
    expect((await readAllSessionMessages(core, sessionId)).at(-1)?.content).toBe('The connection recovered.');
  });

  it('holds the same-branch prompt lock between the original response and its continuation', async () => {
    let concurrent: Promise<void> | undefined;
    core.on('session-updated', s => {
      if (s.status === 'idle' && prompts.length === 1 && !concurrent) {
        concurrent = expect(run()).rejects.toThrow(/仍在生成/);
      }
    });
    answer = attempt => { chunk(attempt === 1 ? warning : 'Done.'); return { stopReason: 'end_turn' }; };
    await run();
    await concurrent;
    expect(concurrent).toBeDefined();
    expect(prompts).toHaveLength(2);
  });
});
