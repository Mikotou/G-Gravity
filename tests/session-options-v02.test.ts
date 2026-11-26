// @vitest-environment node
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { prepareMockAcp } from './helpers/stdio-rpc';

describe('Mode / Model / Effort 按会话能力隔离', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => { fixture = await prepareMockAcp(); });
  afterAll(async () => { await fixture?.cleanup(); });
  it('支持的 Mode/Model 经 ACP 设置且不影响另一个会话', async () => {
    const client = new AcpClient({ spawn: (_binary, _args, options) => spawn(fixture.executable, fixture.args, options) });
    const sessions = new SessionMultiplexer(client);
    try {
      const a = await sessions.createSession({ cwd: 'F:\\选项A' }); const b = await sessions.createSession({ cwd: 'F:\\选项B' });
      expect((await sessions.setSessionMode(a.sessionId, 'plan')).executionMode).toBe('plan');
      expect((await sessions.setSessionModel(a.sessionId, 'mock-model-2')).modelId).toBe('mock-model-2');
      expect((await sessions.setSessionEffort(a.sessionId, 'xhigh')).reasoningEffort).toBe('xhigh');
      expect(sessions.get(b.sessionId)).toMatchObject({ executionMode: 'default', modelId: 'mock-model', reasoningEffort: 'high' });
      await expect(sessions.setSessionModel(a.sessionId, '--fake-model')).rejects.toThrow('未声明');
      expect(sessions.modelList().availableModels.map((model) => model.modelId)).toEqual(['mock-model', 'mock-model-2']);
    } finally { await client.stop(); }
  });
});
