// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountManager } from '../src/main/accounts/account-manager';
import { AcpClient } from '../src/main/acp/acp-client';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { ClientStore } from '../src/main/storage/client-store';
import { CoreService } from '../src/main/core-service';
import { readAllSessionMessages } from './helpers/core-bridge';
import { prepareMockAcp } from './helpers/stdio-rpc';

describe('手动 Profile 切换与零自动轮换', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => { fixture = await prepareMockAcp(); });
  afterAll(async () => { await fixture?.cleanup(); });
  function setup() {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-qa-account-')); const store = new ClientStore(dataDir);
    const spawnSpy = vi.fn((_binary, _args, options) => spawn(fixture.executable, fixture.args, options));
    const login = vi.fn().mockResolvedValue(undefined);
    const client = new AcpClient({ spawn: spawnSpy, loginLauncher: login }); const sessions = new SessionMultiplexer(client);
    const accounts = new AccountManager({ store, client, sessions });
    return { dataDir, store, client, sessions, accounts, spawnSpy, login, cleanup: async () => { await client.stop(); rmSync(dataDir, { recursive: true, force: true }); } };
  }
  it('保存资料失败时不发布临时增删，重试后内存和重新打开的清单一致', async () => {
    const test = setup();
    try {
      const updates = vi.fn();
      test.accounts.on('updated', updates);
      const failNextSave = () => vi.spyOn(test.store, 'write').mockImplementationOnce(() => { throw Error('磁盘忙'); });
      const before = test.accounts.getState().profiles;
      failNextSave();
      expect(() => test.accounts.createProfile({ name: '备用' })).toThrow('磁盘忙');
      expect(test.accounts.getState().profiles).toEqual(before);
      expect(updates).not.toHaveBeenCalled();
      const created = test.accounts.createProfile({ name: '备用' }).profiles;
      const profile = created.find(item => !item.isDefault)!;
      expect(created).toHaveLength(2);
      failNextSave();
      expect(() => test.accounts.deleteProfile(profile.profileId)).toThrow('磁盘忙');
      expect(test.accounts.getState().profiles).toEqual(created);
      const reopened = new AccountManager({ store: test.store, client: test.client, sessions: test.sessions });
      expect(reopened.getState().profiles.map(p => p.profileId)).toContain(profile.profileId);
      expect(test.accounts.deleteProfile(profile.profileId).profiles).toHaveLength(1);
      expect(updates).toHaveBeenCalledTimes(2);
    } finally { await test.cleanup(); }
  });
  it('切换资料保存失败时保留原账号及其会话归属，重试才连接新账号', async () => {
    const test = setup();
    try {
      const profile = test.accounts.createProfile({ name: '其他账号' }).profiles.find(item => !item.isDefault)!;
      const fail = vi.spyOn(test.store, 'write').mockImplementationOnce(() => { throw Error('暂时无法保存'); });
      try { await expect(test.accounts.switchProfile(profile.profileId)).rejects.toThrow('暂时无法保存'); }
      finally { fail.mockRestore(); }
      expect(test.accounts.activeProfileId).toBe('default');
      expect(test.sessions.profileId).toBe('default');
      expect(test.accounts.getState().profiles.find(item => item.profileId === profile.profileId)).toEqual(profile);
      expect(test.spawnSpy).not.toHaveBeenCalled();
      await test.accounts.switchProfile(profile.profileId);
      expect(test.sessions.profileId).toBe(profile.profileId);
      expect(test.spawnSpy).toHaveBeenCalledTimes(1);
    } finally { await test.cleanup(); }
  });
  it('切换资料的读取或写盘失败时同号会话仍完全属于原账号，重试才一起显示新账号的数据', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-profile-staging-'));
    const core = new CoreService({ dataDir, acpOptions: { spawn: (_binary, _args, options) => spawn(fixture.executable, fixture.args, options) } });
    try {
      const second = (await core.createAccountProfile({ name: 'Other' })).profiles.find(p => !p.isDefault)!;
      async function populate(label: string, calls: number) {
        const { sessionId } = await core.createSession({ cwd: dataDir, title: label });
        await core.sendPrompt({ sessionId, text: label });
        core.inspector.consume(sessionId, { sessionUpdate: 'plan', entries: [{ content: label }] });
        core.swarm.consume(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: `post-${label}`,
          name: 'post_message',
          status: 'completed',
          rawInput: { sender: 'lead', content: label },
        });
        for (let n = 0; n < calls; n++) core.telemetry.recordExternalTranslationUsage({
          sessionId, provider: 'local-ollama', endpoint: 'http://127.0.0.1', modelId: 'fixture', latencyMs: 1, outcome: 'success',
        });
        return sessionId;
      }
      const id = await populate('sample A', 1);
      await core.updateApprovalConfig({ mode: 'manual' });
      const request = core.approval.requestPermission({
        sessionId: id, toolCall: { toolCallId: 'remember', title: 'run_command', rawInput: { command: 'npm test' } },
        options: [{ optionId: 'once', kind: 'allow_once', name: '一次' }],
      }, dataDir);
      const card = core.approval.listAwaitingUser()[0];
      await core.approval.submitDecision({ sessionId: id, requestId: card.requestId, decision: 'allow_session_prefix', allowedPrefix: card.commandPrefix });
      await request;
      await core.switchAccountProfile(second.profileId);
      expect(await populate('sample B', 2)).toBe(id);
      await core.switchAccountProfile('default');
      async function checkSide(isDefault: boolean) {
        const selected = isDefault ? 'default' : second.profileId;
        const label = isDefault ? 'sample A' : 'sample B';
        expect((await core.getAccountsState()).activeProfileId).toBe(selected);
        expect(core.getPreferences().activeProfileId).toBe(selected);
        expect(core.sessions.get(id).title).toBe(label);
        expect((await readAllSessionMessages(core, id))[0].content).toBe(label);
        expect((await core.getSessionInspector(id)).todos[0].content).toBe(label);
        expect((await core.getSwarmState(id)).boardMessages[0].content).toBe(label);
        expect((await core.getTelemetryDashboard()).externalTranslator?.bySession[id].callCount).toBe(isDefault ? 1 : 2);
        expect(core.approval.hasSessionGrants(id, dataDir)).toBe(isDefault);
        expect(core.store.read('profiles.json', { activeProfileId: '' }).activeProfileId).toBe(selected);
      }
      for (const file of ['preferences.json', 'layout.json', 'profiles.json']) {
        const write = core.store.write.bind(core.store);
        const failed = vi.spyOn(core.store, 'write').mockImplementation((name, value) => {
          if (name === file) throw Error('暂时无法写入 ' + file);
          write(name, value);
        });
        try { await expect(core.switchAccountProfile(second.profileId)).rejects.toThrow(file); }
        finally { failed.mockRestore(); }
        await checkSide(true);
      }
      const unavailable = vi.spyOn(core.store, 'readSessionRecords').mockImplementationOnce(() => { throw Error('资料暂时不可读'); });
      try { await expect(core.switchAccountProfile(second.profileId)).rejects.toThrow('资料暂时不可读'); }
      finally { unavailable.mockRestore(); }
      await checkSide(true);
      const handshake = vi.spyOn(core.client, 'start').mockRejectedValueOnce(Error('握手中断'));
      try { await expect(core.switchAccountProfile(second.profileId)).rejects.toThrow('握手中断'); }
      finally { handshake.mockRestore(); }
      expect(core.client.connected).toBe(false);
      await checkSide(false);
      await core.switchAccountProfile(second.profileId);
      expect(core.client.connected).toBe(true);
      await checkSide(false);
    } finally { await core.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  it('仅手动切换才重启连接，隔离目录作为官方 --app-data-dir 参数', async () => {
    const test = setup();
    try {
      await test.client.start();
      const profile = test.accounts.createProfile({ name: '第二账号' }).profiles.find((item) => !item.isDefault)!;
      expect(profile.isolatedAppDataDir!.startsWith(path.join(realpathSync.native(test.dataDir), 'profiles') + path.sep)).toBe(true);
      expect(test.spawnSpy).toHaveBeenCalledTimes(1);
      await test.accounts.switchProfile(profile.profileId);
      expect(test.accounts.activeProfileId).toBe(profile.profileId); expect(test.sessions.profileId).toBe(profile.profileId);
      expect(test.spawnSpy).toHaveBeenCalledTimes(2);
      expect(test.spawnSpy.mock.calls[1][1]).toEqual(['acp', '--app-data-dir', profile.isolatedAppDataDir]);
      expect(test.spawnSpy.mock.calls[1][2]).toMatchObject({ shell: false });
      await test.accounts.switchProfile('default');
      expect(test.spawnSpy.mock.calls[2][1]).toEqual(['acp']);
    } finally { await test.cleanup(); }
  });
  it.each([429, 403])('遇到 %s 不改变活动 Profile、不新建连接、不轮换登录', async (status) => {
    const test = setup();
    try {
      const target = test.accounts.createProfile({ name: '备用（手动）' }).profiles.find((item) => !item.isDefault)!;
      await test.accounts.switchProfile(target.profileId);
      const before = readFileSync(path.join(test.dataDir, 'profiles.json'), 'utf8');
      await expect(test.client.request('test/rate_limit', { status })).rejects.toThrow('熔断');
      await expect(test.client.request('session/list')).rejects.toThrow('暂停连续请求');
      await new Promise((resolve) => setImmediate(resolve));
      expect(test.accounts.activeProfileId).toBe(target.profileId); expect(test.spawnSpy).toHaveBeenCalledTimes(1);
      expect(test.login).not.toHaveBeenCalled(); expect(readFileSync(path.join(test.dataDir, 'profiles.json'), 'utf8')).toBe(before);
    } finally { await test.cleanup(); }
  });
  it('删除条目只改客户端元数据，保留由官方管理的隔离目录', async () => {
    const test = setup();
    try {
      const profile = test.accounts.createProfile({ name: '已退出' }).profiles.find((item) => !item.isDefault)!;
      const decoyPath = path.join(profile.isolatedAppDataDir!, 'oauth_token.json');
      writeFileSync(decoyPath, 'synthetic-test-only'); test.accounts.deleteProfile(profile.profileId);
      expect(existsSync(decoyPath)).toBe(true);
      expect(test.accounts.getState().profiles.some((item) => item.profileId === profile.profileId)).toBe(false);
      expect(() => test.accounts.deleteProfile('default')).toThrow('默认');
    } finally { await test.cleanup(); }
  });
  it('切换及冷启动均按当前 Profile 载入会话、消息与面板，即使服务端复用了会话 ID', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-account-restart-'));
    const create = () => new CoreService({ dataDir, acpOptions: { spawn: (_binary, _args, options) => spawn(fixture.executable, fixture.args, options) } });
    let core = create();
    try {
      const first = await core.createSession({ cwd: process.cwd(), title: 'default-only' });
      await core.sendPrompt({ sessionId: first.sessionId, text: '[swarm] default record' });
      const costBeforeSwitch = core.telemetry.getSessionTelemetry(first.sessionId)!.costSummary;
      core.telemetry.recordExternalTranslationUsage({ sessionId: first.sessionId, provider: 'local-ollama', endpoint: 'http://127.0.0.1', modelId: 'local', latencyMs: 1, outcome: 'success' });
      const account = (await core.createAccountProfile({ name: 'Other' })).profiles.find(p => !p.isDefault)!;
      await core.switchAccountProfile(account.profileId);
      const second = await core.createSession({ cwd: process.cwd(), title: 'other-only' });
      expect(second.sessionId).toBe(first.sessionId);
      expect(core.telemetry.getSessionTelemetry(second.sessionId)?.costSummary.totalTokens).toBe(0);
      expect((await core.getTelemetryDashboard()).externalTranslator?.bySession[second.sessionId]).toBeUndefined();
      core.telemetry.recordExternalReviewUsage({ sessionId: first.sessionId, provider: 'local-ollama', endpoint: 'http://127.0.0.1', modelId: 'local', latencyMs: 1, outcome: 'ask' }, 'default');
      expect((await core.getTelemetryDashboard()).externalReviewer?.bySession[second.sessionId]).toBeUndefined();
      expect((await core.getSwarmState(second.sessionId)).workers).toEqual([]);
      await core.sendPrompt({ sessionId: second.sessionId, text: 'other record' });
      await core.dispose();
      core = create();
      const boot = await core.getBootstrap();
      expect(boot.accounts.activeProfileId).toBe(account.profileId);
      expect(boot.sessions.map(s => s.title)).toEqual(['other-only']);
      expect((await readAllSessionMessages(core, second.sessionId))[0].content).toBe('other record');
      expect((await core.getSwarmState(second.sessionId)).workers).toEqual([]);
      await core.switchAccountProfile('default');
      expect(core.telemetry.getSessionTelemetry(first.sessionId)?.costSummary).toEqual(costBeforeSwitch);
      expect((await core.getTelemetryDashboard()).externalTranslator?.bySession[first.sessionId].callCount).toBe(1);
      expect((await core.getTelemetryDashboard()).externalReviewer?.bySession[first.sessionId].callCount).toBe(1);
      expect((await core.getSwarmState(first.sessionId)).workers.length).toBeGreaterThan(0);
      expect((await readAllSessionMessages(core, first.sessionId))[0].content).toContain('default record');
    } finally { await core.dispose(); rmSync(dataDir, { recursive: true, force: true }); }
  });
  it('官方登录仅传隔离参数，官方登出使用 ACP auth/logout', async () => {
    const test = setup();
    try {
      const profile = test.accounts.createProfile({ name: '登录目标' }).profiles.find((item) => !item.isDefault)!;
      await test.accounts.switchProfile(profile.profileId); await test.accounts.login();
      expect(test.login.mock.calls[0][1]).toEqual(['acp', '--app-data-dir', profile.isolatedAppDataDir, '--login']);
      expect(test.spawnSpy).toHaveBeenCalledTimes(1);
      await test.client.start(); expect((await test.accounts.logout()).loggedOut).toBe(true);
      expect(test.client.connected).toBe(false);
    } finally { await test.cleanup(); }
  });
});
