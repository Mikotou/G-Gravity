// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  containsTransientStreamInterruption,
  DEFAULT_MODEL_RATE_CARDS,
  resolveModelCompactionLimit,
  stripTransientStreamInterruptions,
} from '../src/shared';
import { CoreService } from '../src/main/core-service';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import { inspectGeminiPathPolicy, isMutatingShellCommand } from '../src/main/approval/shell-screening';
import {
  decodeCheckpointMaxTokenLimit,
  readSessionCheckpointLimit,
} from '../src/main/telemetry/checkpoint-limit-reader';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { ClientStore } from '../src/main/storage/client-store';
import {
  compareSemver,
  GitHubUpdater,
  isAllowedGitHubUpdateUrl,
  selectReleaseAsset,
} from '../src/main/updater/github-updater';
import { prepareMockAcp } from './helpers/stdio-rpc';

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeProtoFieldVarint(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

function encodeProtoFieldBytes(field: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload]);
}

function buildExecutorMetadataBlob(maxTokenLimit: number): Buffer {
  const checkpointConfig = encodeProtoFieldVarint(5, maxTokenLimit);
  const cascadeConfig = encodeProtoFieldBytes(2, checkpointConfig);
  return encodeProtoFieldBytes(10, cascadeConfig);
}

const dirs: string[] = [];
const disposers: Array<() => Promise<void> | void> = [];

function mkDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of disposers.splice(0)) await fn();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('瞬态流式中断提示自动清理（stream interruption recovery）', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => {
    fixture = await prepareMockAcp();
  });
  afterAll(async () => {
    await fixture?.cleanup();
  });

  it('纯函数精准识别并剥离瞬态断连提示，同时完整保留真实正文', () => {
    const warn = '⚠ The stream was interrupted. Please continue the task you were working on.';
    expect(containsTransientStreamInterruption(warn)).toBe(true);
    expect(stripTransientStreamInterruptions(warn)).toBe('');

    const mixed = `${warn}\n\n已完成分析：新模型上下文上限为 512k。`;
    expect(containsTransientStreamInterruption(mixed)).toBe(true);
    expect(stripTransientStreamInterruptions(mixed)).toBe('已完成分析：新模型上下文上限为 512k。');

    const normal = '正常回复内容，包含 ⚠ 图标但不是断连提示。';
    expect(containsTransientStreamInterruption(normal)).toBe(false);
    expect(stripTransientStreamInterruptions(normal)).toBe(normal);
  });

  it('流式运行中收到断连提示后，只要后续思考/工具/正文恢复，提示立即自动消失', async () => {
    const dataDir = mkDir('gravity-v021-stream-');
    const children: ChildProcess[] = [];
    const core = new CoreService({
      dataDir,
      acpOptions: {
        spawn: (_b, _a, opts) => {
          const child = spawn(fixture.executable, fixture.args, opts);
          children.push(child);
          return child;
        },
        requestTimeoutMs: 2000,
      },
    });
    disposers.push(() => core.dispose());

    const session = await core.createSession({ cwd: dataDir });
    const sid = session.sessionId;

    // 模拟流式断连警告进入助手消息
    core.client.emit('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '⚠ The stream was interrupted. Please continue the task you were working on.' },
      },
    });
    let msgs = await core.getSessionMessages(sid);
    expect(msgs.at(-1)?.content).toContain('The stream was interrupted');

    // 模拟流恢复：新的工具调用到达 → 断连提示应立即被剥离
    core.client.emit('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-recover-1',
        title: 'read_file',
        kind: 'read',
        status: 'in_progress',
        rawInput: { Path: 'README.md' },
      },
    });
    msgs = await core.getSessionMessages(sid);
    expect(msgs.at(-1)?.content).toBe('');

    // 再次模拟断连后直接恢复正文输出
    core.client.emit('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '⚠ The stream was interrupted. Please continue the task you were working on.\n' },
      },
    });
    core.client.emit('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '流已恢复，这是最终完整答复。' },
      },
    });
    msgs = await core.getSessionMessages(sid);
    expect(msgs.at(-1)?.content).toBe('流已恢复，这是最终完整答复。');
  });
});

describe('新模型 Neon 及未来模型压缩上下文窗口动态读取与持久化学习', () => {
  it('默认契约覆盖 gemini-4-neon（512k）与费率表，Protobuf 及实验 JSON 均准确解析', () => {
    expect(resolveModelCompactionLimit('gemini-4-neon')).toBe(512_000);
    expect(resolveModelCompactionLimit('gemini-4-neon-high')).toBe(512_000);
    expect(DEFAULT_MODEL_RATE_CARDS.some((c) => c.modelId === 'gemini-4-neon')).toBe(true);

    expect(decodeCheckpointMaxTokenLimit(buildExecutorMetadataBlob(512_000))).toBe(512_000);
    expect(decodeCheckpointMaxTokenLimit(buildExecutorMetadataBlob(768_000))).toBe(768_000);

    // 兼容 CASCADE_USE_EXPERIMENT_CHECKPOINTER JSON 字符串兜底
    const expBlob = Buffer.from(
      'prefix\0CASCADE_USE_EXPERIMENT_CHECKPOINTER\0{"max_token_limit":"640000"}\0suffix',
      'utf8'
    );
    expect(decodeCheckpointMaxTokenLimit(expBlob)).toBe(640_000);
  });

  it('executor_metadata 末尾行无配置时回溯前序行读取，并在 TelemetryStore 按模型学习持久化', async () => {
    const fakeHome = mkDir('gravity-v021-home-');
    const cacheDir = mkDir('gravity-v021-chkcache-');
    const storeDir = mkDir('gravity-v021-telem-');
    const sessionId = 'session_neon_test_001';
    const convDir = path.join(fakeHome, '.gemini', 'antigravity-cli', 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = path.join(convDir, `${sessionId}.db`);

    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      // idx=0 包含真实 768k 压缩阈值；idx=1 是无 cascade_config 的增量状态行
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(0, buildExecutorMetadataBlob(768_000));
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(1, Buffer.from('status-only-row'));
    } finally {
      db.close();
    }

    const limit = await readSessionCheckpointLimit({ sessionId, cacheDir, homeDir: fakeHome });
    expect(limit).toBe(768_000);

    // TelemetryStore 写入一次后学习到该未来模型上限，新会话首秒即生效，重启后依然保留
    const store1 = new TelemetryStore({ store: new ClientStore(storeDir) });
    store1.ensure(sessionId, 'gemini-5-nova');
    store1.setCheckpointWindowLimit(sessionId, 768_000, 'gemini-5-nova');
    expect(store1.snapshot().activeSessions[sessionId].maxContextTokens).toBe(768_000);

    // 同一模型的新会话直接继承已学习到的 768k，无需等第一轮完成
    store1.ensure('session_nova_second', 'gemini-5-nova');
    expect(store1.snapshot().activeSessions['session_nova_second'].maxContextTokens).toBe(768_000);

    // 切换模型后立即刷新为目标模型的上限
    store1.clearSessionCheckpointLimit('session_nova_second', 'claude-sonnet-4-6');
    expect(store1.snapshot().activeSessions['session_nova_second'].maxContextTokens).toBe(256_000);
    store1.dispose();

    // 重启后从 session-telemetry.json 恢复学习值
    const store2 = new TelemetryStore({ store: new ClientStore(storeDir) });
    store2.ensure('session_nova_after_restart', 'gemini-5-nova');
    expect(store2.snapshot().activeSessions['session_nova_after_restart'].maxContextTokens).toBe(768_000);
    store2.dispose();
  });
});

describe('命令失败或安全拦截后自动有界续接（防止彻底停止回复）', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  beforeAll(async () => {
    fixture = await prepareMockAcp();
  });
  afterAll(async () => {
    await fixture?.cleanup();
  });

  it('当工具调用因本地安全策略拦截导致整轮无正文提前结束时，注释失败原因并自动续接 1 次完成回复', async () => {
    const dataDir = mkDir('gravity-v021-recover-');
    const core = new CoreService({
      dataDir,
      acpOptions: {
        spawn: (_b, _a, opts) => spawn(fixture.executable, fixture.args, opts),
        requestTimeoutMs: 2000,
      },
    });
    disposers.push(() => core.dispose());

    const session = await core.createSession({ cwd: dataDir });
    const sid = session.sessionId;
    const origRequest = core.client.request.bind(core.client);
    let promptCalls = 0;

    vi.spyOn(core.client, 'request').mockImplementation(async (method, params, timeout) => {
      if (method === 'session/prompt') {
        promptCalls += 1;
        if (promptCalls === 1) {
          // 模拟第 1 轮：模型调用含 .gemini 的命令触发安全拦截，官方 ACP 返回空输出失败并提前结束回合
          core.client.emit('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-denied-1',
              title: 'run_command',
              kind: 'execute',
              status: 'in_progress',
              rawInput: { CommandLine: 'cat ~/.gemini/oauth_creds.json' },
            },
          });
          await core.approval.requestPermission(
            {
              sessionId: sid,
              toolCall: {
                toolCallId: 'tc-denied-1',
                title: 'run_command',
                kind: 'execute',
                rawInput: { CommandLine: 'cat ~/.gemini/oauth_creds.json' },
              },
              options: [
                { optionId: 'allow-once', name: '允许', kind: 'allow_once' },
                { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
              ],
            },
            dataDir
          );
          core.client.emit('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-denied-1',
              status: 'failed',
              rawOutput: { output: '' },
            },
          });
          return { stopReason: 'cancelled' };
        }
        // 第 2 轮（自动续接）：模型基于已获取信息给出完整答复
        core.client.emit('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '已跳过受限目录并完成最终分析。' },
          },
        });
        return { stopReason: 'end_turn' };
      }
      return origRequest(method, params, timeout);
    });

    await core.sendPrompt({ sessionId: sid, text: '帮我分析使用情况' });
    expect(promptCalls).toBe(2);

    const msgs = await core.getSessionMessages(sid);
    const firstAssistant = msgs.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(firstAssistant?.toolCalls?.[0]?.outputPreview).toContain('本地安全策略拦截');
    expect(msgs.some((m) => m.role === 'system' && m.content.includes('自动通知模型跳过受限项'))).toBe(true);
    expect(msgs.at(-1)?.role).toBe('assistant');
    expect(msgs.at(-1)?.content).toContain('已跳过受限目录并完成最终分析');
  });

  it('无边框窗口模式与主题同步回调正确暴露，且保持 Electron 强沙箱配置', async () => {
    const dataDir = mkDir('gravity-v021-chrome-');
    const onThemeChanged = vi.fn();
    const core = new CoreService({
      dataDir,
      windowChrome: 'win-overlay',
      onThemeChanged,
      acpOptions: {
        spawn: (_b, _a, opts) => spawn(fixture.executable, fixture.args, opts),
        requestTimeoutMs: 2000,
      },
    });
    disposers.push(() => core.dispose());

    const boot = await core.getBootstrap();
    expect(boot.windowChrome).toBe('win-overlay');

    await core.updatePreferences({ theme: 'claude-code-light' });
    expect(onThemeChanged).toHaveBeenCalledTimes(1);
    expect(onThemeChanged.mock.calls[0][0].theme).toBe('claude-code-light');

    const mainEntry = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    expect(mainEntry).toContain("titleBarStyle: 'hidden'");
    expect(mainEntry).toContain('titleBarOverlay');
    expect(mainEntry).toContain("titleBarStyle: 'hiddenInset'");
    expect(mainEntry).toContain('contextIsolation: true');
    expect(mainEntry).toContain('sandbox: true');
  });
});

describe('.gemini 三级精细安全策略（绝不触碰凭据、官方运行区严格只读、用户自定义区可控访问）', () => {
  function makeEngine(mode: 'manual' | 'rules-only' | 'hybrid' = 'hybrid') {
    const dir = mkDir('gravity-v021-gemini-policy-');
    const engine = new ApprovalEngine({ store: new ClientStore(dir), config: { mode } });
    disposers.push(() => engine.dispose());
    return engine;
  }

  function permParams(toolCall: Record<string, unknown>) {
    return {
      sessionId: 'sess-gemini-policy',
      toolCall: { toolCallId: 'tc-1', ...toolCall } as any,
      options: [
        { optionId: 'allow-once', name: '允许', kind: 'allow_once' as const },
        { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' as const },
      ],
    };
  }

  it('Tier 1 绝对禁区：凭据、令牌、状态库、.pb、官方 bin 及 .. 穿越一律硬拒绝（读写全禁）', async () => {
    const engine = makeEngine('hybrid');
    const forbiddenCases = [
      { kind: 'read', title: 'read_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\oauth_creds.json' } },
      { kind: 'read', title: 'read_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\antigravity\\state.vscdb' } },
      { kind: 'read', title: 'read_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\antigravity\\installation_id' } },
      { kind: 'read', title: 'read_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\antigravity\\user_settings.pb' } },
      { kind: 'read', title: 'read_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\config\\plugins\\demo\\.env' } },
      { kind: 'read', title: 'read_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\config\\plugins\\..\\..\\oauth_creds.json' } },
      { kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'cat ~/.gemini/antigravity/bin/agy' } },
    ];
    for (const tc of forbiddenCases) {
      const res = await engine.requestPermission(permParams(tc), 'F:\\G-Gravity');
      expect(res.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
      expect(engine.listAudit()[0].verdict).toBe('denied');
    }
  });

  it('Tier 2 官方只读区（brain/conversations/builtin/settings.json）：只读放行，任何写入/编辑/删除硬拒绝', async () => {
    const engine = makeEngine('hybrid');

    // 只读查阅官方对话转录、内置技能文档、settings.json -> 放行
    for (const target of [
      'C:\\Users\\Admin\\.gemini\\antigravity-cli\\brain\\abc\\.system_generated\\logs\\transcript.jsonl',
      'C:\\Users\\Admin\\.gemini\\antigravity\\builtin\\skills\\agy-customizations\\SKILL.md',
      'C:\\Users\\Admin\\.gemini\\settings.json',
    ]) {
      const res = await engine.requestPermission(
        permParams({ kind: 'read', title: 'read_file', rawInput: { Path: target } }),
        'F:\\G-Gravity'
      );
      expect(res.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });
      expect(engine.listAudit()[0].verdict).toBe('auto_approved');
    }

    // 编辑或通过 Shell 重定向写入官方只读区 -> 一律硬拒绝
    const writeAttempts = [
      { kind: 'edit', title: 'edit_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\settings.json', Target: 'a', Replacement: 'b' } },
      { kind: 'edit', title: 'write_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\abc\\transcript.jsonl', Content: 'x' } },
      { kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'Set-Content "C:\\Users\\Admin\\.gemini\\settings.json" "{}"' } },
      { kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'echo x > ~/.gemini/antigravity/conversations/a.db' } },
    ];
    for (const tc of writeAttempts) {
      const res = await engine.requestPermission(permParams(tc), 'F:\\G-Gravity');
      expect(res.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
      expect(engine.listAudit()[0].verdict).toBe('denied');
    }
  });

  it('Tier 3 用户自定义扩展区（plugins/skills/GEMINI.md）：只读放行、复杂脚本与编辑改为弹窗人工确认而非一刀切拒死', async () => {
    const engine = makeEngine('hybrid');

    // 1. 纯只读读取插件日志 audit.jsonl -> 安全放行
    const readPluginLog = await engine.requestPermission(
      permParams({
        kind: 'read',
        title: 'read_file',
        rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\config\\plugins\\approve-for-me\\data\\audit.jsonl' },
      }),
      'F:\\G-Gravity'
    );
    expect(readPluginLog.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });

    // 2. 复杂 PowerShell 统计脚本读取插件 audit.jsonl（截图 4 同款场景）-> 弹窗给人工确认，不再静默 deny
    expect(
      isMutatingShellCommand(
        '$lines = Get-Content "C:\\Users\\Admin\\.gemini\\config\\plugins\\approve-for-me\\data\\audit.jsonl" | ForEach-Object { $_ | ConvertFrom-Json }'
      )
    ).toBe(false);
    const reqPromise = new Promise<any>((resolve) => engine.once('requested', resolve));
    const psRun = engine.requestPermission(
      permParams({
        kind: 'execute',
        title: 'run_command',
        rawInput: {
          CommandLine:
            '$lines = Get-Content "C:\\Users\\Admin\\.gemini\\config\\plugins\\approve-for-me\\data\\audit.jsonl" | ForEach-Object { $_ | ConvertFrom-Json }',
        },
      }),
      'F:\\G-Gravity'
    );
    const psCard = await reqPromise;
    expect(psCard.commandOrSummary).toContain('audit.jsonl');
    expect(psCard.riskLevel).toBe('high');
    await engine.submitDecision({ requestId: psCard.requestId, sessionId: 'sess-gemini-policy', decision: 'allow_once' });
    expect((await psRun).outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });

    // 3. 编辑 ~/.gemini/GEMINI.md 或自定义技能 SKILL.md -> 弹窗人工确认（不自动放行也不一刀切拒死）
    const editReq = new Promise<any>((resolve) => engine.once('requested', resolve));
    const editRun = engine.requestPermission(
      permParams({
        kind: 'edit',
        title: 'edit_file',
        rawInput: {
          Path: 'C:\\Users\\Admin\\.gemini\\config\\skills\\my-skill\\SKILL.md',
          Target: 'old',
          Replacement: 'new',
        },
      }),
      'F:\\G-Gravity'
    );
    const editCard = await editReq;
    expect(editCard.explanation.risk).toContain('用户自定义');
    await engine.submitDecision({ requestId: editCard.requestId, sessionId: 'sess-gemini-policy', decision: 'allow_once' });
    expect((await editRun).outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });

    // 4. 兜底：未知 .gemini 子文件读取交人工确认，写入硬拒绝
    expect(inspectGeminiPathPolicy('C:\\Users\\Admin\\.gemini\\unknown.dat').tier).toBe('unknown_gemini');
    const unknownWrite = await engine.requestPermission(
      permParams({ kind: 'edit', title: 'write_file', rawInput: { Path: 'C:\\Users\\Admin\\.gemini\\unknown.dat', Content: 'x' } }),
      'F:\\G-Gravity'
    );
    expect(unknownWrite.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
    expect(engine.listAudit()[0].verdict).toBe('denied');
  });

  it('macOS 文件权限覆盖：Keychain / Cookies / security / Antigravity 应用支持目录分级与 POSIX 写入拦截', async () => {
    const engine = makeEngine('hybrid');

    // 1. macOS 核心凭据与系统钥匙串 -> 一律硬拒绝
    const macForbidden = [
      { kind: 'read', title: 'read_file', rawInput: { Path: '/Users/alice/Library/Keychains/login.keychain-db' } },
      { kind: 'read', title: 'read_file', rawInput: { Path: '/Users/alice/Library/Cookies/Cookies.binarycookies' } },
      { kind: 'read', title: 'read_file', rawInput: { Path: '/Users/alice/Library/Application Support/Antigravity/Cookies' } },
      { kind: 'read', title: 'read_file', rawInput: { Path: '/Users/alice/Library/Application Support/Antigravity/User/globalStorage/state.vscdb' } },
      { kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'security find-generic-password -s "Antigravity" -w' } },
      { kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'cat /etc/sudoers' } },
    ];
    for (const tc of macForbidden) {
      const res = await engine.requestPermission(permParams(tc), '/Users/alice/workspace');
      expect(res.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
      expect(engine.listAudit()[0].verdict).toBe('denied');
    }

    // 2. macOS Antigravity User/settings.json -> 只读放行，编辑与 macOS 写入命令硬拒绝
    const readMacSettings = await engine.requestPermission(
      permParams({
        kind: 'read',
        title: 'read_file',
        rawInput: { Path: '/Users/alice/Library/Application Support/Antigravity/User/settings.json' },
      }),
      '/Users/alice/workspace'
    );
    expect(readMacSettings.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });

    const editMacSettings = await engine.requestPermission(
      permParams({
        kind: 'edit',
        title: 'edit_file',
        rawInput: {
          Path: '/Users/alice/Library/Application Support/Antigravity/User/settings.json',
          Target: 'a',
          Replacement: 'b',
        },
      }),
      '/Users/alice/workspace'
    );
    expect(editMacSettings.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });

    // macOS POSIX 改写命令检测：xattr / defaults write / chflags / plutil -replace / ditto
    expect(isMutatingShellCommand('xattr -cr ~/Library/Application\\ Support/Antigravity/User/settings.json')).toBe(true);
    expect(isMutatingShellCommand('defaults write com.google.antigravity Foo -bool true')).toBe(true);
    expect(isMutatingShellCommand('chflags hidden ~/Library/Application\\ Support/Antigravity/logs/a.log')).toBe(true);
    expect(isMutatingShellCommand('plutil -replace Foo -string Bar ~/a.plist')).toBe(true);
    expect(isMutatingShellCommand('defaults read com.google.antigravity')).toBe(false);

    // 3. macOS POSIX 转义空格路径同样正确归类，且 Gravity 自身目录不受误伤
    expect(
      inspectGeminiPathPolicy('cat ~/Library/Application\\ Support/Antigravity/User/settings.json').tier
    ).toBe('readonly_official');
    expect(
      inspectGeminiPathPolicy('/Users/alice/Library/Application Support/Gravity/messages-default.json').tier
    ).toBe('none');
  });
});

describe('GitHub Releases 自动更新引擎（安全域名白名单、平台匹配、403/429 网页回退与下载安装）', () => {
  it('语义版本号比较、GitHub 安全白名单与 Windows / macOS 平台资产选择准确无误', () => {
    expect(compareSemver('0.2.1', '0.2.0')).toBe(1);
    expect(compareSemver('v0.3.0', '0.2.1')).toBe(1);
    expect(compareSemver('0.2.1', 'v0.2.1')).toBe(0);
    expect(compareSemver('0.2.1-beta.1', '0.2.1')).toBe(-1);

    expect(isAllowedGitHubUpdateUrl('https://api.github.com/repos/Mikotou/G-Gravity/releases/latest')).toBe(true);
    expect(isAllowedGitHubUpdateUrl('https://github.com/Mikotou/G-Gravity/releases/download/v0.2.2/Gravity.exe')).toBe(true);
    expect(isAllowedGitHubUpdateUrl('https://release-assets.githubusercontent.com/pkg/Gravity.exe')).toBe(true);
    expect(isAllowedGitHubUpdateUrl('http://github.com/Mikotou/G-Gravity/releases/latest')).toBe(false);
    expect(isAllowedGitHubUpdateUrl('https://evil.example.com/Gravity.exe')).toBe(false);
    expect(isAllowedGitHubUpdateUrl('https://user:pass@github.com/Mikotou/G-Gravity')).toBe(false);

    const assets = [
      { name: 'Gravity.exe', downloadUrl: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.2.2/Gravity.exe', sizeBytes: 120_000_000 },
      { name: 'Gravity-0.2.2-mac-arm64.dmg', downloadUrl: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.2.2/Gravity-0.2.2-mac-arm64.dmg', sizeBytes: 110_000_000 },
      { name: 'Gravity-0.2.2-mac-arm64.zip', downloadUrl: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.2.2/Gravity-0.2.2-mac-arm64.zip', sizeBytes: 108_000_000 },
      { name: 'Gravity-0.2.2-mac-x64.dmg', downloadUrl: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.2.2/Gravity-0.2.2-mac-x64.dmg', sizeBytes: 112_000_000 },
      { name: 'Gravity-0.2.2-mac-x64.zip', downloadUrl: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.2.2/Gravity-0.2.2-mac-x64.zip', sizeBytes: 110_000_000 },
    ];
    expect(selectReleaseAsset(assets, 'win32', 'x64')?.name).toBe('Gravity.exe');
    expect(selectReleaseAsset(assets, 'darwin', 'arm64')?.name).toBe('Gravity-0.2.2-mac-arm64.zip');
    expect(selectReleaseAsset(assets, 'darwin', 'x64')?.name).toBe('Gravity-0.2.2-mac-x64.zip');
  });

  it('API 正常发现新版本、流式下载校验重定向白名单并触发安装回调', async () => {
    const updatesDir = mkDir('gravity-v021-updater-');
    const payload = Buffer.from('MZ-fake-gravity-binary-v0.2.2');
    const installHandler = vi.fn(async () => ({ launched: true, message: 'restarting' }));

    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.2.2',
            name: 'Gravity v0.2.2',
            body: '## Highlights\n- Smooth auto-update',
            html_url: 'https://github.com/Mikotou/G-Gravity/releases/tag/v0.2.2',
            published_at: '2026-11-20T08:00:00Z',
            assets: [
              {
                name: 'Gravity.exe',
                browser_download_url: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.2.2/Gravity.exe',
                size: payload.length,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.startsWith('https://github.com/Mikotou/G-Gravity/releases/download/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/assets/Gravity.exe' },
        });
      }
      if (url === 'https://objects.githubusercontent.com/assets/Gravity.exe') {
        return new Response(payload, {
          status: 200,
          headers: { 'content-length': String(payload.length) },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const updater = new GitHubUpdater({
      currentVersion: '0.2.1',
      updatesDir,
      platform: 'win32',
      arch: 'x64',
      canInstallDirectly: true,
      fetcher,
      installHandler,
    });

    const states: string[] = [];
    updater.on('state', (s) => states.push(s.status));

    const checked = await updater.checkForUpdates();
    expect(checked.status).toBe('available');
    expect(checked.latestVersion).toBe('0.2.2');
    expect(checked.asset?.name).toBe('Gravity.exe');

    const downloaded = await updater.downloadUpdate();
    expect(downloaded.status).toBe('downloaded');
    expect(downloaded.downloadedFilePath).toBeTruthy();
    expect(readFileSync(downloaded.downloadedFilePath!)).toEqual(payload);

    const installed = await updater.installUpdate();
    expect(installed.launched).toBe(true);
    expect(installHandler).toHaveBeenCalledTimes(1);
    expect(states).toContain('checking');
    expect(states).toContain('available');
    expect(states).toContain('downloading');
    expect(states).toContain('downloaded');
  });

  it('当 GitHub API 返回 403/429 限流时自动回退网页 Releases 检查，且阻断重定向至非 GitHub 域名', async () => {
    const updatesDir = mkDir('gravity-v021-updater-fallback-');
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return new Response('rate limit exceeded', { status: 403 });
      }
      if (url === 'https://github.com/Mikotou/G-Gravity/releases/latest') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/Mikotou/G-Gravity/releases/tag/v0.3.0' },
        });
      }
      if (url === 'https://github.com/Mikotou/G-Gravity/releases/expanded_assets/v0.3.0') {
        return new Response(
          `<a href="/Mikotou/G-Gravity/releases/download/v0.3.0/Gravity-0.3.0-mac-arm64.zip">Gravity-0.3.0-mac-arm64.zip</a>`,
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      }
      if (url.includes('/releases/download/v0.3.0/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://malicious.example.net/payload.zip' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const updater = new GitHubUpdater({
      currentVersion: '0.2.1',
      updatesDir,
      platform: 'darwin',
      arch: 'arm64',
      fetcher,
    });

    const checked = await updater.checkForUpdates();
    expect(checked.status).toBe('available');
    expect(checked.latestVersion).toBe('0.3.0');
    expect(checked.asset?.name).toBe('Gravity-0.3.0-mac-arm64.zip');

    const failed = await updater.downloadUpdate();
    expect(failed.status).toBe('error');
    expect(failed.errorMessage).toMatch(/受信任的 GitHub 域名白名单/);
    expect(updater.getState().status).toBe('error');
  });
});
