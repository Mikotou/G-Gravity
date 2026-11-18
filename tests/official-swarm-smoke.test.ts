// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CoreService } from '../src/main/core-service';

// Opt in to one real parent and one Flash worker. Only public, synthetic test text is sent.
it.skipIf(!process.env.GRAVITY_SWARM_SMOKE)('官方蜂群成员接收公开思考分片并回填原消息', async () => {
  const artifacts = path.resolve('tests/artifacts');
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(path.join(artifacts, 'swarm-qa-'));
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd);
  const core = new CoreService({ dataDir: path.join(root, 'client'), homeDir: root, acpOptions: { cwd, binaryPath: process.env.AGY_BINARY_PATH } });
  const wire = vi.spyOn(core.client, 'request');
  const steps: string[] = [];
  core.client.on('session/update', ({ update }) => {
    if (update.sessionUpdate === 'tool_call') steps.push(update.name || update.title);
  });
  let parentId: string | undefined;
  try {
    const session = await core.createSession({ cwd, title: 'Gravity 翻译联调' });
    const id = session.sessionId;
    parentId = id;
    let status: string | undefined;
    await vi.waitUntil(async () => {
      status = (await core.getSessionMessages(id)).find(m => m.role === 'system')?.content;
      return status?.includes('暂不可用') || status?.includes('成员已就绪');
    }, { timeout: 143000, interval: 250 });
    expect(status, steps.join(', ')).toContain('成员已就绪');
    expect((await core.getSwarmState(id)).workers.find(w => w.name === 'thought-translator')?.status).toBe('waiting');
    await core.sendPrompt({ sessionId: id, text: '桌面集成测试：2 加 3 是多少？只回复数字 5，无需调用工具。' });
    expect((await core.getSessionMessages(id)).some(message => message.role === 'assistant' && message.content.includes('5'))).toBe(true);
    const text = 'The second window is ready.';
    core.client.emit('session/update', { sessionId: id, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } });
    await vi.waitFor(async () => {
      const messages = await core.getSessionMessages(id);
      const block = messages.flatMap(m => m.thoughts || []).find(b => b.originalText === text);
      expect(block?.translationSource).toBe('acp-subagent');
      expect(block?.translatedZhText).toMatch(/窗/);
    }, { timeout: 55000, interval: 250 });
    expect(wire.mock.calls.filter(([method]) => method === 'session/new')).toHaveLength(1);
    expect(wire.mock.calls.some(([method, params]) => method === 'session/prompt' && (params as { sessionId: string }).sessionId !== id)).toBe(true);
    console.info('OFFICIAL_SWARM_ROUNDTRIP', core.client.initializeResult?.agentInfo.version);
  } finally {
    try {
      if (parentId) await core.closeSession(parentId).catch(() => {});
      await core.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}, 250000);
