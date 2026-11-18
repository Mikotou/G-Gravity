// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CoreService } from '../src/main/core-service';
import { createCoreBridge } from './helpers/core-bridge';
import { createHistoryFixture, snapshotHistoryTree } from './helpers/history-fixture';
import { prepareMockAcp } from './helpers/stdio-rpc';

describe('Gravity v0.2 真内核与标准ACP桩整合', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => { fixture = await prepareMockAcp(); }); afterAll(async () => { await fixture?.cleanup(); });
  function setup(historyRoots: string[] = [], savedLayout?: object) {
    const directory = mkdtempSync(path.join(tmpdir(), 'gravity-qa-core-v02-'));
    if (savedLayout) writeFileSync(path.join(directory, 'layout.json'), JSON.stringify(savedLayout));
    const spawnSpy = vi.fn((_binary, _args, options) => spawn(fixture.executable, fixture.args, options));
    const executor = vi.fn(async () => ({ stdout: '[]' }));
    const core = new CoreService({ dataDir: directory, acpOptions: { spawn: spawnSpy }, historyRoots, pluginsExecutor: executor, homeDir: path.join(directory, 'fake-home') });
    return { core, spawnSpy, cleanup: async () => { await core.dispose(); rmSync(directory, { recursive: true, force: true }); } };
  }
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
    const { core, cleanup } = setup([], { layoutMode: 'grid-4', openTabSessionIds: ['a', 'b'], activePrimarySessionId: 'a',
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
      vi.spyOn(core.sessions, 'isResuming').mockReturnValue(true);
      const events: string[] = [];
      core.on('message-upserted', ({ message }) => { if (message.role === 'user') events.push(message.content); });
      const chunk = (sessionUpdate: string, text: string) => core.sessions.emit('update', { sessionId, update: { sessionUpdate, content: { type: 'text', text } } });
      chunk('user_message_chunk', 'User-selected passages and comments:\n{"message":"","annotations":[');
      chunk('user_message_chunk', '{"excerpt":"La","comment":"这个词是什么意思？"}]}');
      expect(events).toEqual([]);
      chunk('agent_message_chunk', '这是一个定冠词。');
      expect(events).toEqual(['']);
      expect((await core.getSessionMessages(sessionId))[0].annotations?.[0].comment).toBe('这个词是什么意思？');
    } finally { await cleanup(); }
  });
  it('重新打开旧额度页时保留侧栏尺寸并进入上下文页', async () => {
    const { core, cleanup } = setup([], { activeInspectorTab: 'quota', rightInspectorWidth: 405 });
    try {
      const saved = await core.saveWorkspaceLayout({ leftSidebarCollapsed: true });
      expect(saved).toMatchObject({ activeInspectorTab: 'context', rightInspectorWidth: 405 });
    } finally { await cleanup(); }
  });
  it('本地历史继续创建新ACP会话带入摘要，源树前后完全不变', async () => {
    const history = createHistoryFixture(); const { core, spawnSpy, cleanup } = setup([history.root]);
    try {
      const before = snapshotHistoryTree(history.root); const records = await core.listImportedHistory();
      const target = records.find((record) => record.title === '只读历史测试')!;
      const continued = await core.continueHistoryInGravity({ importedSessionId: target.sessionId, targetCwd: 'F:\\历史续聊' });
      expect(continued.sessionId).not.toBe(target.sessionId); expect(continued.originKind).toBe('acp-live'); expect(continued.readOnly).toBe(false);
      const messages = await core.getSessionMessages(continued.sessionId);
      expect(messages.find((message) => message.role === 'user')!.content).toContain('测试合成会话摘要');
      expect(spawnSpy).toHaveBeenCalledTimes(1); expect(snapshotHistoryTree(history.root)).toEqual(before);
      expect(core.history.getDetail(target.sessionId).readOnly).toBe(true);
    } finally { await cleanup(); rmSync(history.directory, { recursive: true, force: true }); }
  });
});
