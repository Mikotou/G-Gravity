// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareMockAcp, StdioRpc } from './helpers/stdio-rpc';

describe('ACP 桩真实子进程协议自检', () => {
  let rpc: StdioRpc;
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => {
    fixture = await prepareMockAcp();
    rpc = new StdioRpc(fixture.executable, fixture.args);
  });
  afterAll(async () => { await rpc?.close(); await fixture?.cleanup(); });
  const create = async (cwd: string) => (await rpc.request('session/new', { cwd, mcpServers: [] })).sessionId as string;
  const prompt = (sessionId: string, text: string) => rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

  it('initialize 返回能力；未知方法返回标准错误', async () => {
    const result = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'qa', version: '1' } });
    expect(result.protocolVersion).toBe(1);
    expect(result.agentCapabilities.sessionCapabilities).toHaveProperty('resume');
    await expect(rpc.request('unknown/method')).rejects.toThrow('-32601');
  });
  it('同一 PID 四会话并发，正文和思考严格携带各自 sessionId', async () => {
    const pid = rpc.child.pid;
    const ids = await Promise.all([0, 1, 2, 3].map((n) => create(`F:\\测试${n}`)));
    expect(new Set(ids).size).toBe(4);
    const results = await Promise.all(ids.map((id) => prompt(id, '[swarm]')));
    expect(results.map((result) => result.stopReason)).toEqual(Array(4).fill('end_turn'));
    for (const id of ids) {
      const updates = rpc.messages.filter((message) => message.method === 'session/update' && message.params.sessionId === id).map((message) => message.params.update);
      expect(updates.filter((update) => update.sessionUpdate === 'agent_thought_chunk')).toHaveLength(2);
      const text = updates.filter((update) => update.sessionUpdate === 'agent_message_chunk').map((update) => update.content.text).join('');
      expect(text).toContain(id);
      for (const other of ids.filter((value) => value !== id)) expect(text).not.toContain(other);
      expect(updates.filter((update) => update.sessionUpdate === 'tool_call').map((update) => update.title)).toEqual(['swarm', 'post_message']);
    }
    expect(rpc.child.pid).toBe(pid);
    expect((await rpc.request('session/list')).sessions).toHaveLength(4);
  });
  it('权限双向请求挂起生成，收到指定 optionId 后才完成', async () => {
    const id = await create('F:\\审批');
    const run = prompt(id, '[permission] git status');
    let settled = false;
    void run.then(() => { settled = true; });
    const permission = await rpc.waitFor((message) => message.method === 'session/request_permission' && message.params.sessionId === id);
    expect(settled).toBe(false);
    expect(permission.params.options.map((option: any) => option.kind)).toContain('allow_once');
    rpc.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
    expect((await run).stopReason).toBe('end_turn');
    expect(rpc.messages.some((message) => message.params?.sessionId === id && message.params?.update?.content?.text?.includes('allow-once'))).toBe(true);
  });
  it('单会话取消不影响另一会话；取消后可恢复并继续', async () => {
    const cancelled = await create('F:\\取消');
    const healthy = await create('F:\\正常');
    const a = prompt(cancelled, '[slow]');
    const b = prompt(healthy, '[slow]');
    await rpc.waitFor((message) => message.params?.sessionId === cancelled && message.params.update.sessionUpdate === 'agent_thought_chunk');
    rpc.notify('session/cancel', { sessionId: cancelled });
    expect((await a).stopReason).toBe('cancelled');
    expect((await b).stopReason).toBe('end_turn');
    expect(await rpc.request('session/resume', { sessionId: cancelled, cwd: 'F:\\取消', mcpServers: [] })).toHaveProperty('sessionId', cancelled);
    expect((await prompt(cancelled, '继续')).stopReason).toBe('end_turn');
  });
  it('关闭会话后无法继续生成；EOF 回收子进程', async () => {
    const id = await create('F:\\关闭');
    await rpc.request('session/close', { sessionId: id });
    await expect(prompt(id, '继续')).rejects.toThrow('-32001');
    await rpc.close();
    expect(rpc.child.exitCode).toBe(0);
  });
});
