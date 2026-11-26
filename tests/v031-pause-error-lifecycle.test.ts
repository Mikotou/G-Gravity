// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { IpcMain, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpRpcError } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { registerIpcRouter } from '../src/main/ipc-router';
import {
  buildDiagnosticBanner,
  classifyErrorToDiagnosticCode,
  IPC_CHANNELS,
  type AcpConnectionStatus,
  type AcpSessionPromptParams,
  type AcpSessionPromptResult,
  type ChatMessageItem,
  type DiagnosticCode,
  type ManagedSessionSummary,
  type PendingApprovalRequest,
} from '@shared';
import { createCoreBridge, readAllSessionMessages } from './helpers/core-bridge';

/* ============================================================================
 * Helpers: FakeChild (real JSON-RPC stdio transport) & Deferred
 * ========================================================================== */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeAcpChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sent: Array<Record<string, unknown>> = [];
  killed = false;
  onRequest?: (msg: { id: number | string; method: string; params?: Record<string, unknown> }) => void;

  stdin = new Writable({
    write: (chunk, _enc, done) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> };
        this.sent.push(message);
        if (message.method && message.id !== undefined) {
          if (message.method === 'initialize') {
            queueMicrotask(() =>
              this.emitMessage({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  protocolVersion: 1,
                  agentInfo: { name: 'Antigravity CLI', version: '1.0.0' },
                  agentCapabilities: {
                    loadSession: true,
                    sessionCapabilities: { list: {}, resume: {}, close: {} },
                  },
                },
              })
            );
          } else if (this.onRequest) {
            this.onRequest({ id: message.id, method: message.method, params: message.params });
          }
        }
      }
      done();
    },
  });

  constructor() {
    super();
    this.stdin.on('finish', () => setImmediate(() => this.emit('close', 0)));
  }

  emitMessage(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill() {
    this.killed = true;
    this.exitCode = 1;
    setImmediate(() => this.emit('close', 1));
    return true;
  }
}

const tempDirs: string[] = [];
const services: CoreService[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createSpyCore(options?: { agentName?: string }) {
  const dir = makeTempDir('gravity-v031-lifecycle-');
  const client = new AcpClient();
  const initResult = {
    protocolVersion: 1,
    agentInfo: { name: options?.agentName ?? 'Antigravity CLI', version: '1.0.0' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
  };
  client.initializeResult = initResult;
  let isConnected = true;
  vi.spyOn(client, 'connected', 'get').mockImplementation(() => isConnected);
  const startSpy = vi.spyOn(client, 'start').mockImplementation(async () => {
    isConnected = true;
    return initResult;
  });
  vi.spyOn(client, 'notify').mockImplementation(() => {});

  const prompts: AcpSessionPromptParams[] = [];
  let seq = 0;
  let promptHandler: (params: AcpSessionPromptParams, attempt: number) => Promise<AcpSessionPromptResult> | AcpSessionPromptResult =
    () => ({ stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10 } });
  let resumeHandler: (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown> =
    (params) => ({ sessionId: String(params.sessionId || `resumed-${++seq}`) });

  const requestSpy = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'session/new') return { sessionId: `sess-life-${++seq}` };
    if (method === 'session/resume' || method === 'session/load') {
      return resumeHandler((params || {}) as Record<string, unknown>);
    }
    if (method === 'session/prompt') {
      const p = params as AcpSessionPromptParams;
      prompts.push(p);
      return promptHandler(p, prompts.length);
    }
    if (method === 'session/close') return {};
    return {};
  });

  const core = new CoreService({ acp: client, dataDir: dir, homeDir: path.join(dir, 'home') });
  services.push(core);
  const session = await core.createSession({ cwd: dir });

  return {
    dir,
    client,
    core,
    session,
    prompts,
    startSpy,
    requestSpy,
    setConnected(val: boolean) {
      isConnected = val;
    },
    setPromptHandler(fn: typeof promptHandler) {
      promptHandler = fn;
    },
    setResumeHandler(fn: typeof resumeHandler) {
      resumeHandler = fn;
    },
    emitChunk(text: string, sid = session.sessionId) {
      client.emit('session/update', {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    },
    emitToolCall(toolCallId: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', sid = session.sessionId) {
      client.emit('session/update', {
        sessionId: sid,
        update: {
          sessionUpdate: status === 'pending' || status === 'in_progress' ? 'tool_call' : 'tool_call_update',
          toolCallId,
          title: 'run_command',
          kind: 'execute',
          status,
          rawInput: { command: 'npm test' },
        },
      });
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const core of services.splice(0)) {
    await core.dispose().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  vi.restoreAllMocks();
});

/* ============================================================================
 * 1. @shared diagnostic-contract.ts unit tests (Passes on Wave 0)
 * ========================================================================== */

describe('@shared diagnostic-contract.ts bilingual banners, redaction & classifier', () => {
  const ALL_DIAGNOSTIC_CODES: readonly DiagnosticCode[] = [
    'user_cancelled',
    'max_tokens',
    'refusal',
    'waiting_approval',
    'waiting_question',
    'rate_limited_429',
    'permission_denied_403',
    'auth_required_401',
    'context_overflow',
    'stream_interrupted',
    'auto_resume_failed',
    'acp_disconnected',
    'agy_binary_missing',
    'concurrency_limit_reached',
    'policy_blocked',
    'tool_failure_stopped',
    'resume_failed',
    'unknown_error',
  ];

  it.each(ALL_DIAGNOSTIC_CODES)('buildDiagnosticBanner(%s) provides complete zh-CN & en-US copy, severity, and safe actions', (code) => {
    const banner = buildDiagnosticBanner(code, {
      cooldownUntil: '2026-11-24T12:00:00.000Z',
      exitCode: 1,
      blockedReasons: ['禁止写入 ~/.gemini'],
      technicalDetail: 'sample diagnostic detail',
    });

    expect(banner.code).toBe(code);
    expect(['paused', 'warning', 'error']).toContain(banner.severity);
    expect(banner.titleZh.trim().length).toBeGreaterThan(3);
    expect(banner.titleEn.trim().length).toBeGreaterThan(3);
    expect(banner.messageZh.trim().length).toBeGreaterThan(5);
    expect(banner.messageEn.trim().length).toBeGreaterThan(5);
    expect(banner.suggestionsZh.length).toBeGreaterThan(0);
    expect(banner.suggestionsEn.length).toBeGreaterThan(0);
    expect(banner.actions.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(banner.occurredAt))).toBe(true);

    if (code === 'waiting_approval' || code === 'waiting_question') {
      expect(banner.dismissible).toBe(false);
    }
    if (code === 'rate_limited_429' || code === 'permission_denied_403') {
      expect(banner.cooldownUntil).toBe('2026-11-24T12:00:00.000Z');
      expect(banner.actions).toContain('open_accounts_settings');
    }
    if (code === 'acp_disconnected') {
      expect(banner.technicalDetail).toContain('exit=1');
      expect(banner.actions).toContain('reconnect_session');
    }
    if (code === 'policy_blocked') {
      expect(banner.messageZh).toContain('禁止写入 ~/.gemini');
    }
  });

  it('redacts secrets (Bearer, Basic, sk-, AIza, github_pat_, ghp_) and truncates overly long technicalDetail', () => {
    const rawDetail =
      'Auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.secret.sig Basic dXNlcjpwYXNz ' +
      'sk-proj-supersecretkey12345 AIzaSyDummyGoogleKey987654 github_pat_11AAABBBCCC ghp_token999 ' +
      'x'.repeat(400);
    const banner = buildDiagnosticBanner('auth_required_401', { technicalDetail: rawDetail });

    expect(banner.technicalDetail).toBeDefined();
    expect(banner.technicalDetail!.length).toBeLessThanOrEqual(280);
    expect(banner.technicalDetail).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(banner.technicalDetail).not.toContain('dXNlcjpwYXNz');
    expect(banner.technicalDetail).not.toContain('sk-proj-supersecretkey12345');
    expect(banner.technicalDetail).not.toContain('AIzaSyDummyGoogleKey987654');
    expect(banner.technicalDetail).not.toContain('github_pat_11AAABBBCCC');
    expect(banner.technicalDetail).not.toContain('ghp_token999');
    expect(banner.technicalDetail).toContain('[redacted]');
  });

  it('classifyErrorToDiagnosticCode maps all 429/403/401/overflow/missing/cap/disconnect/stream/policy errors accurately', () => {
    expect(classifyErrorToDiagnosticCode({ code: 429 })).toBe('rate_limited_429');
    expect(classifyErrorToDiagnosticCode(new Error('HTTP 429 RESOURCE_EXHAUSTED'))).toBe('rate_limited_429');
    expect(classifyErrorToDiagnosticCode('quota exceeded for model')).toBe('rate_limited_429');

    expect(classifyErrorToDiagnosticCode({ code: 403 })).toBe('permission_denied_403');
    expect(classifyErrorToDiagnosticCode(new Error('PERMISSION_DENIED: model restricted'))).toBe('permission_denied_403');

    expect(classifyErrorToDiagnosticCode({ code: 401 })).toBe('auth_required_401');
    expect(classifyErrorToDiagnosticCode(new Error('UNAUTHENTICATED: login required'))).toBe('auth_required_401');
    expect(classifyErrorToDiagnosticCode('当前账号未登录或登录已过期')).toBe('auth_required_401');

    expect(classifyErrorToDiagnosticCode(new Error('prompt is too long for context window'))).toBe('context_overflow');
    expect(classifyErrorToDiagnosticCode('上下文窗口超限')).toBe('context_overflow');

    expect(classifyErrorToDiagnosticCode(new Error('未找到官方 agy，请将其加入 PATH 或设置 AGY_BINARY_PATH'))).toBe('agy_binary_missing');
    expect(classifyErrorToDiagnosticCode(new Error('spawn agy.exe ENOENT'))).toBe('agy_binary_missing');

    expect(classifyErrorToDiagnosticCode(new Error('最多同时打开 4 个活动会话，请先关闭一个标签页'))).toBe('concurrency_limit_reached');
    expect(classifyErrorToDiagnosticCode('MAX_PARALLEL_ACTIVE_SESSIONS reached')).toBe('concurrency_limit_reached');

    expect(classifyErrorToDiagnosticCode(new Error('官方 ACP 进程已退出'))).toBe('acp_disconnected');
    expect(classifyErrorToDiagnosticCode(new Error('ACP 通道已关闭'))).toBe('acp_disconnected');
    expect(classifyErrorToDiagnosticCode(new Error('write EPIPE'))).toBe('acp_disconnected');

    expect(classifyErrorToDiagnosticCode(new Error('The stream was interrupted. Please continue.'))).toBe('stream_interrupted');
    expect(classifyErrorToDiagnosticCode('流式连接意外中断')).toBe('stream_interrupted');

    expect(classifyErrorToDiagnosticCode(new Error('本地安全策略拦截：禁止写入 ~/.gemini'))).toBe('policy_blocked');
    expect(classifyErrorToDiagnosticCode(new Error('completely unrelated failure'))).toBe('unknown_error');
  });
});

/* ============================================================================
 * 2. CoreService turnStop, cancelPrompt (B-P1-3), waiting_question & customAnswers (B-P1-4)
 * ========================================================================== */

describe('CoreService structured turnStop, cancellation & question lifecycle (Wave 1A)', () => {
  it('persists turnStop.code === "max_tokens" on truncated turn and clears session diagnostic on next clean end_turn', async () => {
    const { core, session, setPromptHandler, emitChunk } = await createSpyCore();

    setPromptHandler(() => {
      emitChunk('Partial detailed analysis...');
      return { stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 4096 } };
    });

    await core.sendPrompt({ sessionId: session.sessionId, text: 'Write a very long design spec' });

    const messages = await readAllSessionMessages(core, session.sessionId);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('Partial detailed analysis...');
    expect(assistant?.turnStop?.code).toBe('max_tokens');
    expect(assistant?.turnStop?.severity).toBe('paused');
    expect(assistant?.turnStop?.actions).toContain('continue_turn');

    // Follow-up clean turn should clear transient diagnostic banner
    setPromptHandler(() => {
      emitChunk('Remaining section complete.');
      return { stopReason: 'end_turn' };
    });
    await core.sendPrompt({ sessionId: session.sessionId, text: 'Continue' });
    const latestSession = core.sessions.get(session.sessionId);
    expect(latestSession.diagnostic).toBeUndefined();
  });

  it('persists an assistant message with turnStop.code === "refusal" even when the model emits zero content', async () => {
    const { core, session, setPromptHandler } = await createSpyCore();

    setPromptHandler(() => ({ stopReason: 'refusal' }));

    await core.sendPrompt({ sessionId: session.sessionId, text: 'Declined prompt' });

    const messages = await readAllSessionMessages(core, session.sessionId);
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe('');
    expect(assistants[0].isStreaming).toBe(false);
    expect(assistants[0].turnStop?.code).toBe('refusal');
    expect(assistants[0].turnStop?.severity).toBe('warning');
    expect(assistants[0].turnStop?.actions).toContain('edit_last_message');
  });

  it('B-P1-3: cancelPrompt produces a single assistant message with turnStop.code === "user_cancelled" and settles running tools even when trailing chunks arrive before session/prompt resolves', async () => {
    const { core, session, setPromptHandler, emitChunk, emitToolCall } = await createSpyCore();
    const promptGate = createDeferred<AcpSessionPromptResult>();

    setPromptHandler(() => {
      emitChunk('Initial progress');
      emitToolCall('tc-cancel-1', 'in_progress');
      return promptGate.promise;
    });

    const promptPromise = core.sendPrompt({ sessionId: session.sessionId, text: 'Run long task' });
    promptPromise.catch(() => {});
    await Promise.resolve();

    await core.cancelPrompt(session.sessionId);

    // Trailing chunk & tool update arriving while session/prompt RPC is still unwinding
    emitChunk(' trailing tail');
    promptGate.resolve({ stopReason: 'cancelled' });
    await promptPromise;

    const messages = await readAllSessionMessages(core, session.sessionId);
    const assistants = messages.filter((m) => m.role === 'assistant');
    // Must NOT spawn a duplicate second assistant bubble!
    expect(assistants).toHaveLength(1);
    expect(assistants[0].isStreaming).toBe(false);
    expect(assistants[0].turnStop?.code).toBe('user_cancelled');
    const tool = assistants[0].toolCalls?.find((tc) => tc.toolCallId === 'tc-cancel-1');
    expect(tool).toBeDefined();
    expect(tool!.status).not.toBe('running');
    expect(tool!.status).not.toBe('pending');
  });

  it('transitions session to status="waiting_question" with diagnostic.code="waiting_question" during elicitation/create and restores when answered', async () => {
    const dir = makeTempDir('gravity-v031-question-');
    const child = new FakeAcpChild();
    let seq = 0;
    let activePromptId: number | string | undefined;

    child.onRequest = ({ id, method }) => {
      if (method === 'session/new') {
        queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { sessionId: `q-sess-${++seq}` } }));
      } else if (method === 'session/prompt') {
        activePromptId = id;
      } else if (method === 'session/close') {
        queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: {} }));
      }
    };

    const client = new AcpClient({ spawn: () => child });
    const core = new CoreService({ acp: client, dataDir: dir, homeDir: path.join(dir, 'home') });
    services.push(core);

    const sessionUpdates: ManagedSessionSummary[] = [];
    const upserted: ChatMessageItem[] = [];
    core.on('session-updated', (s: ManagedSessionSummary) => sessionUpdates.push(s));
    core.on('message-upserted', (p: { message: ChatMessageItem }) => upserted.push(p.message));

    const session = await core.createSession({ cwd: dir });
    const promptPromise = core.sendPrompt({ sessionId: session.sessionId, text: 'Ask me a question' });
    promptPromise.catch(() => {});
    await new Promise((r) => setImmediate(r));
    expect(activePromptId).toBeDefined();

    try {
      // Agent sends elicitation/create
      child.emitMessage({
        jsonrpc: '2.0',
        id: 'elic-open-1',
        method: 'elicitation/create',
        params: {
          sessionId: session.sessionId,
          message: 'Choose target format',
          requestedSchema: {
            type: 'object',
            required: ['format'],
            properties: { format: { type: 'string', enum: ['json', 'yaml'] } },
          },
        },
      });
      await new Promise((r) => setImmediate(r));

      const questionMsg = upserted.find((m) => m.question?.state === 'open');
      expect(questionMsg).toBeDefined();
      expect(core.sessions.get(session.sessionId).status).toBe('waiting_question');
      expect(core.sessions.get(session.sessionId).diagnostic?.code).toBe('waiting_question');
      expect(sessionUpdates.some((s) => s.status === 'waiting_question' && s.diagnostic?.code === 'waiting_question')).toBe(true);

      // User answers the question
      await core.answerQuestion({
        sessionId: session.sessionId,
        messageId: questionMsg!.id,
        action: 'accept',
        values: { format: 'json' },
      });
      await new Promise((r) => setImmediate(r));

      // Restored back to streaming while prompt is still running, diagnostic cleared
      expect(core.sessions.get(session.sessionId).status).toBe('streaming');
      expect(core.sessions.get(session.sessionId).diagnostic?.code).not.toBe('waiting_question');

      // Finish the prompt cleanly
      child.emitMessage({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'end_turn' } });
      await promptPromise;
      expect(core.sessions.get(session.sessionId).status).toBe('idle');
    } finally {
      if (activePromptId !== undefined) {
        child.emitMessage({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'cancelled' } });
      }
      await promptPromise.catch(() => {});
    }
  });

  it('B-P1-4: delivers customAnswers cleanly after auto-resume and reject_with_feedback turns, and cancels hanging questions on feedback turn finish', async () => {
    // Sub-test 1: customAnswers submitted during auto-resume turn
    {
      const dir = makeTempDir('gravity-v031-custom-autoresume-');
      const child = new FakeAcpChild();
      const promptCalls: AcpSessionPromptParams[] = [];
      let sid = 'auto-q-1';

      child.onRequest = ({ id, method, params }) => {
        if (method === 'session/new') {
          queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { sessionId: sid } }));
        } else if (method === 'session/prompt') {
          const p = params as unknown as AcpSessionPromptParams;
          promptCalls.push(p);
          if (promptCalls.length === 1) {
            // Trigger auto-resume via transient network warning
            child.emitMessage({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: '⚠ There was a network issue connecting to the server, please try again.' },
                },
              },
            });
            queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }));
          } else if (promptCalls.length === 2) {
            // During auto-resume turn, ask a question and wait for the client's reply before ending turn 2
            child.emitMessage({
              jsonrpc: '2.0',
              id: 'elic-auto-2',
              method: 'elicitation/create',
              params: {
                sessionId: sid,
                message: 'Need detail during resume',
                requestedSchema: { type: 'object', properties: { opt: { type: 'string', enum: ['A', 'B'] } } },
              },
            });
            const checkReply = setInterval(() => {
              if (child.sent.some((m) => m.id === 'elic-auto-2' && 'result' in m)) {
                clearInterval(checkReply);
                child.emitMessage({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Noted.' } } },
                });
                child.emitMessage({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
              }
            }, 10);
          } else {
            child.emitMessage({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Applied custom answer.' } } },
            });
            queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }));
          }
        } else if (method === 'session/close') {
          queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: {} }));
        }
      };

      const client = new AcpClient({ spawn: () => child });
      const core = new CoreService({ acp: client, dataDir: dir, homeDir: path.join(dir, 'home') });
      services.push(core);

      core.on('message-upserted', ({ message }: { message: ChatMessageItem }) => {
        if (message.question?.state === 'open') {
          void core.answerQuestion({
            sessionId: sid,
            messageId: message.id,
            action: 'accept',
            customReply: 'Use strict TypeScript checks',
          });
        }
      });

      const session = await core.createSession({ cwd: dir });
      sid = session.sessionId;
      await core.sendPrompt({ sessionId: sid, text: 'Start task' });

      expect(promptCalls.length).toBeGreaterThanOrEqual(3);
      const deliveredCustom = promptCalls.some((p) =>
        p.prompt.some((b) => b.type === 'text' && b.text.includes('Use strict TypeScript checks'))
      );
      expect(deliveredCustom).toBe(true);
    }

    // Sub-test 2: customAnswers submitted during reject_with_feedback turn
    {
      const dir = makeTempDir('gravity-v031-custom-feedback-');
      const child = new FakeAcpChild();
      const promptCalls: AcpSessionPromptParams[] = [];
      let sid = 'fb-q-1';

      child.onRequest = ({ id, method, params }) => {
        if (method === 'session/new') {
          queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { sessionId: sid } }));
        } else if (method === 'session/prompt') {
          const p = params as unknown as AcpSessionPromptParams;
          promptCalls.push(p);
          if (promptCalls.length === 1) {
            // Request permission -> user will reject_with_feedback -> turn 1 finishes -> turn 2 feedback runs
            child.emitMessage({
              jsonrpc: '2.0',
              id: 'perm-fb-1',
              method: 'session/request_permission',
              params: {
                sessionId: sid,
                toolCall: { toolCallId: 'tc-fb-1', kind: 'execute', title: 'run_command', rawInput: { command: 'rm -rf tmp' } },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                ],
              },
            });
            const waitPerm = setInterval(() => {
              if (child.sent.some((m) => m.id === 'perm-fb-1' && 'result' in m)) {
                clearInterval(waitPerm);
                child.emitMessage({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
              }
            }, 10);
          } else if (promptCalls.length === 2) {
            // During feedback turn, ask an elicitation question -> user submits customReply
            child.emitMessage({
              jsonrpc: '2.0',
              id: 'elic-fb-2',
              method: 'elicitation/create',
              params: {
                sessionId: sid,
                message: 'Alternative approach?',
                requestedSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['safe', 'fast'] } } },
              },
            });
            const waitElic = setInterval(() => {
              if (child.sent.some((m) => m.id === 'elic-fb-2' && 'result' in m)) {
                clearInterval(waitElic);
                child.emitMessage({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
              }
            }, 10);
          } else {
            queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }));
          }
        } else if (method === 'session/close') {
          queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: {} }));
        }
      };

      const client = new AcpClient({ spawn: () => child });
      const core = new CoreService({ acp: client, dataDir: dir, homeDir: path.join(dir, 'home') });
      services.push(core);

      core.on('approval-requested', (req: PendingApprovalRequest) => {
        void core.submitApprovalDecision({
          requestId: req.requestId,
          sessionId: req.sessionId,
          decision: 'reject_with_feedback',
          feedbackText: 'Keep tmp directory intact',
        });
      });

      core.on('message-upserted', ({ message }: { message: ChatMessageItem }) => {
        if (message.question?.state === 'open') {
          void core.answerQuestion({
            sessionId: sid,
            messageId: message.id,
            action: 'accept',
            customReply: 'Write output to scratch instead',
          });
        }
      });

      const session = await core.createSession({ cwd: dir });
      sid = session.sessionId;
      await core.sendPrompt({ sessionId: sid, text: 'Clean up workspace' });

      expect(promptCalls.length).toBeGreaterThanOrEqual(3);
      const deliveredCustom = promptCalls.some((p) =>
        p.prompt.some((b) => b.type === 'text' && b.text.includes('Write output to scratch instead'))
      );
      expect(deliveredCustom).toBe(true);
    }
  });
});

/* ============================================================================
 * 3. 429 vs 403 distinct cooldowns, no false data match, EVENT_CONNECTION_UPDATED, ZERO auto rotation
 * ========================================================================== */

describe('AcpClient & CoreService 429/403 cooldowns, connection-updated push & zero auto account rotation', () => {
  it('does NOT falsely trigger 403/429 cooldown from unrelated numeric fields in error.data', async () => {
    const child = new FakeAcpChild();
    const client = new AcpClient({ spawn: () => child });
    try {
      await client.start();
      const req = client.request('session/list');
      const sentId = child.sent.at(-1)!.id;
      child.emitMessage({
        jsonrpc: '2.0',
        id: sentId,
        error: {
          code: -32603,
          message: 'Internal tool serialization error',
          data: { line: 403, tokenCount: 429, elapsedMs: 403 },
        },
      });
      await expect(req).rejects.toThrow('Internal tool serialization error');
      expect(client.isRateLimited).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it('enforces distinct 60s (429) vs 300s (403) cooldowns, pushes connection-updated with cooldownUntil/cooldownKind, and performs ZERO auto account rotation', async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const dir = makeTempDir('gravity-v031-cooldown-');
    const child = new FakeAcpChild();
    const client = new AcpClient({ spawn: () => child });
    const core = new CoreService({ acp: client, dataDir: dir, homeDir: path.join(dir, 'home'), now: () => now });
    services.push(core);

    // Create a second isolated profile to prove compliance rule #3/#4: ZERO auto account rotation!
    const accountsAfterCreate = await core.createAccountProfile({ name: 'Secondary Isolated' });
    expect(accountsAfterCreate.profiles).toHaveLength(2);
    expect(core.accounts.activeProfileId).toBe('default');

    const bridge = createCoreBridge(core);
    expect(typeof bridge.onConnectionUpdated).toBe('function');
    const connEvents: AcpConnectionStatus[] = [];
    const unsubscribe = bridge.onConnectionUpdated!((status) => connEvents.push(status));

    try {
      await client.start();

      // 1) Trigger 429 -> 60s cooldown, cooldownKind: 'rate_limit_429'
      const req429 = client.request('session/list');
      const id429 = child.sent.at(-1)!.id;
      child.emitMessage({
        jsonrpc: '2.0',
        id: id429,
        error: { code: 429, message: 'RESOURCE_EXHAUSTED: slow down' },
      });
      await expect(req429).rejects.toThrow();

      expect(core.accounts.activeProfileId).toBe('default');
      const status429 = await core.getConnectionStatus();
      expect(status429.cooldownKind).toBe('rate_limit_429');
      expect(status429.cooldownUntil).toBeTruthy();
      const remaining429 = Date.parse(status429.cooldownUntil!) - now;
      expect(remaining429).toBeGreaterThanOrEqual(55_000);
      expect(remaining429).toBeLessThanOrEqual(65_000);
      expect(connEvents.some((e) => e.cooldownKind === 'rate_limit_429' && Boolean(e.cooldownUntil))).toBe(true);

      // Advance past 60s cooldown
      now += 61_000;
      expect(client.isRateLimited).toBe(false);

      // 2) Trigger 403 -> 300s cooldown, cooldownKind: 'permission_403'
      const req403 = client.request('session/list');
      const id403 = child.sent.at(-1)!.id;
      child.emitMessage({
        jsonrpc: '2.0',
        id: id403,
        error: { code: 403, message: 'PERMISSION_DENIED: model not authorized' },
      });
      await expect(req403).rejects.toThrow();

      expect(core.accounts.activeProfileId).toBe('default');
      const status403 = await core.getConnectionStatus();
      expect(status403.cooldownKind).toBe('permission_403');
      expect(status403.cooldownUntil).toBeTruthy();
      const remaining403 = Date.parse(status403.cooldownUntil!) - now;
      expect(remaining403).toBeGreaterThanOrEqual(295_000);
      expect(remaining403).toBeLessThanOrEqual(305_000);
      expect(connEvents.some((e) => e.cooldownKind === 'permission_403' && Boolean(e.cooldownUntil))).toBe(true);

      // Verify still in cooldown at +61s (distinct from 429's 60s)
      now += 61_000;
      expect(client.isRateLimited).toBe(true);
      expect(core.accounts.activeProfileId).toBe('default');
    } finally {
      unsubscribe();
    }
  });

  it('forwards connection-updated through registerIpcRouter to EVENT_CONNECTION_UPDATED and exposes onConnectionUpdated in preload.ts', () => {
    const handlers = new Map<string, Function>();
    const ipcMain = {
      handle: (ch: string, cb: Function) => handlers.set(ch, cb),
      removeHandler: (ch: string) => handlers.delete(ch),
    } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const service = new EventEmitter() as unknown as CoreService;

    const dispose = registerIpcRouter(ipcMain, service, trusted);
    try {
      expect(service.listenerCount('connection-updated')).toBeGreaterThan(0);
      const payload: AcpConnectionStatus = {
        connected: false,
        agyBinaryPath: 'agy',
        agyVersion: '',
        activeSessionCount: 0,
        maxParallelSessions: 4,
        activeProfileId: 'default',
        availableModels: [],
        lastErrorCode: 'acp_disconnected',
      };
      service.emit('connection-updated', payload);
      expect(trusted.send).toHaveBeenCalledWith(IPC_CHANNELS.EVENT_CONNECTION_UPDATED, payload);
    } finally {
      dispose();
    }
    expect(service.listenerCount('connection-updated')).toBe(0);

    const preloadSource = readFileSync('src/main/preload.ts', 'utf8');
    expect(preloadSource).toContain('onConnectionUpdated');
    expect(preloadSource).toContain(IPC_CHANNELS.EVENT_CONNECTION_UPDATED);
  });
});

/* ============================================================================
 * 4. B-P0-1: ACP disconnect during active reactive turn + running tool
 * ========================================================================== */

describe('B-P0-1: ACP disconnect cleanup, zero dangling reactive timers & reconnect recovery', () => {
  it('clears 8s reactive timers cleanly on disconnect (0 dangling timers), settles open message with acp_disconnected, emits connection-updated(false), and allows resumeSession reconnect', async () => {
    const dir = makeTempDir('gravity-v031-bp01-');
    const child1 = new FakeAcpChild();
    const child2 = new FakeAcpChild();
    let spawnCount = 0;

    const setupChild = (child: FakeAcpChild) => {
      child.onRequest = ({ id, method, params }) => {
        if (method === 'session/new') {
          queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { sessionId: 'reactive-sess-1' } }));
        } else if (method === 'session/resume' || method === 'session/load') {
          queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { sessionId: String(params?.sessionId) } }));
        } else if (method === 'session/prompt') {
          child.emitMessage({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: String(params?.sessionId), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reconnected OK!' } } },
          });
          queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }));
        } else if (method === 'session/close') {
          queueMicrotask(() => child.emitMessage({ jsonrpc: '2.0', id, result: {} }));
        }
      };
    };
    setupChild(child1);
    setupChild(child2);

    const client = new AcpClient({
      spawn: () => (++spawnCount === 1 ? child1 : child2),
    });
    const core = new CoreService({ acp: client, dataDir: dir, homeDir: path.join(dir, 'home') });
    services.push(core);
    const bridge = createCoreBridge(core);
    expect(typeof bridge.onConnectionUpdated).toBe('function');

    const connEvents: AcpConnectionStatus[] = [];
    bridge.onConnectionUpdated!((s) => connEvents.push(s));

    const session = await core.createSession({ cwd: dir });

    // Enable fake timers ONLY for setTimeout/clearTimeout after initial setup so telemetryClock is untouched
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Trigger a reactive wakeup turn (session is NOT busy) with a running tool -> schedules 8000ms timer
      child1.emitMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: session.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Background subagent running...' } },
        },
      });
      child1.emitMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-reactive-1',
            title: 'run_command',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'npm run build' },
          },
        },
      });
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

      // Unexpected ACP process crash / disconnect
      child1.exitCode = 137;
      child1.emit('close', 137);
      await Promise.resolve();

      // Verify connection-updated emitted connected: false
      expect(connEvents.some((e) => e.connected === false)).toBe(true);

      // Verify open assistant message settled with acp_disconnected and running tool is no longer running
      const afterDisconnect = await readAllSessionMessages(core, session.sessionId);
      const openAssistant = afterDisconnect.find((m) => m.role === 'assistant');
      expect(openAssistant).toBeDefined();
      expect(openAssistant!.isStreaming).toBe(false);
      expect(openAssistant!.turnStop?.code).toBe('acp_disconnected');
      const reactiveTool = openAssistant!.toolCalls?.find((tc) => tc.toolCallId === 'tc-reactive-1');
      expect(reactiveTool).toBeDefined();
      expect(reactiveTool!.status).not.toBe('running');
      expect(reactiveTool!.status).not.toBe('pending');

      // Flush any short (<= 500ms) benign debounce/telemetry timers, then assert ZERO dangling 8s reactive timers remain!
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.getTimerCount()).toBe(0);

      const postDisconnectSessions: ManagedSessionSummary[] = [];
      const postDisconnectMessages: ChatMessageItem[] = [];
      core.on('session-updated', (s: ManagedSessionSummary) => postDisconnectSessions.push(s));
      core.on('message-upserted', (p: { message: ChatMessageItem }) => postDisconnectMessages.push(p.message));

      // Advance 32s (4x the 8000ms reactive poll period) -> zero leaked callbacks
      await vi.advanceTimersByTimeAsync(32_000);
      expect(postDisconnectSessions).toHaveLength(0);
      expect(postDisconnectMessages).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    // Reconnect via resumeSession and verify full recovery + prompt execution
    const resumed = await core.resumeSession(session.sessionId, dir);
    expect(resumed.status).toBe('idle');
    expect(resumed.readOnly).toBe(false);
    expect(resumed.diagnostic).toBeUndefined();
    expect(connEvents.at(-1)?.connected).toBe(true);

    await core.sendPrompt({ sessionId: session.sessionId, text: 'Are you back?' });
    const finalMsgs = await readAllSessionMessages(core, session.sessionId);
    expect(finalMsgs.some((m) => m.role === 'assistant' && m.content.includes('Reconnected OK!'))).toBe(true);
  });
});

/* ============================================================================
 * 5. B-P1-1: CoreService.resumeSession error surfacing & diagnostic fallback
 * ========================================================================== */

describe('B-P1-1: CoreService.resumeSession never swallows concurrency cap or 429/403 and attaches resume_failed on offline fallback', () => {
  it('rejects instead of silently downgrading to readOnly when 4-session concurrency cap is hit or 429/403 occurs, and marks offline fallback with diagnostic.code === "resume_failed"', async () => {
    const { dir, core, session, emitChunk, setConnected, startSpy, setResumeHandler } = await createSpyCore({
      agentName: 'Antigravity CLI',
    });

    // Save at least one local turn on `session`, then close it so it is a saved local session
    await core.sendPrompt({ sessionId: session.sessionId, text: 'Persist local history' });
    emitChunk('Saved reply');
    await core.closeSession(session.sessionId);

    // 1) Fill all 4 active session slots
    const activeSessions: ManagedSessionSummary[] = [];
    for (let i = 0; i < 4; i++) {
      activeSessions.push(await core.createSession({ cwd: dir, title: `Active ${i + 1}` }));
    }
    expect(core.sessions.activeSessionCount).toBe(4);

    // Attempting to resume saved session while at 4-session cap MUST throw (NOT silently return readOnly: true)
    await expect(core.resumeSession(session.sessionId, dir)).rejects.toThrow(/4|活动会话|上限/);

    // Free one slot for subsequent tests
    await core.closeSession(activeSessions[0].sessionId);

    // 2) 429 rate-limit during resume MUST throw (NOT silently downgrade to readOnly)
    setResumeHandler(() => {
      throw new AcpRpcError(429, 'RESOURCE_EXHAUSTED');
    });
    await expect(core.resumeSession(session.sessionId, dir)).rejects.toThrow(/429|RESOURCE_EXHAUSTED|配额|频率/);

    // 3) 403 permission error during resume MUST throw (NOT silently downgrade to readOnly)
    setResumeHandler(() => {
      throw new AcpRpcError(403, 'PERMISSION_DENIED');
    });
    await expect(core.resumeSession(session.sessionId, dir)).rejects.toThrow(/403|PERMISSION_DENIED|权限/);

    // 4) Genuine offline/disconnected failure -> read-only fallback WITH diagnostic.code === 'resume_failed'
    setConnected(false);
    startSpy.mockRejectedValueOnce(new Error('官方 ACP 进程已退出'));
    const offlineFallback = await core.resumeSession(session.sessionId, dir);
    expect(offlineFallback.readOnly).toBe(true);
    expect(offlineFallback.status).toBe('closed');
    expect(offlineFallback.diagnostic?.code).toBe('resume_failed');
  });
});
