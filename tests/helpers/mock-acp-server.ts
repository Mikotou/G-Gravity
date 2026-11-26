/** 独立进程运行的 ACP 桩。只收发 stdio，不执行任何工具命令或访问外部网络。 */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

type Rpc = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: any; result?: any; error?: any };
const sessions = new Map<string, { cwd: string; title: string }>();
const loaded = new Set<string>();
const active = new Map<string, { id: string | number; timer?: NodeJS.Timeout; permissionId?: string }>();
const permissions = new Map<string, { sessionId: string; promptId: string | number }>();
const desktopRuns = new Map<string, { scenario: string; attempts: number }>();
let sequence = 0;
let permissionSequence = 0;
const send = (message: Rpc) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id: string | number, result: unknown) => send({ jsonrpc: '2.0', id, result });
const fail = (id: string | number, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });
const update = (sessionId: string, payload: any) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } });

// The packaged desktop test enables these four synthetic turns only in its private CLI process.
function desktopPrompt(sessionId: string, id: string | number, text: string): boolean {
  const trace = process.env.GRAVITY_QA_ACP_TRACE;
  if (!trace) return false;
  const marker = /\[fixture-(recover|interrupt|unknown|zero)\]/.exec(text);
  if (marker && !desktopRuns.has(sessionId)) desktopRuns.set(sessionId, { scenario: marker[1], attempts: 0 });
  const run = desktopRuns.get(sessionId);
  if (!run) { fail(id, -32602, 'Unexpected synthetic prompt'); return true; }
  run.attempts++;
  appendFileSync(trace, JSON.stringify({ sessionId, scenario: run.scenario, attempt: run.attempts, original: Boolean(marker) }) + '\n');
  const warning = '⚠ There was a network issue connecting to the server, please try again.';
  const interrupt = run.scenario === 'interrupt' || (run.scenario === 'recover' && run.attempts === 1);
  const body = interrupt ? warning : 'QA_COMPLETE_' + run.scenario;
  for (const chunk of [body.slice(0, 12), body.slice(12)]) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
  }
  const usage = { inputTokens: 1000, outputTokens: 20, totalTokens: 1020,
    ...(run.scenario === 'recover' ? { cachedReadTokens: 600 } : run.scenario === 'zero' ? { cachedReadTokens: 0 } : {}) };
  update(sessionId, { sessionUpdate: 'usage_update', usage });
  reply(id, { stopReason: 'end_turn', usage });
  return true;
}

function complete(sessionId: string, id: string | number, outcome?: any) {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `完成:${sessionId}:${outcome?.optionId ?? outcome?.outcome ?? '正常'}` } });
  update(sessionId, { sessionUpdate: 'usage_update', usage: { inputTokens: 12, outputTokens: 8, thoughtTokens: 4, totalTokens: 24 } });
  active.delete(sessionId);
  reply(id, { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 24 } });
}

function cancel(sessionId: string) {
  const run = active.get(sessionId);
  if (!run) return;
  clearTimeout(run.timer);
  if (run.permissionId) permissions.delete(run.permissionId);
  active.delete(sessionId);
  reply(run.id, { stopReason: 'cancelled' });
}

function receive(message: Rpc) {
  if (!message.method && message.id !== undefined) {
    const pending = permissions.get(String(message.id));
    if (!pending) return;
    permissions.delete(String(message.id));
    if (message.error) { cancel(pending.sessionId); return; }
    const outcome = message.result?.action ? { optionId: JSON.stringify(message.result) } : message.result?.outcome;
    complete(pending.sessionId, pending.promptId, outcome);
    return;
  }
  const { id, method, params = {} } = message;
  if (method === 'session/cancel') { cancel(params.sessionId); if (id !== undefined) reply(id, {}); return; }
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      reply(id, { protocolVersion: 1, agentInfo: { name: '测试 ACP 服务', version: '1.0.0' }, agentCapabilities: {
        loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} }, auth: { logout: {} },
        _meta: { antigravity: { systemPrompt: { append: true } } },
      }, authMethods: [] }); return;
    case 'session/new': {
      const sessionId = `mock-session-${++sequence}`;
      sessions.set(sessionId, { cwd: params.cwd, title: `测试会话 ${sequence}` });
      loaded.add(sessionId);
      reply(id, { sessionId, models: { currentModelId: 'mock-model', availableModels: [{ modelId: 'mock-model', name: 'Mock' }, { modelId: 'mock-model-2', name: 'Mock 2' }] },
        modes: { currentModeId: 'default', availableModes: ['default', 'accept-edits', 'plan', 'auto'].map((mode) => ({ id: mode, name: mode })) } }); return;
    }
    case 'session/list':
      reply(id, { sessions: Array.from(sessions, ([sessionId, data]) => ({ sessionId, ...data })) }); return;
    case 'session/resume':
    case 'session/load':
      if (!sessions.has(params.sessionId)) { fail(id, -32001, '会话不存在'); return; }
      loaded.add(params.sessionId);
      reply(id, { sessionId: params.sessionId }); return;
    case 'session/close':
      cancel(params.sessionId); loaded.delete(params.sessionId); reply(id, {}); return;
    case 'session/set_mode':
    case 'session/set_model':
    case 'auth/logout':
      reply(id, {}); return;
    case 'test/rate_limit':
      fail(id, -32000, `HTTP ${params.status || 429}`); return;
    case 'session/prompt': {
      const sessionId = params.sessionId;
      if (!loaded.has(sessionId)) { fail(id, -32001, '会话不存在或未加载'); return; }
      if (active.has(sessionId)) { fail(id, -32002, '会话已有生成任务'); return; }
      const text = (params.prompt ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
      if (desktopPrompt(sessionId, id, text)) return;
      const run: { id: string | number; timer?: NodeJS.Timeout; permissionId?: string } = { id };
      active.set(sessionId, run);
      update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `Analyzing ${sessionId}. ` } });
      run.timer = setTimeout(() => {
        update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '检查方案与边界。' } });
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `开始:${sessionId}。` } });
        if (text.includes('[swarm]')) {
          update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `swarm-${sessionId}`, title: 'swarm', kind: 'other', status: 'completed',
            rawInput: { action: 'spawn', name: '测试个体', role: 'tester', model: 'mock-model', brief: '核对结果', workspaceMode: 'branch' },
            rawOutput: { workers: [{ id: 'worker-1', name: '测试个体', role: 'tester', status: 'working', brief: '核对结果', model: 'mock-model' }] } });
          update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `board-${sessionId}`, title: 'post_message', kind: 'other', status: 'completed',
            rawInput: { sender: '测试个体', content: '[done] 已核对', channel: 'main', mentions: ['lead'] } });
        }
        if (text.includes('[question]') || text.includes('[closed choice]')) {
          const permissionId = 'question-' + ++permissionSequence;
          run.permissionId = permissionId;
          permissions.set(permissionId, { sessionId, promptId: id });
          send({ jsonrpc: '2.0', id: permissionId, method: 'elicitation/create', params: { sessionId, mode: 'form', message: '你想选哪种颜色？',
            requestedSchema: { type: 'object', required: ['color'], properties: {
              color: { type: 'string', title: '颜色', oneOf: [{ const: 'teal', title: '青绿' }, { const: 'amber', title: '琥珀' }] },
              ...(text.includes('[closed choice]') ? {} : { freeform_response: { type: 'string', title: '补充' } }),
            } } } });
        } else if (text.includes('[permission]')) {
          const permissionId = `permission-${++permissionSequence}`;
          run.permissionId = permissionId;
          permissions.set(permissionId, { sessionId, promptId: id });
          send({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: {
            sessionId, toolCall: { toolCallId: `command-${sessionId}`, title: 'run_command', kind: 'execute', rawInput: { command: text.split('[permission]')[1]?.trim() || 'git status' } },
            options: [ { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }, { optionId: 'allow-always', name: '始终允许', kind: 'allow_always' }, { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' } ],
          } });
        } else if (text.includes('[prose-question]')) {
          const body = text.split('[prose-question]')[1]?.trim() || '请问优先执行哪一项？\nA. 方案甲\nB. 方案乙';
          update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n${body}` } });
          update(sessionId, { sessionUpdate: 'usage_update', usage: { inputTokens: 12, outputTokens: 8, thoughtTokens: 4, totalTokens: 24 } });
          active.delete(sessionId);
          reply(id, { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 24 } });
        } else complete(sessionId, id);
      }, text.includes('[stream-during-drag]') ? 850 : text.includes('[slow]') ? 250 : 15);
      return;
    }
    default: fail(id, -32601, `未知方法：${method}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try { receive(JSON.parse(line)); }
  catch { send({ jsonrpc: '2.0', id: 'parse-error', error: { code: -32700, message: '无效 JSON' } }); }
});
input.on('close', () => {
  for (const run of active.values()) clearTimeout(run.timer);
  process.exit(0);
});
