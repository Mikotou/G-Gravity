// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AcpClient, validateAgyArgs } from '../src/main/acp/acp-client';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { FORBIDDEN_AGY_FLAGS } from '../src/shared';
import { prepareMockAcp } from './helpers/stdio-rpc';

describe('业务 ACP 宿主与真实桩进程联调', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => { fixture = await prepareMockAcp(); });
  afterAll(async () => { await fixture?.cleanup(); });
  const setup = () => {
    const children: ChildProcess[] = [];
    const spawnSpy = vi.fn((_binary, _args, options) => {
      const child = spawn(fixture.executable, fixture.args, options);
      children.push(child); return child;
    });
    const client = new AcpClient({ spawn: spawnSpy, requestTimeoutMs: 1000 });
    const sessions = new SessionMultiplexer(client);
    return { client, sessions, spawnSpy, children };
  };
  const prompt = (sessions: SessionMultiplexer, sessionId: string, text: string) => sessions.sendPrompt({ sessionId, prompt: [{ type: 'text', text }] });

  it('并发创建四会话仅启动一次；第五会话被容量预留拦截', async () => {
    const { client, sessions, spawnSpy } = setup();
    try {
      const created = await Promise.all([1, 2, 3, 4].map((n) => sessions.createSession({ cwd: `F:\\测试${n}` })));
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0][1]).toEqual(['acp']);
      expect(sessions.activeSessionCount).toBe(4);
      await expect(sessions.createSession({ cwd: 'F:\\第五' })).rejects.toThrow('4');
      const updates: any[] = [];
      sessions.on('update', (event) => updates.push(event));
      await Promise.all(created.map((session) => prompt(sessions, session.sessionId, '[swarm]')));
      for (const session of created) {
        const own = updates.filter((event) => event.sessionId === session.sessionId);
        expect(own.filter((event) => event.update.sessionUpdate === 'agent_thought_chunk')).toHaveLength(2);
        expect(own.filter((event) => event.update.sessionUpdate === 'agent_message_chunk')).toHaveLength(2);
        expect(sessions.get(session.sessionId).status).toBe('idle');
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally { await client.stop(); }
  });
  it('挂起一个权限请求时其余会话继续；审批应答不新增进程', async () => {
    const { client, sessions, spawnSpy } = setup();
    let release: ((value: unknown) => void) | undefined;
    const requested = new Promise<any>((resolve) => {
      client.registerRequestHandler('session/request_permission', (params) => {
        resolve(params); return new Promise((done) => { release = done; });
      });
    });
    try {
      const [a, b] = await Promise.all([1, 2].map((n) => sessions.createSession({ cwd: `F:\\权限${n}` })));
      const pending = prompt(sessions, a.sessionId, '[permission] git status');
      expect((await requested).sessionId).toBe(a.sessionId);
      expect(sessions.isBusy(a.sessionId)).toBe(true);
      expect((await prompt(sessions, b.sessionId, '普通生成')).stopReason).toBe('end_turn');
      expect(sessions.isBusy(a.sessionId)).toBe(true);
      release!({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      expect((await pending).stopReason).toBe('end_turn');
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally { await client.stop(); }
  });
  it('取消只影响指定会话；关闭释放槽位且可恢复', async () => {
    const { client, sessions } = setup();
    try {
      const a = await sessions.createSession({ cwd: 'F:\\会话A' });
      const b = await sessions.createSession({ cwd: 'F:\\会话B' });
      const started = once(sessions, 'update');
      const first = prompt(sessions, a.sessionId, '[slow]');
      const second = prompt(sessions, b.sessionId, '[slow]');
      await started;
      await sessions.cancelPrompt(a.sessionId);
      expect((await first).stopReason).toBe('cancelled');
      expect((await second).stopReason).toBe('end_turn');
      await sessions.closeSession(a.sessionId);
      expect(sessions.activeSessionCount).toBe(1);
      expect(sessions.get(a.sessionId).status).toBe('closed');
      await sessions.resumeSession(a.sessionId, a.cwd);
      expect(sessions.activeSessionCount).toBe(2);
      expect((await prompt(sessions, a.sessionId, '继续')).stopReason).toBe('end_turn');
    } finally { await client.stop(); }
  });
  it('停止宿主会真实回收所属桩子进程并清空活动槽位', async () => {
    const { client, sessions, children } = setup();
    try {
      await sessions.createSession({ cwd: 'F:\\回收' });
      const exited = once(children[0], 'exit');
      await client.stop();
      await exited;
      expect(children[0].exitCode).toBe(0);
      expect(client.connected).toBe(false);
      expect(sessions.activeSessionCount).toBe(0);
    } finally { await client.stop(); }
  });
});

describe('官方参数安全边界', () => {
  it.each(FORBIDDEN_AGY_FLAGS)('阻断 %s 及等号传值', (flag) => {
    expect(() => validateAgyArgs(['acp', flag])).toThrow();
    expect(() => validateAgyArgs(['acp', `${flag}=true`])).toThrow();
  });
  it.each([[], ['chat'], ['acp', '--worker'], ['acp', '--unknown'], ['acp', '--agent'], ['acp', '--add-dir', '--login'], ['acp', '--stdio=true']].map((args) => ({ args })))('拒绝未批准或错误参数 $args', ({ args }) => {
    expect(() => validateAgyArgs(args)).toThrow();
  });
  it('允许标准单进程与受支持隔离选项', () => {
    expect(validateAgyArgs(['acp', '--stdio', '--process-per-session', '--sandbox', '--add-dir', 'F:\\测试', '--agent', 'reviewer']))
      .toEqual(['acp', '--stdio', '--process-per-session', '--sandbox', '--add-dir', 'F:\\测试', '--agent', 'reviewer']);
  });
});
