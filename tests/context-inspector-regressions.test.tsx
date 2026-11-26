import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { mkdtempSync, mkdirSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AcpClient } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { ClientStore } from '../src/main/storage/client-store';
import { TelemetryStore, estimateTokens } from '../src/main/telemetry/telemetry-store';
import { DEFAULT_MODEL_RATE_CARDS, mergeTelemetryDashboard, resolveModelRateCard } from '../src/shared';
import type { AcpSessionPromptParams, TelemetryDashboardSnapshot } from '../src/shared';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { RatesPanel } from '../src/renderer/components/settings/WorkspacePanels';

const directories: string[] = [];
const resources: Array<{ dispose(): void | Promise<void> }> = [];
function directory() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gravity-cost-inspector-'));
  directories.push(dir);
  return dir;
}
function remember<T extends { dispose(): void | Promise<void> }>(item: T): T { resources.push(item); return item; }
afterEach(async () => {
  cleanup();
  for (const item of resources.splice(0)) await item.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function desktop(dir: string, agentName = 'fixture') {
  const client = new AcpClient({ spawn: () => { throw Error('Offline fixture'); } });
  client.initializeResult = { protocolVersion: 1, agentInfo: { name: agentName, version: '1' }, agentCapabilities: {} };
  vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
  const realRequest = client.request.bind(client);
  let prompt = async (_params: AcpSessionPromptParams): Promise<unknown> => ({ stopReason: 'end_turn' });
  const sessionId = 'local-session-1';
  vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'session/new') return { sessionId };
    if (method === 'session/prompt') return prompt(params as AcpSessionPromptParams);
    return {};
  });
  const core = remember(new CoreService({ dataDir: dir, homeDir: path.join(dir, 'fixture-home'), acp: client }));
  return { core, client, sessionId, setPrompt(fn: typeof prompt) { prompt = fn; }, realRequest };
}

describe('Context Inspector through chat, storage and renderer entry points', () => {
  it('accounts for the file that was sent, excludes repeated tool-image payloads and reverses only pre-dispatch failures', async () => {
    const dir = directory();
    const { core, client, sessionId, setPrompt, realRequest } = desktop(dir);
    await core.createSession({ cwd: dir });
    writeFileSync(path.join(dir, 'reference.txt'), 'a'.repeat(4096));
    setPrompt(async params => {
      expect(params.prompt.find(block => block.type === 'resource')).toBeTruthy();
      for (const sessionUpdate of ['tool_call', 'tool_call_update']) client.emit('session/update', { sessionId, update: {
        sessionUpdate, toolCallId: 'image', title: 'read image', status: 'completed',
        content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'A'.repeat(40000) } }],
      } });
      return { stopReason: 'end_turn' };
    });
    await core.sendPrompt({ sessionId, text: 'x', references: [{ kind: 'file', label: 'reference.txt', value: 'reference.txt' }] });
    const before = core.telemetry.snapshot();
    expect(before.activeSessions[sessionId]).toMatchObject({ costSummary: { inputTokens: 1025, outputTokens: 0 }, currentTokensPerSecond: 0 });
    Object.defineProperty(client, 'cooldownUntil', { configurable: true, writable: true, value: Date.now() + 60000 });
    setPrompt(params => realRequest('session/prompt', params));
    await expect(core.sendPrompt({ sessionId, text: 'x'.repeat(400) })).rejects.toThrow('已暂停');
    expect((await core.getSessionMessagePage(sessionId)).messages.at(-1)?.sendFailed).toBe(true);
    expect(core.telemetry.snapshot().costByRange.today).toEqual(before.costByRange.today);
    setPrompt(async () => {
      client.emit('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'test' } } });
      throw Error('Disconnected after generation');
    });
    await expect(core.sendPrompt({ sessionId, text: 'x' })).rejects.toThrow('after generation');
    expect(core.telemetry.getSessionTelemetry(sessionId)?.costSummary).toMatchObject({ inputTokens: 1026, outputTokens: 1 });
  });

  it('retains partial official totals, distinct thinking conventions and the most specific dated-model price', () => {
    const disk = new ClientStore(directory());
    const s = remember(new TelemetryStore({ store: disk }));
    s.beginTurn('s', 'x');
    const partial = { totalTokens: 1200, cachedInputTokens: 80, thoughtTokens: 30 };
    s.applyUsage('s', partial); s.applyUsage('s', partial);
    expect(s.getSessionTelemetry('s')?.costSummary).toMatchObject({ totalTokens: 1200, cachedInputTokens: 80, thinkingTokens: 30, unclassifiedTokens: 1090 });
    s.endTurn('s'); s.flush();
    expect(remember(new TelemetryStore({ store: disk })).snapshot().costByRange.today.totalTokens).toBe(1200);
    s.beginTurn('second', 'x');
    s.applyUsage('second', { inputTokens: 12, outputTokens: 8, thoughtTokens: 4, totalTokens: 24 });
    expect(s.getSessionTelemetry('second')?.costSummary).toMatchObject({ inputTokens: 12, outputTokens: 8, thinkingTokens: 4, totalTokens: 24 });
    expect(resolveModelRateCard('gemini-2.5-flash-lite-preview-09-2025', DEFAULT_MODEL_RATE_CARDS).modelId).toBe('gemini-2.5-flash-lite');
  });

  it('correlates delayed and failed compactions, resumes estimated growth and retains the total beyond the latest fifty', () => {
    const disk = new ClientStore(directory()), s = remember(new TelemetryStore({ store: disk }));
    s.applyContextWindow('s', 20000, 256000);
    s.beginTurn('s', 'x'.repeat(4000)); s.endTurn('s');
    expect(s.getSessionTelemetry('s')).toMatchObject({ usedContextTokens: 21000, usageSource: 'mixed' });
    s.applyContextWindow('s', 20000, 256000);
    s.beginManualCompaction('s'); s.beginTurn('s', '/compact'); s.endTurn('s'); s.finishManualCompaction('s');
    expect(s.getSessionTelemetry('s')?.compactions).toHaveLength(0);
    s.applyContextWindow('s', 5000);
    expect(s.getSessionTelemetry('s')?.compactions?.map(r => r.trigger)).toEqual(['manual']);
    s.beginManualCompaction('s'); s.applyContextWindow('s', 1000); s.cancelManualCompaction('s');
    expect(s.getSessionTelemetry('s')?.compactionCount).toBe(1);
    for (let i = 0; i < 50; i++) { s.applyContextWindow('s', 20000); s.applyContextWindow('s', 5000); }
    s.flush();
    const reloaded = remember(new TelemetryStore({ store: disk })).getSessionTelemetry('s');
    expect(reloaded?.compactions).toHaveLength(50);
    expect(reloaded?.compactionCount).toBe(51);
    expect(reloaded?.compactionCountIsMinimum).toBeFalsy();
    s.beginTurn('offline', 'x'.repeat(4000)); s.endTurn('offline');
    s.beginManualCompaction('offline');
    const estimate = s.finishManualCompaction('offline');
    expect(estimate).toMatchObject({ beforeTokens: 1000, estimated: true });
    expect(s.finishManualCompaction('offline')?.id).toBe(estimate?.id);
    s.applyContextWindow('offline', 410);
    expect(s.getSessionTelemetry('offline')?.compactions).toMatchObject([{ id: estimate!.id, afterTokens: 410, savedTokens: 590 }]);
    expect(s.getSessionTelemetry('offline')?.compactionCount).toBe(1);
  });

  it('rolls all three views across local midnight while idle, retaining the previous hour and its local label', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 28, 23, 59, 59));
    const { core } = desktop(directory()), s = core.telemetry;
    s.beginTurn('example', 'abcd'); s.endTurn('example');
    const input = { sessionId: 'example', provider: 'local-ollama' as const, endpoint: 'http://127.0.0.1', modelId: 'm', latencyMs: 1 };
    s.recordExternalReviewUsage({ ...input, outcome: 'ask' }); s.recordExternalTranslationUsage({ ...input, outcome: 'success' });
    const pushes: TelemetryDashboardSnapshot[] = [];
    core.on('telemetry-updated', event => pushes.push(event));
    await vi.advanceTimersByTimeAsync(1001);
    const snap = pushes.at(-1)!;
    expect(snap.calendar30d.at(-1)?.date).toBe('2026-03-29');
    expect(snap.costByRange.today.totalTokens).toBe(0);
    expect(snap.hourly24h.at(-2)).toMatchObject({ totalTokens: 1, hourLabel: '23:00' });
    for (const ext of [snap.externalReviewer!, snap.externalTranslator!]) {
      expect(ext.costByRange.today.callCount).toBe(0); expect(ext.costByRange['7d'].callCount).toBe(1);
    }
  });

  it('streams and crash-checkpoints only the changed session, preserving dormant rows and full-token rounding', async () => {
    vi.useFakeTimers();
    const disk = new ClientStore(directory());
    const s = remember(new TelemetryStore({ store: disk }));
    for (let i = 0; i < 320; i++) { s.beginTurn('archived' + i, 'saved'); s.endTurn('archived' + i); }
    s.flush();
    const initial = s.snapshot();
    await vi.advanceTimersByTimeAsync(251);
    const writes = vi.spyOn(disk, 'write');
    s.beginTurn('live', 'x');
    const chunk = '中abc';
    for (let i = 0; i < 2000; i++) s.addChunk('live', chunk);
    const delta = s.snapshot(new Set(['live']));
    expect(Object.keys(delta.activeSessions)).toEqual(['live']);
    expect(delta.activeSessions.live.costSummary.outputTokens).toBe(estimateTokens(chunk.repeat(2000)));
    expect(mergeTelemetryDashboard(initial, delta).activeSessions.archived0).toEqual(initial.activeSessions.archived0);
    await vi.advanceTimersByTimeAsync(251);
    expect(writes.mock.calls.map(([name]) => name)).toHaveLength(1);
    expect(writes.mock.calls[0][0]).toMatch(/^telemetry-stream-/);
    expect(writes.mock.calls[0][1]).toMatchObject({ ids: ['live'] });
    const recovered = remember(new TelemetryStore({ store: disk }));
    expect(recovered.getSessionTelemetry('live')?.costSummary).toEqual(delta.activeSessions.live.costSummary);
    expect(recovered.getSessionTelemetry('archived0')).toBeDefined();
    const beforeDeletion = recovered.snapshot();
    recovered.remove('live');
    expect(mergeTelemetryDashboard(beforeDeletion, recovered.snapshot(new Set(['live']))).activeSessions.live).toBeUndefined();
  });

  it('uses Token bar scales in all three tabs and keeps unfinished rate edits during ordinary telemetry updates', () => {
    const s = remember(new TelemetryStore({ store: new ClientStore(directory()) }));
    const snapshot = s.snapshot();
    const modes = ['context', 'reviewer', 'translator'] as const;
    for (const [i, source] of [snapshot, snapshot.externalReviewer!, snapshot.externalTranslator!].entries()) {
      source.hourly24h.at(-2)!.totalTokens = 100000; source.hourly24h.at(-2)!.costUsd = 1;
      source.hourly24h.at(-1)!.totalTokens = 100000; source.hourly24h.at(-1)!.costUsd = 10;
      const ui = render(<ContextCostInspectorView sessionId="s" dashboard={snapshot} viewMode={modes[i]} onOpenRateCardsSettings={() => {}} />);
      const bars = ui.container.querySelectorAll<HTMLElement>('.hm-bar');
      expect([...bars].slice(-2).map(b => b.style.height)).toEqual(['100%', '100%']);
      expect(ui.container.querySelector('.hm-y-scale')?.textContent).toBe('100k50k0');
      expect(bars[bars.length - 2].title).toContain('$1.00'); expect(bars[bars.length - 1].title).toContain('$10.00');
      ui.unmount();
    }
    const ui = render(<RatesPanel rateCards={snapshot.rateCards} onUpdateRateCards={async () => {}} />);
    const field = ui.getByTestId('rate-default-inputPerMillionUsd') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '77' } });
    ui.rerender(<RatesPanel rateCards={structuredClone(snapshot.rateCards)} onUpdateRateCards={async () => {}} />);
    expect(field.value).toBe('77');
  });

  it('reuses the known checkpoint limit for three subsequent synthetic prompts to the same model', async () => {
    const dir = directory();
    const { core, sessionId } = desktop(dir, 'Antigravity Fixture');
    const root = path.join(dir, 'fixture-home', '.gemini', 'antigravity-cli', 'conversations');
    mkdirSync(root, { recursive: true });
    const dbPath = path.join(root, sessionId + '.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO executor_metadata VALUES (1, ?)').run(Buffer.from('{"max_token_limit":360000}'));
    db.close();
    const snapshotWrite = vi.spyOn(fs, 'writeFile');
    await core.createSession({ cwd: dir });
    await vi.waitFor(() => expect(core.telemetry.getSessionTelemetry(sessionId)?.maxContextTokens).toBe(360000));
    for (let i = 0; i < 3; i++) await core.sendPrompt({ sessionId, text: 'fixture' });
    expect(snapshotWrite.mock.calls.filter(([file]) => String(file).endsWith('session.db'))).toHaveLength(1);
  });
});
