// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, validateAgyArgs } from '../src/main/acp/acp-client';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import { CoreService } from '../src/main/core-service';
import { CHINESE_SESSION_GUIDANCE } from '../src/main/session/session-multiplexer';
import { ClientStore } from '../src/main/storage/client-store';
import { readAllSessionMessages } from './helpers/core-bridge';
import {
  EXECUTION_MODE_ORDER,
  FORBIDDEN_AGY_FLAGS,
  isToolCallFailure,
  SAFE_CYCLE_EXECUTION_MODES,
  type AcpConfigOption,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionPromptParams,
  type AcpSessionPromptResult,
  type PendingApprovalRequest,
} from '@shared';

/* ============================================================================
 * Helpers & Fixtures
 * ========================================================================== */

const tempDirs: string[] = [];
const engines: ApprovalEngine[] = [];
const services: CoreService[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makePerm(
  overrides: {
    sessionId?: string;
    toolCallId?: string;
    kind?: string;
    title?: string;
    rawInput?: string | Record<string, unknown>;
    locations?: Array<{ path: string }>;
  } = {}
): AcpRequestPermissionParams {
  return {
    sessionId: overrides.sessionId ?? 'sess-turbo',
    toolCall: {
      toolCallId: overrides.toolCallId ?? `tc-${Math.random().toString(36).slice(2, 9)}`,
      kind: overrides.kind ?? 'execute',
      title: overrides.title ?? 'run_command',
      rawInput: overrides.rawInput ?? { CommandLine: 'rm -rf dist' },
      ...(overrides.locations ? { locations: overrides.locations } : {}),
    },
    options: [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
    ],
  };
}

async function evaluatePermission(
  engine: ApprovalEngine,
  params: AcpRequestPermissionParams,
  cwd: string
): Promise<{ escalated: boolean; card?: PendingApprovalRequest; result: AcpRequestPermissionResult }> {
  let escalatedCard: PendingApprovalRequest | undefined;
  const onRequested = (card: PendingApprovalRequest) => {
    if (card.sessionId === params.sessionId && card.toolCallId === params.toolCall.toolCallId) {
      escalatedCard = card;
      engine.cancelPending(params.sessionId);
    }
  };
  engine.on('requested', onRequested);
  try {
    const result = await engine.requestPermission(params, cwd);
    return { escalated: Boolean(escalatedCard), card: escalatedCard, result };
  } finally {
    engine.off('requested', onRequested);
  }
}

function listTypeScriptFiles(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:ts|tsx|mts|cts|js|cjs|mjs)$/i.test(entry.name)) results.push(full);
    }
  };
  walk(rootDir);
  return results;
}

async function createSpyCore(options?: {
  useLegacyModes?: boolean;
  initialRateLimited?: boolean;
}) {
  const dir = makeTempDir('gravity-v032-turbo-stop-');
  const client = new AcpClient();
  const initResult = {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity CLI', version: '1.2.0' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
  };
  client.initializeResult = initResult;
  let connected = true;
  let rateLimited = Boolean(options?.initialRateLimited);
  vi.spyOn(client, 'connected', 'get').mockImplementation(() => connected);
  vi.spyOn(client, 'isRateLimited', 'get').mockImplementation(() => rateLimited);
  vi.spyOn(client, 'start').mockImplementation(async () => {
    connected = true;
    return initResult;
  });
  vi.spyOn(client, 'notify').mockImplementation(() => {});

  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const prompts: AcpSessionPromptParams[] = [];
  let seq = 0;

  let promptHandler: (
    params: AcpSessionPromptParams,
    attempt: number
  ) => Promise<AcpSessionPromptResult> | AcpSessionPromptResult = () => ({
    stopReason: 'end_turn',
    usage: { inputTokens: 30, outputTokens: 15 },
  });

  const makeModeConfigOptions = (currentValue = 'default'): AcpConfigOption[] => [
    {
      id: 'mode',
      name: 'Mode',
      currentValue,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept Edits' },
        { value: 'plan', name: 'Plan' },
        { value: 'full-access', name: 'Turbo' },
      ],
    },
  ];

  vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    const rec = (params || {}) as Record<string, unknown>;
    rpcCalls.push({ method, params: rec });
    if (method === 'session/new') {
      const sessionId = `sess-v032-${++seq}`;
      if (options?.useLegacyModes) {
        return {
          sessionId,
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'accept-edits', name: 'Accept Edits' },
              { id: 'plan', name: 'Plan' },
              { id: 'full-access', name: 'Turbo' },
            ],
          },
        };
      }
      return {
        sessionId,
        configOptions: makeModeConfigOptions('default'),
      };
    }
    if (method === 'session/set_config_option') {
      return {
        configOptions: makeModeConfigOptions(String(rec.value || 'default')),
      };
    }
    if (method === 'session/set_mode') {
      return {};
    }
    if (method === 'session/prompt') {
      const p = params as AcpSessionPromptParams;
      prompts.push(p);
      return promptHandler(p, prompts.length);
    }
    if (method === 'session/close') return {};
    return {};
  });

  // Expose permission handler trigger for simulating official ACP reverse RPCs
  let permissionHandler: ((raw: unknown, id: number) => unknown | Promise<unknown>) | undefined;
  const origRegister = client.registerRequestHandler.bind(client);
  vi.spyOn(client, 'registerRequestHandler').mockImplementation((method, handler) => {
    if (method === 'session/request_permission') {
      permissionHandler = handler as (raw: unknown, id: number) => unknown | Promise<unknown>;
    }
    return origRegister(method, handler);
  });

  const core = new CoreService({
    acp: client,
    dataDir: dir,
    homeDir: path.join(dir, 'home'),
    enableAutoUpdateCheck: false,
  });
  services.push(core);

  return {
    dir,
    client,
    core,
    rpcCalls,
    prompts,
    setRateLimited(val: boolean) {
      rateLimited = val;
    },
    setPromptHandler(fn: typeof promptHandler) {
      promptHandler = fn;
    },
    async triggerPermission(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
      if (!permissionHandler) throw new Error('session/request_permission handler not registered');
      return (await permissionHandler(params, ++seq)) as AcpRequestPermissionResult;
    },
    emitChunk(sessionId: string, text: string) {
      client.emit('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    },
    emitToolUpdate(
      sessionId: string,
      update: Record<string, unknown> & { sessionUpdate: 'tool_call' | 'tool_call_update'; toolCallId: string }
    ) {
      client.emit('session/update', { sessionId, update });
    },
  };
}

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose().catch(() => {});
  for (const e of engines.splice(0)) e.dispose();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  vi.restoreAllMocks();
});

/* ============================================================================
 * 1. Wave 0 Shared Contracts & Static Anti-Ban Compliance Scan (Expected GREEN on Wave 0)
 * ========================================================================== */

describe('Wave 0 Turbo & Silent-Stop Shared Contracts + Anti-Ban Compliance', () => {
  it('includes full-access in EXECUTION_MODE_ORDER while keeping SAFE_CYCLE_EXECUTION_MODES free of full-access', () => {
    expect(EXECUTION_MODE_ORDER).toContain('full-access');
    expect(SAFE_CYCLE_EXECUTION_MODES).toEqual(['default', 'accept-edits', 'plan']);
    expect(SAFE_CYCLE_EXECUTION_MODES).not.toContain('full-access');
  });

  it('static compliance scan: ZERO occurrences of --dangerously-skip-permissions in src/main/** and validateAgyArgs rejects it', () => {
    expect(FORBIDDEN_AGY_FLAGS).toContain('--dangerously-skip-permissions');
    expect(() => validateAgyArgs(['acp', '--dangerously-skip-permissions'])).toThrow();

    const mainRoot = path.resolve(process.cwd(), 'src', 'main');
    const files = listTypeScriptFiles(mainRoot);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('--dangerously-skip-permissions')) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('isToolCallFailure accurately detects failed, rejected, and completed with non-zero exitCode', () => {
    expect(isToolCallFailure({ status: 'completed', exitCode: 0 })).toBe(false);
    expect(isToolCallFailure({ status: 'completed', exitCode: undefined })).toBe(false);
    expect(isToolCallFailure({ status: 'pending', exitCode: undefined })).toBe(false);
    expect(isToolCallFailure({ status: 'running', exitCode: undefined })).toBe(false);
    expect(isToolCallFailure({ status: 'completed', exitCode: 1 })).toBe(true);
    expect(isToolCallFailure({ status: 'completed', exitCode: 127 })).toBe(true);
    expect(isToolCallFailure({ status: 'failed', exitCode: undefined })).toBe(true);
    expect(isToolCallFailure({ status: 'rejected', exitCode: undefined })).toBe(true);
  });
});

/* ============================================================================
 * 2. Turbo (full-access) ACP Dispatch & Engine Pass-Through with D2 Anti-Ban Redlines
 * ========================================================================== */

describe('Turbo (full-access) protocol dispatch & D2 compliance firewall', () => {
  it('CoreService.setSessionMode(sid, "full-access") dispatches official ACP session/set_config_option', async () => {
    const { core, dir, rpcCalls } = await createSpyCore({ useLegacyModes: false });
    const session = await core.createSession({ cwd: dir });

    const updated = await core.setSessionMode(session.sessionId, 'full-access');
    expect(updated.executionMode).toBe('full-access');
    expect(rpcCalls).toContainEqual({
      method: 'session/set_config_option',
      params: { sessionId: session.sessionId, configId: 'mode', value: 'full-access' },
    });
  });

  it('CoreService.setSessionMode(sid, "full-access") falls back to official ACP session/set_mode for legacy servers', async () => {
    const { core, dir, rpcCalls } = await createSpyCore({ useLegacyModes: true });
    const session = await core.createSession({ cwd: dir });

    const updated = await core.setSessionMode(session.sessionId, 'full-access');
    expect(updated.executionMode).toBe('full-access');
    expect(rpcCalls).toContainEqual({
      method: 'session/set_mode',
      params: { sessionId: session.sessionId, modeId: 'full-access' },
    });
  });

  it('CoreService.createSession accepts executionMode="full-access" and handles current_mode_update notifications', async () => {
    const { core, client, dir } = await createSpyCore({ useLegacyModes: false });
    const created = await core.createSession({ cwd: dir, executionMode: 'full-access' });
    expect(created.executionMode).toBe('full-access');

    const normal = await core.createSession({ cwd: dir, executionMode: 'default' });
    client.emit('session/update', {
      sessionId: normal.sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'full-access' },
    });
    expect(core.sessions.get(normal.sessionId).executionMode).toBe('full-access');
  });

  it('Turbo mode auto-approves routine & high-risk actions with auto_approved_turbo / turbo-mode audit while STILL hard-denying credentials & ~/.gemini writes (D2)', async () => {
    const workspace = makeTempDir('gravity-v032-turbo-ws-');
    const outsideDir = makeTempDir('gravity-v032-turbo-out-');
    const storeDir = makeTempDir('gravity-v032-turbo-store-');
    const engine = new ApprovalEngine({
      store: new ClientStore(storeDir),
      config: { mode: 'manual' }, // Even under manual global mode, Turbo session bypasses prompts!
    });
    engines.push(engine);

    engine.setSessionExecutionMode('sess-turbo', 'full-access');
    engine.setSessionExecutionMode('sess-normal', 'default');

    // 1) Routine & high-risk operations pass with 0 popups + auto_approved_turbo / turbo-mode audit
    const turboPassCases: Array<{ label: string; perm: AcpRequestPermissionParams }> = [
      {
        label: 'workspace .sh script write',
        perm: makePerm({
          sessionId: 'sess-turbo',
          kind: 'edit',
          title: 'write_file',
          rawInput: { Path: path.join(workspace, 'deploy.sh'), Content: '#!/bin/sh\necho deploy\n' },
        }),
      },
      {
        label: 'recursive deletion rm -rf dist',
        perm: makePerm({
          sessionId: 'sess-turbo',
          rawInput: { CommandLine: 'rm -rf dist' },
        }),
      },
      {
        label: 'git push --force',
        perm: makePerm({
          sessionId: 'sess-turbo',
          rawInput: { CommandLine: 'git push --force origin feat/v032' },
        }),
      },
      {
        label: 'cross-workspace write outside cwd',
        perm: makePerm({
          sessionId: 'sess-turbo',
          kind: 'edit',
          title: 'write_file',
          rawInput: { Path: path.join(outsideDir, 'notes.txt'), Content: 'outside turbo ok' },
        }),
      },
      {
        label: 'non-readonly MCP tool',
        perm: makePerm({
          sessionId: 'sess-turbo',
          kind: 'other',
          title: 'mcp_linear_delete_issue',
          rawInput: { issueId: 'ENG-100' },
        }),
      },
    ];

    for (const tc of turboPassCases) {
      const outcome = await evaluatePermission(engine, tc.perm, workspace);
      expect(outcome.escalated, `Turbo must NOT prompt for ${tc.label}`).toBe(false);
      expect(outcome.result, tc.label).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
      expect(engine.listAudit()[0], tc.label).toMatchObject({
        verdict: 'auto_approved_turbo',
        decisionSource: 'turbo-mode',
      });
    }

    // 2) Anti-ban Redlines #1-#2 (D2): Credentials & official ~/.gemini writes MUST STILL BE HARD-DENIED!
    const antiBanCases: Array<{ label: string; perm: AcpRequestPermissionParams }> = [
      {
        label: 'read .gemini oauth credentials',
        perm: makePerm({
          sessionId: 'sess-turbo',
          rawInput: { CommandLine: 'cat ~/.gemini/oauth_creds.json' },
        }),
      },
      {
        label: 'read .gemini state.vscdb',
        perm: makePerm({
          sessionId: 'sess-turbo',
          kind: 'read',
          title: 'read_file',
          rawInput: { Path: '~/.gemini/antigravity/state.vscdb' },
        }),
      },
      {
        label: 'read .env credentials',
        perm: makePerm({
          sessionId: 'sess-turbo',
          rawInput: { CommandLine: 'cat .env' },
        }),
      },
      {
        label: 'write to ~/.gemini official scratch directory',
        perm: makePerm({
          sessionId: 'sess-turbo',
          kind: 'edit',
          title: 'write_file',
          rawInput: {
            Path: '~/.gemini/antigravity-cli/brain/sess-turbo/scratch/run.py',
            Content: 'print("should be blocked")',
          },
        }),
      },
      {
        label: 'shell redirect into ~/.gemini official directory',
        perm: makePerm({
          sessionId: 'sess-turbo',
          rawInput: { CommandLine: 'echo bad > ~/.gemini/antigravity/config.json' },
        }),
      },
    ];

    for (const tc of antiBanCases) {
      const outcome = await evaluatePermission(engine, tc.perm, workspace);
      expect(outcome.escalated, `D2 anti-ban must hard-deny without prompting: ${tc.label}`).toBe(false);
      expect(outcome.result, `D2 anti-ban must reject: ${tc.label}`).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
      expect(engine.listAudit()[0], tc.label).toMatchObject({
        verdict: 'denied',
        decisionSource: 'local-rule',
      });
    }

    // 3) Isolation: another session in default mode MUST still prompt for rm -rf dist
    const normalOutcome = await evaluatePermission(
      engine,
      makePerm({ sessionId: 'sess-normal', rawInput: { CommandLine: 'rm -rf dist' } }),
      workspace
    );
    expect(normalOutcome.escalated).toBe(true);
  });
});

/* ============================================================================
 * 3. Silent Stop Reproduction (Pre-tool Text + exitCode=1 + Policy Block + Non-Empty Echo)
 * ========================================================================== */

describe('Silent Stop reproduction & recovery (STOP-01 ~ STOP-05)', () => {
  const PRE_TOOL_TEXT =
    '我马上检查测试服务的实时日志并做一次配置诊断，很快就能定位具体原因。';

  it('reproduces the silent-stop scenario: prepends policy reason over non-empty echo, marks both tools as failures, and triggers 1 bounded auto-continuation despite pre-tool text', async () => {
    const { core, dir, prompts, setPromptHandler, triggerPermission, emitChunk, emitToolUpdate } =
      await createSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    setPromptHandler(async (_params, attempt) => {
      if (attempt === 1) {
        // 1) Pre-tool assistant text (historically fooled hasSubstantiveReply!)
        emitChunk(sid, PRE_TOOL_TEXT);

        // 2) Tool 1: completed with exitCode: 1 (Python syntax error)
        emitToolUpdate(sid, {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-ssh-py',
          title: 'run_command',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { CommandLine: 'python3 -c "bad syntax' },
        });
        emitToolUpdate(sid, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-ssh-py',
          status: 'completed',
          rawOutput: { stdout: 'SyntaxError: unterminated string literal', exitCode: 1 },
        });

        // 3) Tool 2: writes ~/.gemini/.../scratch/ -> local policy hard-denies, yet agy returns non-empty echo!
        const denyRes = await triggerPermission(
          makePerm({
            sessionId: sid,
            toolCallId: 'tc-scratch-blocked',
            kind: 'edit',
            title: 'write_file',
            rawInput: {
              Path: '~/.gemini/antigravity-cli/brain/sess-1/scratch/diag.py',
              Content: 'print("diag")',
            },
          })
        );
        expect(denyRes).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });

        emitToolUpdate(sid, {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-scratch-blocked',
          title: 'write_file',
          kind: 'edit',
          status: 'in_progress',
          rawInput: { Path: '~/.gemini/antigravity-cli/brain/sess-1/scratch/diag.py', Content: 'print("diag")' },
        });
        emitToolUpdate(sid, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-scratch-blocked',
          status: 'failed',
          // Non-empty echo from agy that previously hid the local safety policy block reason (STOP-03)!
          rawOutput: { stdout: 'sed -n "1,20p" /etc/sample-app/config.json' },
        });

        // 4) ACP ends turn with NO new text after the two failed/blocked tools
        return { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 40 } };
      }

      // Auto-continuation turn succeeds with a clean post-tool summary
      emitChunk(sid, '已改用当前工作区 ./.gravity-scratch/diag.py 完成诊断，失败原因是配置端口冲突。');
      return { stopReason: 'end_turn', usage: { inputTokens: 160, outputTokens: 50 } };
    });

    await core.sendPrompt({ sessionId: sid, text: '帮我诊断本地测试服务启动失败的原因' });

    // Must trigger exactly 1 bounded auto-continuation despite Turn 1 having pre-tool text
    expect(prompts).toHaveLength(2);

    const messages = await readAllSessionMessages(core, sid);
    const turn1Assistant = messages.find((m) => m.role === 'assistant' && m.content.includes('我马上检查测试服务的实时日志'));
    expect(turn1Assistant).toBeDefined();

    const tool1 = turn1Assistant!.toolCalls?.find((tc) => tc.toolCallId === 'tc-ssh-py');
    const tool2 = turn1Assistant!.toolCalls?.find((tc) => tc.toolCallId === 'tc-scratch-blocked');
    expect(tool1).toBeDefined();
    expect(tool2).toBeDefined();

    // STOP-02: Both Tool 1 (exitCode: 1) and Tool 2 (policy-blocked -> rejected) must register as failures
    expect(isToolCallFailure(tool1!)).toBe(true);
    expect(isToolCallFailure(tool2!)).toBe(true);
    expect(tool2!.status).toBe('rejected');

    // STOP-03: Tool 2's outputPreview MUST prepend local safety policy block reason at the top (never lost to echo!)
    const preview = tool2!.outputPreview || '';
    const firstLine = preview.split(/\r?\n/, 1)[0] || '';
    expect(firstLine).toMatch(/本地安全策略|安全策略|拦截/);
    expect(preview).toContain('sed -n "1,20p" /etc/sample-app/config.json');
  });

  it('produces guaranteed turnStop (policy_blocked) when auto-continuation also yields no post-tool reply (bounded to 1 retry)', async () => {
    const { core, dir, prompts, setPromptHandler, triggerPermission, emitChunk, emitToolUpdate } =
      await createSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    setPromptHandler(async (_params, attempt) => {
      if (attempt === 1) {
        emitChunk(sid, PRE_TOOL_TEXT);
        await triggerPermission(
          makePerm({
            sessionId: sid,
            toolCallId: 'tc-block-2',
            kind: 'edit',
            title: 'write_file',
            rawInput: {
              Path: '~/.gemini/antigravity-cli/brain/sess-2/scratch/test.py',
              Content: 'print(1)',
            },
          })
        );
        emitToolUpdate(sid, {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-block-2',
          title: 'write_file',
          kind: 'edit',
          status: 'failed',
          rawOutput: { stdout: 'non-empty command echo' },
        });
        return { stopReason: 'end_turn' };
      }
      // Attempt 2 (the single bounded continuation) also produces NO substantive reply
      return { stopReason: 'end_turn' };
    });

    await core.sendPrompt({ sessionId: sid, text: '运行远程排查' });

    // Strictly bounded to 1 auto-continuation (total 2 prompts)
    expect(prompts).toHaveLength(2);

    const messages = await readAllSessionMessages(core, sid);
    const assistants = messages.filter((m) => m.role === 'assistant');
    const lastAssistant = assistants.at(-1);
    expect(lastAssistant?.turnStop).toBeDefined();
    expect(lastAssistant?.turnStop?.code).toBe('policy_blocked');
  });

  it('detects pure exitCode=1 tool failure after pre-tool text -> auto-continues once -> emits tool_failure_stopped if still empty', async () => {
    const { core, dir, prompts, setPromptHandler, emitChunk, emitToolUpdate } = await createSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    setPromptHandler(async (_params, attempt) => {
      if (attempt === 1) {
        emitChunk(sid, '我先跑一下诊断脚本看看输出。');
        emitToolUpdate(sid, {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-exit1-only',
          title: 'run_command',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { CommandLine: 'python3 diag.py' },
        });
        emitToolUpdate(sid, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-exit1-only',
          status: 'completed',
          rawOutput: { stderr: 'SyntaxError: invalid syntax', exitCode: 1 },
        });
        return { stopReason: 'end_turn' };
      }
      return { stopReason: 'end_turn' };
    });

    await core.sendPrompt({ sessionId: sid, text: '排查报错' });

    expect(prompts).toHaveLength(2);
    const messages = await readAllSessionMessages(core, sid);
    const lastAssistant = messages.filter((m) => m.role === 'assistant').at(-1);
    expect(lastAssistant?.turnStop).toBeDefined();
    expect(lastAssistant?.turnStop?.code).toBe('tool_failure_stopped');
  });

  it('does NOT spuriously auto-continue or emit turnStop when model emits genuine post-tool reply after a failing tool', async () => {
    const { core, dir, prompts, setPromptHandler, emitChunk, emitToolUpdate } = await createSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    setPromptHandler(async () => {
      emitChunk(sid, '我先测试一下命令。');
      emitToolUpdate(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-handled-exit1',
        title: 'run_command',
        kind: 'execute',
        status: 'completed',
        rawInput: { CommandLine: 'python3 -c "bad"' },
        rawOutput: { stderr: 'SyntaxError', exitCode: 1 },
      });
      // Genuine post-tool substantive reply explaining the failure
      emitChunk(sid, '\n命令因语法错误退出（exit 1），已定位到根因并给出修复方案。');
      return { stopReason: 'end_turn' };
    });

    await core.sendPrompt({ sessionId: sid, text: '执行检查' });

    expect(prompts).toHaveLength(1);
    const messages = await readAllSessionMessages(core, sid);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.turnStop).toBeUndefined();
  });

  it('Compliance Redline #7: NEVER triggers auto-continuation during 429 rate-limit cooldown, yet still emits turnStop on the silent-stopped message', async () => {
    const { core, dir, prompts, setRateLimited, setPromptHandler, emitChunk, emitToolUpdate } =
      await createSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    setPromptHandler(async () => {
      emitChunk(sid, PRE_TOOL_TEXT);
      emitToolUpdate(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-429-fail',
        title: 'run_command',
        kind: 'execute',
        status: 'completed',
        rawInput: { CommandLine: 'python3 diag.py' },
        rawOutput: { stderr: 'exit 1', exitCode: 1 },
      });
      // Simulate ACP entering 429 cooldown before turn completes
      setRateLimited(true);
      return { stopReason: 'end_turn' };
    });

    await core.sendPrompt({ sessionId: sid, text: '诊断问题' });

    // Strictly 0 auto-continuation prompts during 429 cooldown!
    expect(prompts).toHaveLength(1);

    const messages = await readAllSessionMessages(core, sid);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.turnStop).toBeDefined();
    expect(assistant?.turnStop?.code).toBe('tool_failure_stopped');
  });

  it('STOP-05 / Decision D3: CHINESE_SESSION_GUIDANCE directs temporary scripts to workspace instead of ~/.gemini', () => {
    expect(CHINESE_SESSION_GUIDANCE).toMatch(/\.gravity-scratch|工作区|临时/);
    expect(CHINESE_SESSION_GUIDANCE).toMatch(/\.gemini/);
  });
});
