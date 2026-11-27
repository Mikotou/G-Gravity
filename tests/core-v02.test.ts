// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CoreService } from '../src/main/core-service';
import { createCoreBridge, readAllSessionMessages } from './helpers/core-bridge';
import { prepareMockAcp } from './helpers/stdio-rpc';

describe('Gravity v0.2 真内核与标准ACP桩整合', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => { fixture = await prepareMockAcp(); }); afterAll(async () => { await fixture?.cleanup(); });
  function setup(savedLayout?: object) {
    const directory = mkdtempSync(path.join(tmpdir(), 'gravity-qa-core-v02-'));
    if (savedLayout) writeFileSync(path.join(directory, 'layout.json'), JSON.stringify(savedLayout));
    const spawnSpy = vi.fn((_binary, _args, options) => spawn(fixture.executable, fixture.args, options));
    const executor = vi.fn(async () => ({ stdout: '[]' }));
    const core = new CoreService({ dataDir: directory, acpOptions: { spawn: spawnSpy }, pluginsExecutor: executor, homeDir: path.join(directory, 'fake-home') });
    return { core, spawnSpy, cleanup: async () => { await core.dispose(); rmSync(directory, { recursive: true, force: true }); } };
  }
  it('回答写盘失败时保持原提问可见，重试以一次正式答复结束原回合', async () => {
    const { core, cleanup } = setup();
    try {
      const { sessionId } = await core.createSession({ cwd: core.store.dataDir });
      const events: string[] = [];
      let id = '';
      core.on('message-upserted', ({ message }) => {
        if (message.sessionId === sessionId && message.question) {
          id = message.id;
          events.push(message.turnSettledAt ? 'settled' : message.question.state);
        }
      });
      const turn = core.sendPrompt({ sessionId, text: '[question]' });
      await vi.waitFor(() => expect(id).not.toBe(''));
      const save = core.store.write.bind(core.store);
      const failure = vi.spyOn(core.store, 'write').mockImplementation((name, value) => {
        if (name === 'message-index-v2-default.json') throw Error('磁盘忙');
        save(name, value);
      });
      const answer = { sessionId, messageId: id, action: 'accept' as const, values: { color: 'teal' } };
      try { await expect(core.answerQuestion(answer)).rejects.toThrow('磁盘忙'); }
      finally { failure.mockRestore(); }
      expect(events).toEqual(['open']);
      expect((await readAllSessionMessages(core, sessionId)).find(m => m.id === id)?.question?.state).toBe('open');
      await core.answerQuestion(answer);
      await turn;
      expect(events).toEqual(['open', 'answered', 'settled']);
      expect((await readAllSessionMessages(core, sessionId)).find(m => m.id === id)?.question?.state).toBe('answered');
    } finally { await cleanup(); }
  });
  it('完整桥接方法存在，自定义主题导出导入安全、图标与布局持久化', async () => {
    const { core, cleanup } = setup();
    try {
      const bridge = createCoreBridge(core); expect(Object.keys(bridge).length).toBeGreaterThan(50);
      const json = await core.exportCustomTheme(); const custom = JSON.parse(json); custom.tokens.accentPrimary = '#123456';
      const preferences = await core.importCustomTheme(JSON.stringify(custom));
      expect(preferences.theme).toBe('custom'); expect(preferences.customTheme!.tokens.accentPrimary).toBe('#123456');
      await expect(core.importCustomTheme('{"tokens":{"bgApp":"url(https://evil.example)"}}')).rejects.toThrow('非法');
      expect((await core.setAppIcon('gravity-ubuntu')).appIcon).toBe('gravity-ubuntu');
      const layout = await core.saveWorkspaceLayout({ leftSidebarCollapsed: true, rightInspectorWidth: 420, activeInspectorTab: 'context' });
      expect(layout).toMatchObject({ leftSidebarCollapsed: true, rightInspectorWidth: 420, activeInspectorTab: 'context' });
    } finally { await cleanup(); }
  });
  it('四格布局升级为双栏并保留全部标签', async () => {
    const { core, cleanup } = setup({ layoutMode: 'grid-4', openTabSessionIds: ['a', 'b'], activePrimarySessionId: 'a',
      splitSecondarySessionId: 'b', tertiarySessionId: 'c', quaternarySessionId: 'd' });
    try {
      const updated = await core.saveWorkspaceLayout({});
      expect(updated.layoutMode).toBe('split-2');
      expect(updated.openTabSessionIds).toEqual(['a', 'b', 'c', 'd']);
      expect(updated).not.toHaveProperty('tertiarySessionId');
    } finally { await cleanup(); }
  });
  it('无本地副本时合并回放分片，前端全程只收到用户批注', async () => {
    const { core, cleanup } = setup();
    try {
      const { sessionId } = await core.createSession({ cwd: 'F:\\回放测试' });
      await core.closeSession(sessionId);
      const events: string[] = [];
      core.on('message-upserted', ({ message }) => { if (message.role === 'user') events.push(message.content); });
      const origRequest = core.client.request.bind(core.client);
      vi.spyOn(core.client, 'request').mockImplementation(async (method, params, timeoutMs, onLate) => {
        if (method === 'session/load') {
          const chunk = (sessionUpdate: string, text: string) =>
            core.client.emit('session/update', { sessionId, update: { sessionUpdate, content: { type: 'text', text } } });
          chunk('user_message_chunk', 'User-selected passages and comments:\n{"message":"","annotations":[');
          chunk('user_message_chunk', '{"excerpt":"La","comment":"这个词是什么意思？"}]}');
          chunk('agent_message_chunk', '这是一个定冠词。');
          // LoadReplay 必须暂存回放分片，在 session/load 确认成功前不向前端外发
          expect(events).toEqual([]);
          return { sessionId };
        }
        return origRequest(method, params, timeoutMs, onLate);
      });
      await core.resumeSession(sessionId, 'F:\\回放测试');
      expect(events).toEqual(['']);
      const msgs = await readAllSessionMessages(core, sessionId);
      expect(msgs[0].annotations?.[0]).toMatchObject({
        id: expect.stringMatching(/^ann-legacy-1-/),
        excerpt: 'La',
        comment: '这个词是什么意思？',
      });
    } finally { await cleanup(); }
  });
  it('重新打开旧额度页时保留侧栏尺寸并进入上下文页', async () => {
    const { core, cleanup } = setup({ activeInspectorTab: 'quota', rightInspectorWidth: 405 });
    try {
      const saved = await core.saveWorkspaceLayout({ leftSidebarCollapsed: true });
      expect(saved).toMatchObject({ activeInspectorTab: 'context', rightInspectorWidth: 405 });
    } finally { await cleanup(); }
  });
});
