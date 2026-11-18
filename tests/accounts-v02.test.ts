// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountManager } from '../src/main/accounts/account-manager';
import { AcpClient } from '../src/main/acp/acp-client';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { ClientStore } from '../src/main/storage/client-store';
import { CoreService } from '../src/main/core-service';
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
  it('仅手动切换才重启连接，隔离目录作为官方 --app-data-dir 参数', async () => {
    const test = setup();
    try {
      await test.client.start();
      const profile = test.accounts.createProfile({ name: '第二账号' }).profiles.find((item) => !item.isDefault)!;
      expect(profile.isolatedAppDataDir!.startsWith(path.join(test.dataDir, 'profiles') + path.sep)).toBe(true);
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
      const account = (await core.createAccountProfile({ name: 'Other' })).profiles.find(p => !p.isDefault)!;
      await core.switchAccountProfile(account.profileId);
      const second = await core.createSession({ cwd: process.cwd(), title: 'other-only' });
      expect(second.sessionId).toBe(first.sessionId);
      expect((await core.getSwarmState(second.sessionId)).workers).toEqual([]);
      await core.sendPrompt({ sessionId: second.sessionId, text: 'other record' });
      await core.dispose();
      core = create();
      const boot = await core.getBootstrap();
      expect(boot.accounts.activeProfileId).toBe(account.profileId);
      expect(boot.sessions.map(s => s.title)).toEqual(['other-only']);
      expect((await core.getSessionMessages(second.sessionId))[0].content).toBe('other record');
      expect((await core.getSwarmState(second.sessionId)).workers).toEqual([]);
      await core.switchAccountProfile('default');
      expect((await core.getSwarmState(first.sessionId)).workers.length).toBeGreaterThan(0);
      expect((await core.getSessionMessages(first.sessionId))[0].content).toContain('default record');
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
