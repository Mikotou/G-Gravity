// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { ClientStore } from '../src/main/storage/client-store';
import { SwarmTranslator } from '../src/main/translation/swarm-translator';

class SwarmProvider extends AcpClient {
  members = new Map<string, { workerId: string; proof: string }>();
  texts = new Map<string, string[]>();
  loads = 0;
  badProof = false;
  skipAdd = false;
  override async request<T>(method: string, raw?: unknown): Promise<T> {
    const { sessionId, prompt } = raw as { sessionId: string; prompt?: { text: string }[] };
    const emit = (update: object) => this.emit('session/update', { sessionId, update });
    const content = (text: string) => emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    if (method === 'session/load') {
      this.loads++;
      const member = [...this.members.values()].find(m => m.workerId === sessionId)!;
      emit({ sessionUpdate: 'tool_call', name: 'post_message', status: 'completed', rawInput: { text: this.badProof ? 'unrelated' : member.proof } });
      return {} as T;
    }
    if (method !== 'session/prompt' || !prompt) throw new Error('Unexpected method ' + method);
    const instruction = prompt[0].text;
    const marker = /gravity-ready-[a-f0-9-]{36}/.exec(instruction)?.[0];
    if (marker) {
      const binding = { workerId: randomUUID(), proof: marker };
      this.members.set(sessionId, binding);
      if (!this.skipAdd) {
        emit({ sessionUpdate: 'tool_call', toolCallId: 'add', name: 'swarm', status: 'in_progress',
          rawInput: { action: 'add', name: 'thought-translator', brief: marker } });
        emit({ sessionUpdate: 'tool_call_update', toolCallId: 'add', status: 'completed' });
      }
      content(JSON.stringify({ workerId: binding.workerId }));
    } else {
      const text = JSON.parse(instruction.slice(instruction.indexOf('\n') + 1)) as string;
      const entries = this.texts.get(sessionId) || [];
      entries.push(text);
      this.texts.set(sessionId, entries);
      await Promise.resolve();
      content('译：'); content(text);
    }
    return { stopReason: 'end_turn' } as T;
  }
}

describe('由主模型建立并按父会话隔离的蜂群翻译', () => {
  let directory: string;
  let provider: SwarmProvider;
  let store: ClientStore;
  let translator: SwarmTranslator;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'gravity-worker-test-'));
    provider = new SwarmProvider();
    store = new ClientStore(directory);
    translator = new SwarmTranslator(provider, store, () => false);
    translator.setProfile('default');
  });
  afterEach(() => { translator.reset(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
  it('四个父会话交错接收译文，每个成员按自己的次序翻译，没有额外顶层会话', async () => {
    const parents = ['p1', 'p2', 'p3', 'p4'];
    const reports = vi.fn();
    await Promise.all(parents.flatMap(id => [translator.start(id, directory, reports), translator.start(id, directory, reports)]));
    expect(reports).toHaveBeenCalledTimes(4);
    const turns = parents.flatMap(id => ['first', 'second'].map(tag => [id, id + ' ' + tag]));
    let lastDelta = '';
    const translated = await Promise.all(turns.map(([id, text]) => translator.translate(id, text, delta => { lastDelta = delta; })));
    expect(translated).toEqual(turns.map(([, text]) => '译：' + text));
    expect(lastDelta).toContain('译：');
    for (const id of parents) expect(provider.texts.get(provider.members.get(id)!.workerId)).toEqual([id + ' first', id + ' second']);
  });
  it('重启后重用已核对的子成员，手动切换 Profile 后旧成员无权接收分片', async () => {
    await translator.start('p', directory, vi.fn());
    const id = provider.members.get('p')!.workerId;
    const again = new SwarmTranslator(provider, store, () => false);
    again.setProfile('default');
    await again.start('p', directory, vi.fn());
    expect(provider.members.get('p')!.workerId).toBe(id);
    expect(provider.loads).toBe(2);
    again.setProfile('profile-two');
    expect(await again.translate('p', 'private new text')).toBe('');
    expect(provider.texts.size).toBe(0);
  });
  it('仅有模型文本中的成员 ID 时不发送原文', async () => {
    provider.skipAdd = true;
    const report = vi.fn();
    await translator.start('p', directory, report);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('暂不可用'));
    expect(await translator.translate('p', 'sample')).toBe('');
    expect(provider.loads).toBe(0);
  });
  it('成员的就绪标记不匹配时保留原文', async () => {
    provider.badProof = true;
    const report = vi.fn();
    await translator.start('p', directory, report);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('未能从成员'));
    expect(await translator.translate('p', 'sample')).toBe('');
    expect(provider.texts.size).toBe(0);
  });
  it('取消翻译会丢弃已排队的片段', async () => {
    await translator.start('p', directory, vi.fn());
    const pending = translator.translate('p', 'cancelled');
    translator.cancelTurn('p');
    expect(await pending).toBe('');
    expect(provider.texts.size).toBe(0);
  });
});
