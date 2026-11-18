// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CoreService } from '../src/main/core-service';
import { prepareMockAcp } from './helpers/stdio-rpc';

describe('CoreService 完整 ACP 与原生桥接闭环', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => { fixture = await prepareMockAcp(); });
  afterAll(async () => { await fixture?.cleanup(); });
  async function setup() {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'agy-qa-core-'));
    const children: ChildProcess[] = [];
    const spawnSpy = vi.fn((_binary, _args, options) => {
      const child = spawn(fixture.executable, fixture.args, options); children.push(child); return child;
    });
    const reviewer = vi.fn().mockResolvedValue({ recommended: 'approve', riskLevel: 'low', reason: '测试复核', latencyMs: 1 });
    const core = new CoreService({ dataDir, acpOptions: { spawn: spawnSpy, requestTimeoutMs: 1000 }, reviewer });
    const close = async () => { await core.dispose(); rmSync(dataDir, { recursive: true, force: true }); };
    return { core, close, children, spawnSpy, reviewer, dataDir };
  }
  it('bootstrap 与四会话完整流隔离，含思考、工具、遥测和蜂群', async () => {
    const { core, close, spawnSpy } = await setup();
    try {
      const [first, second] = await Promise.all([core.getBootstrap(), core.getBootstrap()]);
      expect(first.connection.connected).toBe(true); expect(second.connection.maxParallelSessions).toBe(4);
      const sessions = await Promise.all([1, 2, 3, 4].map((n) => core.createSession({ cwd: `F:\\工作区${n}`, title: `蜂群任务${n}` })));
      await Promise.all(sessions.map((session) => core.sendPrompt({ sessionId: session.sessionId, text: '[swarm]' })));
      for (const session of sessions) {
        const messages = await core.getSessionMessages(session.sessionId);
        const assistant = messages.find((message) => message.role === 'assistant')!;
        expect(messages.every((message) => message.sessionId === session.sessionId)).toBe(true);
        expect(assistant.content).toContain(session.sessionId);
        expect(assistant.isStreaming).toBe(false);
        expect(assistant.thoughts![0].originalText).toContain('检查方案与边界');
        expect(assistant.thoughts![0].isStreaming).toBe(false);
        expect(assistant.toolCalls!.map((card) => card.canonicalToolName)).toEqual(['Swarm', 'Swarm']);
        expect((await core.getSwarmState(session.sessionId)).workers[0]).toMatchObject({ brief: '核对结果', status: 'completed' });
      }
      const telemetry = await core.getTelemetryDashboard();
      expect(Object.keys(telemetry.activeSessions)).toHaveLength(4);
      expect(telemetry.calendar30d.at(-1)!.sessionCount).toBe(4);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally { await close(); }
  });
  it('允许一次与本会话前缀均从内联桥接回传，审批零新增 spawn', async () => {
    const { core, close, spawnSpy } = await setup();
    try {
      const session = await core.createSession({ cwd: 'F:\\审批' });
      const requested = once(core, 'approval-requested');
      const run = core.sendPrompt({ sessionId: session.sessionId, text: '[permission] git status' });
      const [card] = await requested;
      expect(core.sessions.get(session.sessionId).status).toBe('waiting_approval');
      await core.submitApprovalDecision({ requestId: card.requestId, sessionId: session.sessionId, decision: 'allow_once' }); await run;
      await core.setApprovalMode('rules-only');
      const next = once(core, 'approval-requested'); const second = core.sendPrompt({ sessionId: session.sessionId, text: '[permission] npm test' });
      const [prefixCard] = await next;
      await core.submitApprovalDecision({ requestId: prefixCard.requestId, sessionId: session.sessionId, decision: 'allow_session_prefix', allowedPrefix: 'npm test' }); await second;
      await core.sendPrompt({ sessionId: session.sessionId, text: '[permission] npm test --verbose' });
      expect((await core.listApprovalAudit())[0].decisionSource).toBe('session-prefix');
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally { await close(); }
  });
  it('首次回放组装完整多轮对话，再次恢复沿用本地记录', async () => {
    const { core, close } = await setup();
    try {
      const { sessionId, cwd } = await core.createSession({ cwd: process.cwd() });
      const send = core.client.request.bind(core.client);
      for (let attempt = 0; attempt < 2; attempt++) {
        await core.closeSession(sessionId);
        vi.spyOn(core.client, 'request').mockImplementationOnce((method, params, timeout) => {
          for (const [kind, text] of [['user', 'first'], ['agent', 'one'], ['agent', '!'], ['user', 'second'], ['agent', 'two']]) {
            core.client.emit('session/update', { sessionId, update: { sessionUpdate: kind + '_message_chunk', content: { type: 'text', text } } });
          }
          return send(method, params, timeout);
        });
        await core.resumeSession(sessionId, cwd);
        const messages = await core.getSessionMessages(sessionId);
        expect(messages.map(m => [m.role, m.content])).toEqual([['user', 'first'], ['assistant', 'one!'], ['user', 'second'], ['assistant', 'two']]);
        expect(messages.every(m => !m.isStreaming)).toBe(true);
        vi.restoreAllMocks();
      }
    } finally { await close(); }
  });

  it('切回正在生成的会话时不会截断或拆分当前助手消息', async () => {
    const { core, close } = await setup();
    try {
      const { sessionId, cwd } = await core.createSession({ cwd: process.cwd() });
      const run = core.sendPrompt({ sessionId, text: '[slow]' });
      await vi.waitUntil(async () => (await core.getSessionMessages(sessionId)).some(m => m.role === 'assistant' && m.isStreaming));
      await core.resumeSession(sessionId, cwd);
      await run;
      const assistants = (await core.getSessionMessages(sessionId)).filter(m => m.role === 'assistant');
      expect(assistants).toHaveLength(1);
      expect(assistants[0].thoughts?.[0].originalText).toContain('Analyzing');
      expect(assistants[0].content).toContain('完成');
    } finally { await close(); }
  });
  it('拒绝并附反馈复用当前会话发送一次后续提示，无额外 CLI 或隐藏会话', async () => {
    const { core, close, spawnSpy } = await setup();
    try {
      const session = await core.createSession({ cwd: 'F:\\反馈' });
      const event = once(core, 'approval-requested'); const run = core.sendPrompt({ sessionId: session.sessionId, text: '[permission] rm -rf project' });
      const [card] = await event;
      await core.submitApprovalDecision({ requestId: card.requestId, sessionId: session.sessionId, decision: 'reject_with_feedback', feedbackText: '只进行只读检查' }); await run;
      const messages = await core.getSessionMessages(session.sessionId);
      expect(messages.filter((message) => message.role === 'user')).toHaveLength(2);
      expect(messages.filter((message) => message.role === 'user')[1].content).toContain('只进行只读检查');
      expect((await core.getConnectionStatus()).activeSessionCount).toBe(1); expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally { await close(); }
  });
  it('规则快筛与独立 AI 复核都能闭环，API Key 不落盘', async () => {
    const { core, close, spawnSpy, reviewer, dataDir } = await setup();
    try {
      const session = await core.createSession({ cwd: 'F:\\规则' });
      await core.setApprovalMode('rules-only');
      await core.sendPrompt({ sessionId: session.sessionId, text: '[permission] pwd' });
      await core.updateApprovalConfig({ mode: 'hybrid', externalReviewer: { enabled: true, provider: 'gemini-api-key', endpoint: 'https://generativelanguage.googleapis.com', apiKey: 'qa-fake-key-never-send', model: 'mock', timeoutMs: 100 } });
      await core.sendPrompt({ sessionId: session.sessionId, text: '[permission] git status' });
      expect(reviewer).toHaveBeenCalledTimes(1); expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect((await core.listApprovalAudit())[0].verdict).toBe('ai_approved');
      expect(readFileSync(path.join(dataDir, 'approval-config.json'), 'utf8')).not.toContain('qa-fake-key-never-send');
    } finally { await close(); }
  });
  it('取消挂起权限后会话恢复，未声明压缩能力时明确拒绝', async () => {
    const { core, close } = await setup();
    try {
      const session = await core.createSession({ cwd: 'F:\\取消权限' });
      const event = once(core, 'approval-requested'); const run = core.sendPrompt({ sessionId: session.sessionId, text: '[permission] git status' });
      await event; await core.cancelPrompt(session.sessionId); await run;
      expect(core.approval.listPending()).toEqual([]);
      expect(core.sessions.get(session.sessionId).status).toBe('idle');
      await expect(core.compactSessionContext(session.sessionId)).rejects.toThrow('未声明');
    } finally { await close(); }
  });
  it('本地翻译处理公开英文并回填收口后的原思考，保留路径且没有翻译会话', async () => {
    const { core, close, dataDir } = await setup();
    try {
      await core.updatePreferences({ translationEngine: 'local' });
      const wire = vi.spyOn(core.client, 'request');
      const session = await core.createSession({ cwd: 'F:\\测试' });
      const sessionId = session.sessionId;
      const text = 'The red bicycle is parked next to the window. Check ' + String.fromCharCode(96) + 'src/app.ts' + String.fromCharCode(96) + ' before opening it.';
      core.client.emit('session/update', { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } });
      core.client.emit('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '结束' } } });
      await vi.waitFor(async () => {
        const thought = (await core.getSessionMessages(sessionId)).flatMap(m => m.thoughts || [])[0];
        expect(thought.translationSource).toBe('local-model');
        expect(thought.translatedZhText).toMatch(/自行车|单车/);
        expect(thought.translatedZhText).toContain('src/app.ts');
      }, { timeout: 20000 });
      expect(wire.mock.calls.filter(([method]) => method === 'session/new')).toHaveLength(1);
      expect(wire.mock.calls.filter(([method]) => method === 'session/prompt')).toHaveLength(0);
      expect((await core.getSwarmState(sessionId)).workers).toEqual([]);
      expect(readFileSync(path.join(dataDir, 'preferences.json'), 'utf8')).toContain('"local"');
    } finally { await close(); }
  }, 25000);
  it('在四会话已满时编辑早先一条消息，原对话可读，新分支只带之前的上下文并保留选中的附件', async () => {
    const { core, close } = await setup();
    try {
      await core.updatePreferences({ translationEngine: 'local' });
      const origin = await core.createSession({ cwd: 'F:\\修订', title: '原始对话' });
      for (let i = 0; i < 3; i++) await core.createSession({ cwd: 'F:\\修订', title: '其他会话' + i });
      const id = origin.sessionId;
      await core.sendPrompt({ sessionId: id, text: 'EARLIER_SENTINEL' });
      await core.sendPrompt({ sessionId: id, text: 'ORIGINAL_TARGET', attachments: [
        { name: 'note.txt', mimeType: 'text/plain', textContent: 'SAVED_FILE', sizeBytes: 10 },
        { name: 'skip.png', mimeType: 'image/png', dataBase64: 'AQID', sizeBytes: 3 }] });
      await core.sendPrompt({ sessionId: id, text: 'FUTURE_EXCLUDED' });
      const before = await core.getSessionMessages(id);
      const target = before.find(m => m.content === 'ORIGINAL_TARGET')!;
      const wire = vi.spyOn(core.client, 'request');
      const branch = await core.reviseMessage({ sessionId: id, messageId: target.id, text: 'REVISED_INPUT', attachmentIds: [target.attachments![0].id] });
      const first = () => wire.mock.calls.filter(([method]) => method === 'session/prompt');
      await vi.waitFor(() => expect(core.sessions.isBusy(branch.sessionId)).toBe(false));
      await vi.waitFor(async () => expect((await core.getSessionMessages(branch.sessionId)).at(-1)?.role).toBe('assistant'));
      expect(branch.sessionId).not.toBe(id);
      const params = JSON.stringify(first()[0][1]);
      for (const value of ['EARLIER_SENTINEL', 'REVISED_INPUT', 'SAVED_FILE']) expect(params).toContain(value);
      for (const value of ['FUTURE_EXCLUDED', 'ORIGINAL_TARGET', 'skip.png']) expect(params).not.toContain(value);
      expect((await core.getSessionMessages(branch.sessionId)).filter(m => m.role === 'user').map(m => m.content)).toEqual(['EARLIER_SENTINEL', 'REVISED_INPUT']);
      expect((await core.getSessionMessages(id)).filter(m => m.role === 'user')).toEqual(before.filter(m => m.role === 'user'));
      await core.sendPrompt({ sessionId: branch.sessionId, text: 'NEXT_TURN' });
      expect(JSON.stringify(first()[1][1])).not.toContain('EARLIER_SENTINEL');
      expect(core.sessions.activeSessionCount).toBe(4);
    } finally { await close(); }
  });
  it('偏好、标题整理、布局和附件大小验证使用冻结桥接接口', async () => {
    const { core, close } = await setup();
    try {
      const session = await core.createSession({ cwd: 'F:\\标题', title: '请帮我调整主题配色' });
      expect((await core.organizeTitles()).updatedCount).toBe(1);
      expect((await core.listSessions())[0].title).toContain('Frontend｜');
      await core.togglePinSession(session.sessionId); expect((await core.renameSession(session.sessionId, '标题整理｜手动修改')).pinned).toBe(true);
      expect((await core.updatePreferences({ locale: 'en-US', theme: 'solarized-dark' })).locale).toBe('en-US');
      expect((await core.saveWorkspaceLayout({ layoutMode: 'split-2', openTabSessionIds: [session.sessionId] })).layoutMode).toBe('split-2');
      await expect(core.sendPrompt({ sessionId: session.sessionId, text: '附件', attachments: [{ name: 'large', mimeType: 'image/png', dataBase64: 'AA==', sizeBytes: 21 * 1024 * 1024 }] })).rejects.toThrow('大小');
    } finally { await close(); }
  });
});
