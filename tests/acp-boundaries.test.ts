// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { callIndependentModel } from '../src/main/approval/external-reviewer';

class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); pid = undefined;
  sent: any[] = []; killed = false;
  stdin = new Writable({ write: (chunk, _encoding, done) => {
    const message = JSON.parse(chunk.toString()); this.sent.push(message);
    if (message.method === 'initialize') queueMicrotask(() => this.emitMessage({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: '桩', version: '1' } } }));
    done();
  } });
  constructor() { super(); this.stdin.on('finish', () => setImmediate(() => this.emit('close', 0))); }
  emitMessage(message: unknown) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill() { this.killed = true; setImmediate(() => this.emit('close', 0)); return true; }
}
afterEach(() => vi.restoreAllMocks());

describe('ACP 分片解析、协议恢复和熔断', () => {
  it('断开的旧进程即使继续报告数据或错误也不影响新连接', async () => {
    const oldChild = new FakeChild();
    const current = new FakeChild();
    const client = new AcpClient({ spawn: vi.fn().mockReturnValueOnce(oldChild).mockReturnValueOnce(current) });
    await client.start();
    await client.stop();
    try {
      await client.start();
      const update = vi.fn();
      client.on('session/update', update);
      oldChild.emitMessage({ jsonrpc: '2.0', method: 'session/update', params: {} });
      oldChild.stdin.emit('error', new Error('old input closed'));
      oldChild.emit('error', new Error('old process exited'));
      expect(update).not.toHaveBeenCalled();
      expect(client.connected).toBe(true);
      expect(current.killed).toBe(false);
    } finally { await client.stop(); }
  });
  it('并发返回的较短冷却不会覆盖仍然生效的较长冷却', async () => {
    let now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const child = new FakeChild();
    const client = new AcpClient({ spawn: () => child });
    try {
      await client.start();
      const first = client.request('session/list').catch(() => {});
      const second = client.request('session/list').catch(() => {});
      const [a, b] = child.sent.slice(-2);
      child.emitMessage({ jsonrpc: '2.0', id: a.id, error: { code: 403, message: 'permission denied' } });
      child.emitMessage({ jsonrpc: '2.0', id: b.id, error: { code: 429, message: 'retry later' } });
      await Promise.all([first, second]);
      now += 61000;
      await expect(client.request('session/list')).rejects.toThrow('暂停连续请求');
    } finally { await client.stop(); }
  });
  it('跨 UTF-8 字节分片及多个消息粘连均保持原文，不被坏 JSON 中断', async () => {
    const child = new FakeChild(); const client = new AcpClient({ spawn: () => child });
    try {
      await client.start();
      const updates: any[] = []; const errors: string[] = [];
      client.on('session/update', (event) => updates.push(event)); client.on('protocolError', (error) => errors.push(error));
      const event = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'a', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '中文😀完整分片' } } } };
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      child.stdout.write(`invalid-json\n${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
      expect(updates).toHaveLength(3); expect(errors).toHaveLength(1);
      expect(updates.every((update) => update.update.content.text === '中文😀完整分片')).toBe(true);
    } finally { await client.stop(); }
  });
  it('无处理器的双向请求返回 -32601，超大消息断连并取消未决请求', async () => {
    const child = new FakeChild(); const client = new AcpClient({ spawn: () => child, maxLineBytes: 512 });
    await client.start();
    child.emitMessage({ jsonrpc: '2.0', id: 'server-1', method: 'fs/read_text_file', params: { path: 'should-not-read' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.sent.at(-1)).toMatchObject({ id: 'server-1', error: { code: -32601 } });
    const pending = client.request('session/list');
    const rejected = expect(pending).rejects.toThrow('大小限制');
    child.stdout.write('x'.repeat(513)); await rejected;
    expect(client.connected).toBe(false); expect(child.killed).toBe(true); await client.stop();
  });
  it.each([429, 403])('官方错误 %s 后阻止连续请求，不做自动重试', async (status) => {
    const child = new FakeChild(); const client = new AcpClient({ spawn: () => child });
    let time = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => time);
    try {
      await client.start(); const limited = vi.fn(); client.on('rateLimited', limited);
      const request = client.request('session/list'); const failed = expect(request).rejects.toThrow('熔断连续请求');
      child.emitMessage({ jsonrpc: '2.0', id: child.sent.at(-1).id, error: { code: -32000, message: `HTTP ${status}` } }); await failed;
      const before = child.sent.length;
      await expect(client.request('session/new', {})).rejects.toThrow('暂停连续请求');
      expect(child.sent).toHaveLength(before); expect(limited).toHaveBeenCalledTimes(1);
      time += status === 403 ? 300001 : 60001;
      const recovered = client.request('session/list'); child.emitMessage({ jsonrpc: '2.0', id: child.sent.at(-1).id, result: { sessions: [] } });
      expect(await recovered).toEqual({ sessions: [] });
    } finally { await client.stop(); }
  });
});

describe('独立 API 403/429 冷却', () => {
  it.each([429, 403])('HTTP %s 后回退人工，冷却期零重复 HTTP 调用', async (status) => {
    let time = 2000000000; vi.spyOn(Date, 'now').mockImplementation(() => time);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status })).mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: '已恢复' } })));
    const config = { enabled: true, provider: 'local-ollama' as const, endpoint: `http://127.0.0.1:${12000 + status}`, model: 'test', timeoutMs: 100 };
    await expect(callIndependentModel(config, '审查', '输入', fetcher)).rejects.toThrow('回退人工');
    await expect(callIndependentModel(config, '审查', '输入', fetcher)).rejects.toThrow('暂停请求');
    expect(fetcher).toHaveBeenCalledTimes(1);
    time += status === 403 ? 300001 : 60001;
    expect(await callIndependentModel(config, '审查', '输入', fetcher)).toBe('已恢复');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
