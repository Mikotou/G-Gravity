'use strict';

/**
 * G-Gravity v0.2.4 Wave 5B — Comprehensive Offline Real-User E2E Simulation & 10 Visual Screenshots.
 *
 * Launches the real packaged Windows Electron desktop app (`win-unpacked/Gravity.exe`) at 1440x900
 * against:
 *   1) A rich private local loopback Mock ACP server (streaming thoughts, streaming markdown,
 *      multi-hunk Edit diffs, Bash output, Todos, Swarm events, real `session/request_permission`
 *      flows, branch edits, 4-session parallelism, isolated profile model catalogs, Plugins/MCP/Quota).
 *   2) A local loopback Mock OpenAI-Compatible `/api/v1` Guardian Reviewer server (model discovery,
 *      connection test, controllable slow Stage 2 review with abort tracking, and structured
 *      `riskScore` + `intentAlignment` responses).
 *
 * Isolates `--user-data-dir`, `USERPROFILE`, `APPDATA`, and workspace to a disposable temp folder
 * under `os.tmpdir()` and cleans everything up in `finally`.
 */

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

const execFileAsync = promisify(execFile);

const EXPECTED_VERSION = 'v' + require('../package.json').version;
const SCREENSHOT_DIR = path.resolve('tests/screenshots/v024-qa');
const VIEWPORT = { width: 1440, height: 900 };
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const ALL_PRESET_THEMES = [
  'claude-code-dark',
  'claude-code-light',
  'ubuntu-aubergine',
  'macos-dark',
  'macos-light',
  'solarized-dark',
];

function resolveReleaseExecutable() {
  const candidates = [];
  if (process.env.GRAVITY_RELEASE_DIR) {
    candidates.push(path.join(path.resolve(process.env.GRAVITY_RELEASE_DIR), 'win-unpacked', 'Gravity.exe'));
  }
  candidates.push(
    path.resolve('release', EXPECTED_VERSION, 'win-unpacked', 'Gravity.exe'),
    path.resolve('release', 'win-unpacked', 'Gravity.exe')
  );
  for (const exe of candidates) {
    try {
      require('node:fs').accessSync(exe);
      return exe;
    } catch { /* try next */ }
  }
  throw new Error('Packaged win-unpacked/Gravity.exe not found. Checked: ' + candidates.join(', '));
}

function logStep(name, detail = '') {
  const ts = new Date().toISOString();
  console.log(`[OFFLINE-E2E ${ts}] ${name}${detail ? ' — ' + detail : ''}`);
}

const findings = [];
function recordFinding(severity, area, detail) {
  findings.push({ severity, area, detail });
  console.log(`[FINDING:${severity}] (${area}) ${detail}`);
}

const scenarioResults = [];
function recordScenario(name, status, detail = '') {
  scenarioResults.push({ name, status, detail });
  logStep(`${status}: ${name}`, detail);
}

/* ============================================================================
 * 1. Private C# agy.exe Fixture + Rich Local Mock ACP Server
 * ========================================================================== */

const AGY_FIXTURE_CS = `using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

class GravityV024QaFixture {
    static void Pump(Stream input, Stream output) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
            output.Write(buffer, 0, count);
            output.Flush();
        }
    }

    static int Main(string[] args) {
        if (args.Length >= 2 && args[0] == "--settings") {
            string result = Environment.GetEnvironmentVariable("GRAVITY_QUOTA_RESULT");
            if (String.IsNullOrEmpty(result)) return 2;
            string reset5h = DateTime.UtcNow.AddHours(3).ToString("o");
            string resetWk = DateTime.UtcNow.AddDays(4).ToString("o");
            string json = "{"
                + "\\"plan\\":\\"Google AI Pro\\","
                + "\\"quota\\":{"
                + "\\"gemini-weekly\\":{\\"remaining_fraction\\":0.84,\\"reset_time\\":\\"" + resetWk + "\\"},"
                + "\\"gemini-5h\\":{\\"remaining_fraction\\":0.92,\\"reset_time\\":\\"" + reset5h + "\\"},"
                + "\\"3p-weekly\\":{\\"remaining_fraction\\":0.68,\\"reset_time\\":\\"" + resetWk + "\\"},"
                + "\\"3p-5h\\":{\\"remaining_fraction\\":0.75,\\"reset_time\\":\\"" + reset5h + "\\"}"
                + "}}";
            File.WriteAllText(result, json, new UTF8Encoding(false));
            return 0;
        }
        if (args.Length >= 2 && args[0] == "plugin" && args[1] == "list") {
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine("[{\\"name\\":\\"chrome-devtools-mcp\\",\\"version\\":\\"1.4.2\\",\\"enabled\\":true,\\"description\\":\\"Inspect browser DOM, console logs, and network performance\\",\\"marketplace\\":\\"official\\"},{\\"name\\":\\"codex-guardian-pack\\",\\"version\\":\\"0.9.1\\",\\"enabled\\":true,\\"description\\":\\"Workspace safety guardrails and static policy presets\\",\\"marketplace\\":\\"official\\"}]");
            return 0;
        }
        if (args.Length >= 2 && args[0] == "mcp" && args[1] == "list") {
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine("{\\"mcpServers\\":[{\\"name\\":\\"context7-docs\\",\\"type\\":\\"stdio\\",\\"command\\":\\"npx\\",\\"args\\":[\\"-y\\",\\"@upstash/context7-mcp\\"],\\"enabled\\":true,\\"status\\":\\"ready\\"},{\\"name\\":\\"workspace-symbols\\",\\"type\\":\\"http\\",\\"url\\":\\"http://127.0.0.1:8765/mcp\\",\\"enabled\\":true,\\"status\\":\\"ready\\"}]}");
            return 0;
        }
        if (args.Length == 0 || args[0] != "acp") return 2;

        string profileId = "default";
        if (args.Length == 3 && args[1] == "--app-data-dir") {
            profileId = Path.GetFileName(Path.GetFullPath(args[2]));
        } else if (args.Length != 1) {
            return 2;
        }

        string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "mock-acp-v024.cjs");
        string nodeExe = Environment.GetEnvironmentVariable("GRAVITY_QA_NODE");
        var info = new ProcessStartInfo(nodeExe, "\\"" + script + "\\"") {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
        };
        info.EnvironmentVariables["GRAVITY_QA_PROFILE_ID"] = profileId;

        using (var child = Process.Start(info)) {
            var writer = new Thread(() => {
                try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                catch (IOException) {}
                finally { try { child.StandardInput.Close(); } catch (IOException) {} }
            });
            writer.IsBackground = true;
            writer.Start();
            Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
`;

const MOCK_ACP_SERVER_JS = `'use strict';
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');

const profileId = process.env.GRAVITY_QA_PROFILE_ID || 'default';
const traceFile = process.env.GRAVITY_QA_ACP_TRACE || '';
const sessions = new Map();
const loaded = new Set();
const active = new Map();
const permissions = new Map();
let sessionSeq = 0;
let permSeq = 0;
let toolSeq = 0;

function trace(entry) {
  if (!traceFile) return;
  try { appendFileSync(traceFile, JSON.stringify({ ts: new Date().toISOString(), profileId, ...entry }) + '\\n'); }
  catch {}
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function update(sessionId, payload) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } });
}

function modelCatalogForProfile() {
  if (profileId !== 'default') {
    const base = 'profile-' + profileId.slice(0, 14);
    return {
      currentModelId: base + '-pro',
      availableModels: [
        { modelId: base + '-pro', name: 'Profile Pro (' + profileId.slice(0, 12) + ')' },
        { modelId: base + '-flash', name: 'Profile Flash (' + profileId.slice(0, 12) + ')' },
      ],
    };
  }
  return {
    currentModelId: 'gemini-4-neon',
    availableModels: [
      { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { modelId: 'claude-opus-5.5', name: 'Claude Opus 5.5' },
    ],
  };
}

function buildConfigOptions(models) {
  return [
    {
      id: 'model',
      name: 'Model',
      currentValue: models.currentModelId,
      options: models.availableModels.map(m => ({ value: m.modelId, name: m.name })),
    },
    {
      id: 'mode',
      name: 'Mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'default' },
        { value: 'accept-edits', name: 'accept-edits' },
        { value: 'plan', name: 'plan' },
        { value: 'auto', name: 'auto' },
      ],
    },
    {
      id: 'thought_level',
      name: 'Reasoning Effort',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'XHigh' },
      ],
    },
  ];
}

function emitUsage(sessionId, inputTokens, cachedReadTokens, outputTokens, thoughtTokens) {
  const totalTokens = inputTokens + outputTokens + thoughtTokens;
  const usage = { inputTokens, cachedReadTokens, outputTokens, thoughtTokens, totalTokens };
  update(sessionId, { sessionUpdate: 'usage_update', usage });
  return usage;
}

function finishTurn(sessionId, promptId, text, usage) {
  if (text) {
    const mid = Math.ceil(text.length / 2);
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, mid) } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(mid) } });
  }
  const finalUsage = usage || emitUsage(sessionId, 4200, 2400, 380, 190);
  active.delete(sessionId);
  reply(promptId, { stopReason: 'end_turn', usage: finalUsage });
}

function cancel(sessionId) {
  const run = active.get(sessionId);
  if (!run) return;
  for (const t of run.timers) clearTimeout(t);
  if (run.permissionId) permissions.delete(run.permissionId);
  active.delete(sessionId);
  reply(run.id, { stopReason: 'cancelled' });
}

function scheduleStep(run, ms, fn) {
  const t = setTimeout(() => {
    if (active.get(run.sessionId) !== run) return;
    fn();
  }, ms);
  run.timers.push(t);
}

function emitRichCodingTurn(sessionId, run, text) {
  const tcEdit1 = 'tc-edit-' + (++toolSeq);
  const tcEdit2 = 'tc-edit-' + (++toolSeq);
  const tcBash1 = 'tc-bash-' + (++toolSeq);

  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: {
      type: 'text',
      text: 'Let us inspect the middleware implementation and plan a clean sliding-window rate limiter refactor. ',
    },
  });

  scheduleStep(run, 40, () => {
    update(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: {
        type: 'text',
        text: 'We should prune expired timestamps per client key, preserve deterministic O(1) amortized eviction, and verify unit tests pass cleanly.',
      },
    });
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Replace fixed-window counter with sliding-window ring buffer', status: 'in_progress', priority: 'high' },
        { content: 'Add burst boundary unit tests in rate-limiter.test.ts', status: 'pending', priority: 'medium' },
        { content: 'Run Vitest suite and inspect latency metrics', status: 'pending', priority: 'medium' },
      ],
    });
    const oldCode = [
      'export class RateLimiter {',
      '  private readonly windowMs: number;',
      '  private readonly maxRequests: number;',
      '  private counts = new Map<string, number>();',
      '',
      '  constructor(windowMs = 60_000, maxRequests = 60) {',
      '    this.windowMs = windowMs;',
      '    this.maxRequests = maxRequests;',
      '  }',
      '',
      '  allow(clientId: string): boolean {',
      '    const next = (this.counts.get(clientId) ?? 0) + 1;',
      '    this.counts.set(clientId, next);',
      '    return next <= this.maxRequests;',
      '  }',
      '}',
    ].join('\\n');
    const newCode = [
      'export class RateLimiter {',
      '  private readonly windowMs: number;',
      '  private readonly maxRequests: number;',
      '  private timestamps = new Map<string, number[]>();',
      '',
      '  constructor(windowMs = 60_000, maxRequests = 60) {',
      '    this.windowMs = windowMs;',
      '    this.maxRequests = maxRequests;',
      '  }',
      '',
      '  allow(clientId: string, now = Date.now()): boolean {',
      '    const cutoff = now - this.windowMs;',
      '    const recent = (this.timestamps.get(clientId) ?? []).filter(ts => ts > cutoff);',
      '    if (recent.length >= this.maxRequests) {',
      '      this.timestamps.set(clientId, recent);',
      '      return false;',
      '    }',
      '    recent.push(now);',
      '    this.timestamps.set(clientId, recent);',
      '    return true;',
      '  }',
      '}',
    ].join('\\n');
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: tcEdit1,
      title: 'edit_file',
      kind: 'edit',
      status: 'completed',
      rawInput: { file_path: 'src/middleware/rate-limiter.ts', old_string: oldCode, new_string: newCode },
      toolContent: [{ type: 'diff', path: 'src/middleware/rate-limiter.ts', oldText: oldCode, newText: newCode }],
    });
  });

  scheduleStep(run, 100, () => {
    const oldTest = [
      "import { describe, expect, it } from 'vitest';",
      "import { RateLimiter } from './rate-limiter';",
      '',
      "describe('RateLimiter', () => {",
      "  it('allows requests under cap', () => {",
      '    const limiter = new RateLimiter(60_000, 2);',
      "    expect(limiter.allow('u1')).toBe(true);",
      '  });',
      '});',
    ].join('\\n');
    const newTest = [
      "import { describe, expect, it } from 'vitest';",
      "import { RateLimiter } from './rate-limiter';",
      '',
      "describe('RateLimiter', () => {",
      "  it('enforces sliding window boundaries accurately', () => {",
      '    const limiter = new RateLimiter(60_000, 2);',
      "    expect(limiter.allow('u1', 1000)).toBe(true);",
      "    expect(limiter.allow('u1', 2000)).toBe(true);",
      "    expect(limiter.allow('u1', 3000)).toBe(false);",
      "    expect(limiter.allow('u1', 61_500)).toBe(true);",
      '  });',
      '});',
    ].join('\\n');
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: tcEdit2,
      title: 'edit_file',
      kind: 'edit',
      status: 'completed',
      rawInput: { file_path: 'src/middleware/rate-limiter.test.ts', old_string: oldTest, new_string: newTest },
      toolContent: [{ type: 'diff', path: 'src/middleware/rate-limiter.test.ts', oldText: oldTest, newText: newTest }],
    });
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: tcBash1,
      title: 'run_command',
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'npx vitest run src/middleware/rate-limiter.test.ts' },
      rawOutput: {
        exitCode: 0,
        stdout: ' ✓ src/middleware/rate-limiter.test.ts (3 tests) 14ms\\n Test Files  1 passed (1)\\n      Tests  3 passed (3)',
      },
    });
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Replace fixed-window counter with sliding-window ring buffer', status: 'completed', priority: 'high' },
        { content: 'Add burst boundary unit tests in rate-limiter.test.ts', status: 'completed', priority: 'medium' },
        { content: 'Run Vitest suite and inspect latency metrics', status: 'completed', priority: 'medium' },
      ],
    });
  });

  scheduleStep(run, 160, () => {
    const usage = emitUsage(sessionId, 18420, 11200, 1480, 960);
    const md = [
      '### 滑动窗口限流中间件重构完成',
      '',
      '已将 \`RateLimiter\` 从固定计数窗口升级为基于时间戳队列的滑动窗口实现，并补齐边界单测：',
      '',
      '- **过期裁剪**：每次 \`allow(clientId, now)\` 先剔除 \`ts <= now - windowMs\` 的历史记录，杜绝窗口交界双倍突刺。',
      '- **单测验证**：\`src/middleware/rate-limiter.test.ts\` 3/3 用例全部通过（14ms）。',
      '',
      '\`\`\`ts',
      'const cutoff = now - this.windowMs;',
      'const recent = (this.timestamps.get(clientId) ?? []).filter(ts => ts > cutoff);',
      '\`\`\`',
      '',
      '> 提示词摘要：' + text.slice(0, 80),
    ].join('\\n');
    finishTurn(sessionId, run.id, md, usage);
  });
}

function sendPermission(sessionId, run, command, toolTitle = 'run_command') {
  const permissionId = 'perm-' + (++permSeq);
  const tcId = 'tc-perm-' + permSeq;
  run.permissionId = permissionId;
  permissions.set(permissionId, { sessionId, promptId: run.id, command, tcId });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: tcId,
    title: toolTitle,
    kind: 'execute',
    status: 'pending',
    rawInput: { command },
  });
  send({
    jsonrpc: '2.0',
    id: permissionId,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: tcId, title: toolTitle, kind: 'execute', rawInput: { command } },
      options: [
        { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow-always', name: '始终允许', kind: 'allow_always' },
        { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
      ],
    },
  });
}

function receive(message) {
  if (!message.method && message.id !== undefined) {
    const pending = permissions.get(String(message.id));
    if (!pending) return;
    permissions.delete(String(message.id));
    trace({ type: 'permission_response', sessionId: pending.sessionId, command: pending.command, result: message.result, error: message.error });
    if (message.error) { cancel(pending.sessionId); return; }
    const optionId = message.result?.outcome?.optionId || message.result?.outcome?.outcome || 'unknown';
    const approved = optionId === 'allow-once' || optionId === 'allow-always';
    update(pending.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: pending.tcId,
      status: approved ? 'completed' : 'rejected',
      rawOutput: approved
        ? { exitCode: 0, stdout: 'Executed cleanly: ' + pending.command }
        : { exitCode: 1, stderr: 'Rejected by user decision (' + optionId + ')' },
    });
    const usage = emitUsage(pending.sessionId, 6400, 4100, 420, 180);
    finishTurn(
      pending.sessionId,
      pending.promptId,
      approved
        ? '命令 \`' + pending.command + '\` 已获批并执行完毕（结果：\`' + optionId + '\`）。'
        : '已按你的要求取消执行 \`' + pending.command + '\`（结果：\`' + optionId + '\`），将调整方案。',
      usage
    );
    return;
  }

  const { id, method, params = {} } = message;
  if (method === 'session/cancel') {
    cancel(params.sessionId);
    if (id !== undefined) reply(id, {});
    return;
  }
  if (id === undefined) return;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity Official ACP', version: '0.2.4' },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          auth: { logout: {} },
          _meta: { antigravity: { systemPrompt: { append: true } } },
        },
        authMethods: [],
      });
      return;

    case 'session/new': {
      const sessionId = 'qa-sess-' + (++sessionSeq);
      sessions.set(sessionId, { cwd: params.cwd, title: 'Session ' + sessionSeq });
      loaded.add(sessionId);
      const models = modelCatalogForProfile();
      reply(id, {
        sessionId,
        models,
        modes: {
          currentModeId: 'default',
          availableModes: ['default', 'accept-edits', 'plan', 'auto'].map(m => ({ id: m, name: m })),
        },
        configOptions: buildConfigOptions(models),
      });
      return;
    }

    case 'session/list':
      reply(id, { sessions: Array.from(sessions, ([sessionId, data]) => ({ sessionId, ...data })) });
      return;

    case 'session/resume':
    case 'session/load': {
      if (!sessions.has(params.sessionId)) {
        // After Electron relaunch, mock ACP is a fresh process; transparently accept persisted session IDs!
        sessions.set(params.sessionId, { cwd: params.cwd || process.cwd(), title: params.sessionId });
      }
      loaded.add(params.sessionId);
      const models = modelCatalogForProfile();
      reply(id, { sessionId: params.sessionId, models, configOptions: buildConfigOptions(models) });
      return;
    }

    case 'session/close':
      cancel(params.sessionId);
      loaded.delete(params.sessionId);
      reply(id, {});
      return;

    case 'session/set_mode':
    case 'session/set_model':
    case 'session/set_config_option':
    case 'auth/logout':
      reply(id, {});
      return;

    case 'session/prompt': {
      const sessionId = params.sessionId;
      if (!loaded.has(sessionId)) { fail(id, -32001, 'Session not loaded'); return; }
      if (active.has(sessionId)) { fail(id, -32002, 'Session busy'); return; }
      const text = (params.prompt || []).filter(b => b.type === 'text').map(b => b.text).join('');
      trace({ type: 'prompt', sessionId, text: text.slice(0, 200) });

      const run = { sessionId, id, timers: [] };
      active.set(sessionId, run);

      if (text.includes('staging preview deployment')) {
        update(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Preparing staging preview deployment command for Guardian security review.' },
        });
        scheduleStep(run, 30, () => sendPermission(sessionId, run, 'npm run deploy:preview -- --env staging'));
        return;
      }
      if (text.includes('Commit the refactored rate limiter')) {
        update(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Ready to commit the sliding-window rate limiter refactor to the local branch.' },
        });
        scheduleStep(run, 30, () => sendPermission(sessionId, run, 'git commit -m "feat(rate-limiter): add sliding window limiter"'));
        return;
      }
      if (text.includes('Commit updated unit test snapshots')) {
        scheduleStep(run, 25, () => sendPermission(sessionId, run, 'git commit -m "chore: update unit test snapshots"'));
        return;
      }
      if (text.includes('Stash benchmark scratch')) {
        scheduleStep(run, 25, () => sendPermission(sessionId, run, 'git stash push -m "wip: limiter benchmark"'));
        return;
      }
      if (text.includes('Run beta release verification')) {
        scheduleStep(run, 25, () => sendPermission(sessionId, run, 'npm run release:verify -- --channel beta'));
        return;
      }
      if (text.includes('Tag beta release')) {
        scheduleStep(run, 25, () => sendPermission(sessionId, run, 'git tag v0.2.4-beta.1'));
        return;
      }
      if (text.includes('Preview database schema migration')) {
        scheduleStep(run, 25, () => sendPermission(sessionId, run, 'npm run migrate:preview -- --dry-run'));
        return;
      }
      if (text.includes('Refactor the rate limiter middleware')) {
        emitRichCodingTurn(sessionId, run, text);
        return;
      }
      if (text.includes('Profile rate limiter throughput')) {
        update(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Coordinating parallel code review and performance profiling workers.' },
        });
        scheduleStep(run, 40, () => {
          update(sessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: 'swarm-' + (++toolSeq),
            title: 'swarm',
            kind: 'other',
            status: 'completed',
            rawInput: { action: 'spawn', name: 'perf-auditor', role: 'Performance Auditor', model: 'gemini-4-neon', brief: 'Profile rate limiter allocations' },
            rawOutput: { workers: [{ id: 'w-1', name: 'perf-auditor', role: 'Performance Auditor', status: 'working', brief: 'Profile rate limiter allocations', model: 'gemini-4-neon' }] },
          });
          update(sessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: 'board-' + (++toolSeq),
            title: 'post_message',
            kind: 'other',
            status: 'completed',
            rawInput: { sender: 'perf-auditor', content: '[done] Zero hot-path heap regressions observed.', channel: 'main', mentions: ['coordinator'] },
          });
          const usage = emitUsage(sessionId, 9800, 6200, 640, 310);
          finishTurn(sessionId, id, '并行协作任务已完成：性能审计成员已回报零热点回归。', usage);
        });
        return;
      }

      // Default realistic turn (multi-session & branch revisions)
      update(sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Analyzing the prompt context and preparing a concise, accurate response.' },
      });
      scheduleStep(run, 50, () => {
        const usage = emitUsage(sessionId, 7600, 4800, 520, 260);
        finishTurn(sessionId, id, '已处理请求：' + text.slice(0, 140) + '\\n\\n- 会话 ID：\`' + sessionId + '\`\\n- 状态：已完成校验', usage);
      });
      return;
    }

    default:
      fail(id, -32601, 'Unknown method: ' + method);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  try { receive(JSON.parse(line)); }
  catch { send({ jsonrpc: '2.0', id: 'parse-error', error: { code: -32700, message: 'Invalid JSON' } }); }
});
rl.on('close', () => {
  for (const run of active.values()) {
    for (const t of run.timers) clearTimeout(t);
  }
  process.exit(0);
});
`;

/* ============================================================================
 * 2. Local Loopback Mock OpenAI-Compatible `/api/v1` Guardian Reviewer Server
 * ========================================================================== */

async function startMockGuardianServer() {
  const calls = [];
  const state = {
    slowDelayMs: 6000,
    abortedSlowCalls: 0,
    inFlightSlow: 0,
  };

  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/v1/v1')) {
      calls.push({ url: req.url, method: req.method, error: 'DUPLICATE_V1_PATH' });
      res.writeHead(400).end(JSON.stringify({ error: { message: 'Duplicate /v1/v1 path detected' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/models') {
      calls.push({ url: req.url, method: 'GET', auth: Boolean(req.headers.authorization) });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-6.2-astra', object: 'model' },
          { id: 'gpt-5-mini', object: 'model' },
          { id: 'qwen3-guardian-14b', object: 'model' },
        ],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const userMsg = (body.messages || []).find(m => m.role === 'user')?.content || '{}';
      let payload = {};
      try { payload = JSON.parse(userMsg); } catch {}
      const command = String(payload.command || '');
      const isProbe = payload.intentSummary === 'Connection test using a fixed read-only example';
      const entry = {
        url: req.url,
        method: 'POST',
        model: body.model,
        command,
        isProbe,
        auth: Boolean(req.headers.authorization),
        hasConversationContext: Boolean(payload.conversationContext),
      };
      calls.push(entry);

      if (isProbe) {
        res.end(JSON.stringify({
          id: 'chatcmpl-probe',
          choices: [{
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                recommended: 'approve',
                riskLevel: 'safe',
                riskScore: 8,
                intentAlignment: 'aligned',
                reason: 'Read-only git status probe verified via OpenAI-compatible /api/v1.',
              }),
            },
          }],
          usage: { prompt_tokens: 185, completion_tokens: 42, total_tokens: 227 },
        }));
        return;
      }

      if (command.includes('deploy:preview')) {
        state.inFlightSlow++;
        let clientClosed = false;
        const onAbort = () => {
          if (!res.writableEnded && !clientClosed) {
            clientClosed = true;
            state.abortedSlowCalls++;
          }
        };
        res.on('close', onAbort);
        req.socket?.on('close', onAbort);
        const deadline = Date.now() + state.slowDelayMs;
        while (!clientClosed && Date.now() < deadline) {
          await delay(50);
        }
        state.inFlightSlow--;
        if (clientClosed || res.writableEnded) return;
        res.end(JSON.stringify({
          id: 'chatcmpl-slow',
          choices: [{
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                recommended: 'ask',
                riskLevel: 'medium',
                riskScore: 58,
                intentAlignment: 'uncertain',
                reason: 'Staging deployment command requires human verification.',
              }),
            },
          }],
          usage: { prompt_tokens: 390, completion_tokens: 54, total_tokens: 444 },
        }));
        return;
      }

      let decision;
      if (command.includes('git commit')) {
        decision = {
          recommended: 'ask',
          riskLevel: 'medium',
          riskScore: 62,
          intentAlignment: 'uncertain',
          reason: '即将创建新的本地 Git 提交，请核对暂存改动范围与提交说明后再放行。',
        };
      } else if (command.includes('migrate:preview')) {
        decision = {
          recommended: 'ask',
          riskLevel: 'medium',
          riskScore: 62,
          intentAlignment: 'uncertain',
          reason: '数据库迁移预演命令会连接预发配置，请人工确认目标环境参数。',
        };
      } else if (command.includes('git stash')) {
        decision = {
          recommended: 'ask',
          riskLevel: 'low',
          riskScore: 44,
          intentAlignment: 'aligned',
          reason: '将当前工作区改动暂存至 stash 栈，可逆但会清空未提交工作树。',
        };
      } else if (command.includes('release:verify')) {
        decision = {
          recommended: 'ask',
          riskLevel: 'medium',
          riskScore: 54,
          intentAlignment: 'aligned',
          reason: '发布校验脚本符合当前任务意图，请确认是否批准并托付本会话后续审查。',
        };
      } else if (command.includes('git tag')) {
        decision = {
          recommended: 'ask',
          riskLevel: 'medium',
          riskScore: 66,
          intentAlignment: 'uncertain',
          reason: '将创建新的版本标签 v0.2.4-beta.1，建议先确认完整基准测试结果。',
        };
      } else {
        decision = {
          recommended: 'approve',
          riskLevel: 'low',
          riskScore: 18,
          intentAlignment: 'aligned',
          reason: '与当前开发意图一致的低风险工作区操作。',
        };
      }

      await delay(120);
      if (res.writableEnded) return;
      res.end(JSON.stringify({
        id: 'chatcmpl-' + calls.length,
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify(decision) },
        }],
        usage: {
          prompt_tokens: 412,
          completion_tokens: 68,
          total_tokens: 480,
          prompt_tokens_details: { cached_tokens: 120 },
        },
      }));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: { message: 'Not found: ' + req.url } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  return {
    endpoint: `http://127.0.0.1:${port}/api/v1`,
    calls,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/* ============================================================================
 * 3. Prepare Isolated Profile, Workspace, & Compiled Private agy.exe
 * ========================================================================== */

async function prepareOfflineEnvironment() {
  const root = await mkdtemp(path.join(tmpdir(), 'gravity-v024-e2e-'));
  const profile = path.join(root, 'user-data');
  const workspace = path.join(root, 'demo-workspace');
  const cliDir = path.join(root, 'synthetic-cli');
  const home = path.join(root, 'synthetic-home');
  const roaming = path.join(home, 'AppData', 'Roaming');
  const local = path.join(home, 'AppData', 'Local');
  const temp = path.join(local, 'Temp');

  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(path.join(workspace, 'src', 'middleware'), { recursive: true }),
    mkdir(path.join(workspace, '.agents', 'skills', 'release-qa-checklist'), { recursive: true }),
    mkdir(path.join(home, '.gemini', 'config', 'skills', 'guardian-security-audit'), { recursive: true }),
    mkdir(cliDir, { recursive: true }),
    mkdir(roaming, { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'rate-limiter-demo', version: '1.0.0', private: true }, null, 2)),
    writeFile(path.join(workspace, 'README.md'), '# Rate Limiter Demo\n\nSliding-window rate limiter service.\n'),
    writeFile(path.join(workspace, 'src', 'middleware', 'rate-limiter.ts'), 'export class RateLimiter {}\n'),
    writeFile(
      path.join(workspace, '.agents', 'skills', 'release-qa-checklist', 'SKILL.md'),
      '---\nname: release-qa-checklist\ndescription: Pre-release automated verification checklist for desktop builds\n---\n# Release QA Checklist\n'
    ),
    writeFile(
      path.join(home, '.gemini', 'config', 'skills', 'guardian-security-audit', 'SKILL.md'),
      '---\nname: guardian-security-audit\ndescription: Review shell commands and workspace boundaries before approval\n---\n# Guardian Security Audit\n'
    ),
  ]);

  const fixtureCsPath = path.join(cliDir, 'fixture.cs');
  const mockAcpPath = path.join(cliDir, 'mock-acp-v024.cjs');
  const agyExePath = path.join(cliDir, 'agy.exe');
  const tracePath = path.join(cliDir, 'acp-trace.jsonl');

  await Promise.all([
    writeFile(fixtureCsPath, AGY_FIXTURE_CS, 'utf8'),
    writeFile(mockAcpPath, MOCK_ACP_SERVER_JS, 'utf8'),
  ]);

  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execFileAsync(
    psExe,
    [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:FIXTURE_SOURCE)) -OutputAssembly $env:FIXTURE_EXE -OutputType ConsoleApplication',
    ],
    {
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, TEMP: temp, TMP: temp, FIXTURE_EXE: agyExePath, FIXTURE_SOURCE: fixtureCsPath },
    }
  );

  // Seed clean initial preferences & exact 1440x900 window bounds
  await writeFile(
    path.join(profile, 'preferences.json'),
    JSON.stringify({
      locale: 'zh-CN',
      theme: 'claude-code-dark',
      appIcon: 'gravity-claude-dark',
      defaultThoughtTrack: 'zh',
      defaultWorkspaceCwd: workspace,
      autoCheckUpdates: false,
      uiScale: 1,
    }, null, 2),
    'utf8'
  );
  await writeFile(
    path.join(profile, 'window-state.json'),
    JSON.stringify({ bounds: { x: 24, y: 24, width: VIEWPORT.width, height: VIEWPORT.height }, maximized: false }),
    'utf8'
  );

  return {
    root,
    profile,
    workspace,
    agyExePath,
    tracePath,
    env: {
      AGY_BINARY_PATH: agyExePath,
      AGY_RENDERER_URL: '',
      GRAVITY_QA_NODE: process.execPath,
      GRAVITY_QA_ACP_TRACE: tracePath,
      USERPROFILE: home,
      APPDATA: roaming,
      LOCALAPPDATA: local,
      TEMP: temp,
      TMP: temp,
    },
  };
}

/* ============================================================================
 * 4. Electron Launch, Exact 1440x900 Sizing, & Helper Utilities
 * ========================================================================== */

async function launchPackagedApp(executable, profile, envOverrides, cwd) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await rm(portFile, { force: true });

  const childEnv = { ...process.env, ...envOverrides };
  // CRITICAL: T3 Code sets ELECTRON_RUN_AS_NODE=1 in child shells; always remove before launching Electron!
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    executable,
    ['--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    { cwd, env: childEnv, windowsHide: false, stdio: 'ignore' }
  );

  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });

  let browser;
  const deadline = Date.now() + 45000;
  while (!browser && Date.now() < deadline) {
    const raw = await readFile(portFile, 'utf8').catch(() => '');
    const lines = raw.trim().split(/\r?\n/);
    if (lines[0] && lines[1]) {
      browser = await chromium
        .connectOverCDP(`ws://127.0.0.1:${lines[0]}${lines[1]}`, { timeout: 2500 })
        .catch(() => undefined);
    }
    if (!browser) await delay(150);
  }
  assert.ok(browser, 'Packaged Gravity.exe did not expose DevToolsActivePort within 45s');

  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15000 });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.locator('[data-testid="agy-app-root"], [data-testid="app-bootstrap-error"]').first().waitFor({ timeout: 40000 });
  const bootErr = page.getByTestId('app-bootstrap-error');
  if (await bootErr.count()) {
    throw new Error('Bootstrap error: ' + await bootErr.innerText());
  }

  // Enforce exact 1440x900 CSS viewport for consistent, crisp screenshots
  await page.setViewportSize(VIEWPORT);
  await delay(250);

  async function close() {
    if (browser) {
      const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
      await cdp?.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
    }
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(new Error('Gravity.exe did not exit cleanly within 12s'));
          }, 12000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { browser, page, pageErrors, close };
}

async function typeField(locator, text) {
  await locator.click();
  await locator.press('Control+a');
  await locator.press('Backspace');
  await locator.fill(text);
  assert.equal(await locator.inputValue(), text);
}

async function settleAnimations(page, extraMs = 220) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  if (extraMs > 0) await delay(extraMs);
}

async function dismissToastIfVisible(page) {
  const closeBtn = page.locator('[data-testid="app-toast"] button').first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ timeout: 500 }).catch(() => {});
  }
}

async function snap(page, filename, { dismissToast = true } = {}) {
  if (dismissToast) await dismissToastIfVisible(page);
  await settleAnimations(page, 260);
  const fullPath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: fullPath, type: 'png' });
  const info = await stat(fullPath);
  assert.ok(info.size > 10_000, `Screenshot ${filename} unexpectedly small (${info.size} bytes)`);
  logStep('SCREENSHOT', `${filename} (${(info.size / 1024).toFixed(1)} KB)`);
  return fullPath;
}

async function switchThemeViaUI(page, themeId, keepSettingsOpen = false) {
  const overlay = page.getByTestId('settings-overlay');
  if (!await overlay.isVisible().catch(() => false)) {
    await page.keyboard.press('Control+,');
    await overlay.waitFor();
  }
  await page.getByTestId('settings-tab-themes').click();
  await page.getByTestId(`theme-card-${themeId}`).click();
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, themeId);
  if (!keepSettingsOpen) {
    await page.keyboard.press('Escape');
    await overlay.waitFor({ state: 'detached' });
  }
}

async function getAssistantCount(page, sessionId) {
  return page.evaluate(
    async sid => (await window.gravityDesktop.getSessionMessagePage(sid)).messages.filter(m => m.role === 'assistant').length,
    sessionId
  );
}

async function waitForTurnSettled(page, sessionId, minAssistantCount = 1, timeoutMs = 20000) {
  await page.waitForFunction(
    async ({ sid, minCount }) => {
      const [sessions, pageRes] = await Promise.all([
        window.gravityDesktop.listSessions(),
        window.gravityDesktop.getSessionMessagePage(sid),
      ]);
      const msgs = pageRes.messages;
      const sess = sessions.find(s => s.sessionId === sid);
      const assistants = msgs.filter(m => m.role === 'assistant');
      const last = assistants.at(-1);
      return sess?.status === 'idle' && assistants.length >= minCount && Boolean(last?.completedAt) && !last?.isStreaming;
    },
    { sid: sessionId, minCount: minAssistantCount },
    { timeout: timeoutMs }
  );
}

async function sendPromptViaComposer(page, sessionId, text) {
  const input = page.getByTestId(`composer-input-${sessionId}`);
  await input.waitFor();
  await typeField(input, text);
  await input.press('Enter');
}

async function createSessionViaModal(page, cwd, title) {
  await page.getByTestId('sidebar-new-session-btn').click();
  await page.getByTestId('new-session-modal').waitFor();
  await typeField(page.getByTestId('new-session-cwd-input'), cwd);
  await typeField(page.getByTestId('new-session-title-input'), title);
  await page.getByTestId('confirm-create-session-btn').click();
  await page.getByTestId('new-session-modal').waitFor({ state: 'detached', timeout: 15000 });
  const activeTab = page.locator('[data-testid^="tab-item-"].is-active').first();
  await activeTab.waitFor();
  const sid = (await activeTab.getAttribute('data-testid')).slice('tab-item-'.length);
  await page.getByTestId(`composer-input-${sid}`).waitFor();
  return sid;
}

async function removeTreeWithRetry(targetDir) {
  // Clean app-owned subdirectories first so Windows IME (e.g. SogouPY) locks in synthetic-home never block profile cleanup.
  for (const sub of ['user-data', 'demo-workspace', 'synthetic-cli']) {
    await rm(path.join(targetDir, sub), { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }).catch(() => {});
  }
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await rm(targetDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() >= deadline || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err.code)) {
        console.warn('Temp cleanup warning (Windows IME lock in synthetic-home):', err.code || err.message);
        return;
      }
      await delay(500);
    }
  }
}

/* ============================================================================
 * 5. Main End-to-End Orchestration
 * ========================================================================== */

(async () => {
  assert.equal(process.platform, 'win32', 'This desktop QA harness targets Windows packaged Gravity.exe');
  const executable = resolveReleaseExecutable();
  logStep('INIT', `Using packaged binary: ${executable}`);

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const envFixture = await prepareOfflineEnvironment();
  const guardian = await startMockGuardianServer();
  logStep('INIT', `Mock OpenAI-Compatible Guardian listening at ${guardian.endpoint}`);

  let appInstance;
  let relaunchedApp;
  try {
    appInstance = await launchPackagedApp(executable, envFixture.profile, envFixture.env, envFixture.workspace);
    const { page, pageErrors } = appInstance;

    // Verify real ACP connection to our local loopback fixture
    const conn = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
    assert.equal(conn.connected, true, 'Mock ACP connection failed: ' + conn.lastError);
    assert.equal(path.resolve(conn.agyBinaryPath), path.resolve(envFixture.agyExePath));
    assert.equal(conn.agyVersion, '0.2.4');

    /* ------------------------------------------------------------------------
     * SCENARIO 1: Welcome Canvas, Theme Switch (Dark/Light), & Quick-Start
     * ---------------------------------------------------------------------- */
    const welcome = page.getByTestId('empty-pane-0');
    await welcome.getByRole('heading').waitFor();
    assert.equal(await page.locator('[data-testid^="composer-input-"]').count(), 0);
    await page.getByTestId('welcome-quick-composer-input').waitFor();

    // Screenshot 01: Welcome Dark
    await snap(page, '01-welcome-dark.png');

    // Switch to Claude Code Light, close settings, capture Screenshot 02, switch back to Dark
    await switchThemeViaUI(page, 'claude-code-light', false);
    await welcome.getByRole('heading').waitFor();
    await snap(page, '02-welcome-light.png');
    await switchThemeViaUI(page, 'claude-code-dark', false);
    await welcome.getByRole('heading').waitFor();

    // Welcome quick-composer direct prompt -> creates session & streams reply + ThinkingBlock + ToolCallCard (Edit diff + Bash)
    const quickInput = page.getByTestId('welcome-quick-composer-input');
    const firstPrompt = 'Refactor the rate limiter middleware to support sliding windows and verify with unit tests.';
    await typeField(quickInput, firstPrompt);
    await quickInput.press('Enter');

    const firstComposer = page.locator('[data-testid^="composer-input-"]').first();
    await firstComposer.waitFor({ timeout: 20000 });
    const sess1Id = (await firstComposer.getAttribute('data-testid')).slice('composer-input-'.length);
    await waitForTurnSettled(page, sess1Id, 1, 20000);

    // Verify ThinkingBlock, ToolCallCard (Edit with unified diff + Bash command output), and markdown body
    const thoughtBlocks = page.locator('[data-testid^="thinking-block-"]');
    await thoughtBlocks.first().waitFor();
    const thoughtId = (await thoughtBlocks.first().getAttribute('data-testid')).slice('thinking-block-'.length);

    // Expand tool group to inspect Edit diff + Bash output, then collapse cleanly so conversation stays compact for screenshots
    const toolGroup = page.locator('[data-testid^="tool-group-"]').first();
    await toolGroup.waitFor();
    await toolGroup.locator('summary').click();
    assert.ok(await toolGroup.locator('.cc-tool').count() >= 3, 'Expected Edit + Edit + Bash tool cards');
    const editCard = toolGroup.locator('.cc-tool').filter({ hasText: 'rate-limiter.ts' }).first();
    await editCard.locator('.cc-tool-line').click();
    await editCard.locator('.diff-block, [data-testid^="unified-diff-"], .diff-line').first().waitFor({ timeout: 5000 }).catch(() => {});
    const bashCard = toolGroup.locator('.cc-tool').filter({ hasText: 'vitest' }).first();
    await bashCard.locator('.cc-tool-line').click();
    await bashCard.locator('.cc-tool-output').filter({ hasText: '3 passed' }).waitFor();
    await toolGroup.locator('summary').click();

    // Verify Right Inspector Diff tab shows our real unified diffs
    await page.getByTestId('inspector-tab-diff').click();
    await page.getByTestId('inspector-change-summary').waitFor();
    recordScenario('1. Welcome Canvas & Direct Quick-Start', 'PASS', `session=${sess1Id}, thought=${thoughtId}, diffs & Bash verified`);

    /* ------------------------------------------------------------------------
     * SCENARIO 2: Full Codex-Style "Approve for me" Guardian User Journey
     * ---------------------------------------------------------------------- */
    // 2A. Open Settings -> Approvals -> Reviewer, configure loopback OpenAI-Compatible /api/v1, discover, test & enable hybrid
    await page.keyboard.press('Control+,');
    await page.getByTestId('settings-tab-approvals').click();
    await page.getByTestId('drawer-tab-reviewer').click();

    const drawer = page.getByTestId('approval-drawer');
    const providerSelect = drawer.locator('select').first();
    await providerSelect.selectOption('openai-compatible');

    const endpointInput = drawer.locator('input[type="text"]').first();
    await typeField(endpointInput, guardian.endpoint);
    await typeField(page.getByTestId('reviewer-apikey-input'), 'sk-local-guardian-qa-test-0001');

    // Click discover models & verify `/api/v1/models` (no /v1/v1)
    await page.getByTestId('discover-reviewer-models-btn').click();
    const modelSelect = page.getByTestId('reviewer-model-select');
    const backToListBtn = drawer.getByRole('button', { name: /^(?:列表|List)$/ });
    await modelSelect.or(backToListBtn).first().waitFor({ timeout: 10000 });
    if (await backToListBtn.isVisible().catch(() => false)) {
      recordFinding(
        'MEDIUM',
        'settings/approvals-reviewer',
        'After model discovery on an OpenAI-Compatible endpoint whose catalog omits the preset default model ("gpt-4o-mini"), ApprovalsPanel flips customModelMode=true (WorkspacePanels.tsx:431) instead of displaying the discovered model dropdown, requiring an extra click on the "列表 / List" button.'
      );
      await backToListBtn.click();
      await modelSelect.waitFor({ timeout: 5000 });
    }
    await modelSelect.selectOption('gpt-6.2-astra');

    // Set timeout generous enough for slow Stage 2 test
    await typeField(page.getByTestId('reviewer-timeout-input'), '15000');

    // Click enable toggle -> prompts confirmation -> click "测试并启用"
    await page.getByTestId('reviewer-enable-action').click();
    await page.getByTestId('reviewer-test-and-enable').waitFor();
    await page.getByTestId('reviewer-test-and-enable').click();
    await page.locator('[data-testid="reviewer-enable-action"]:checked').waitFor({ timeout: 10000 });
    const enabledCfg = await page.evaluate(async () => (await window.gravityDesktop.getBootstrap()).approvalConfig);
    assert.equal(enabledCfg.mode, 'hybrid', 'Expected approval mode to switch to hybrid after review test & enable');
    assert.equal(enabledCfg.externalReviewer.provider, 'openai-compatible');
    assert.equal(enabledCfg.externalReviewer.model, 'gpt-6.2-astra');
    assert.equal(guardian.calls.some(c => c.error === 'DUPLICATE_V1_PATH'), false, 'Detected duplicate /v1/v1 path!');

    // Screenshot 08: Settings -> Approvals -> Reviewer configured & enabled
    await snap(page, '08-settings-approvals-dark.png');
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-overlay').waitFor({ state: 'detached' });

    // 2B. Trigger slow Stage 2 review -> live Guardian Reviewing card + Diff Inspector visible -> Screenshot 03 -> Cancel/Takeover!
    await page.getByTestId('inspector-tab-diff').click();
    await sendPromptViaComposer(page, sess1Id, 'Run staging preview deployment check.');

    const reviewingCard = page.locator('[data-testid^="approval-reviewing-card-"]').first();
    await reviewingCard.waitFor({ timeout: 10000 });
    const slowReqId = (await reviewingCard.getAttribute('data-testid')).slice('approval-reviewing-card-'.length);
    assert.match(await reviewingCard.innerText(), /gpt-6\.2-astra/);
    assert.match(await reviewingCard.innerText(), /deploy:preview/);
    await page.getByTestId(`approval-reviewing-elapsed-${slowReqId}`).waitFor();
    await page.getByTestId(`btn-cancel-stage2-${slowReqId}`).waitFor();

    // Check if reviewingCard auto-scrolled into viewport; record UX finding if SessionPane did not auto-scroll on reviewingApprovals!
    const inViewportBeforeScroll = await reviewingCard.evaluate(el => {
      const r = el.getBoundingClientRect();
      const scroller = el.closest('.stream');
      const sr = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      return r.top >= sr.top && r.bottom <= sr.bottom + 2;
    });
    if (!inViewportBeforeScroll) {
      recordFinding(
        'MEDIUM',
        'chat/auto-scroll',
        'SessionPane auto-scroll effect (SessionPane.tsx:748) depends on [messages, pendingApprovals] but omits reviewingApprovals, so a newly rendered live Stage 2 "Guardian AI Reviewing..." card can appear below the fold until the user manually scrolls down.'
      );
      await reviewingCard.scrollIntoViewIfNeeded();
    }

    // Let timer tick visibly for clean screenshot
    await delay(450);
    // Screenshot 03: Chat with live Stage 2 "Guardian AI Reviewing..." card + Right Inspector Diff tab visible
    await snap(page, '03-chat-guardian-reviewing-dark.png');

    // Click "立即转为人工审批" / Take over manually -> Stage 2 aborts & immediately escalates to Stage 3 WITHOUT cancelling turn!
    await page.getByTestId(`btn-cancel-stage2-${slowReqId}`).click();
    await reviewingCard.waitFor({ state: 'detached', timeout: 5000 });
    const escalatedCard = page.getByTestId(`inline-request-view-${slowReqId}`);
    await escalatedCard.waitFor({ timeout: 5000 });
    // Verify turn was NOT cancelled (still waiting_approval, then allow_once completes cleanly)
    const slowSessionState = await page.evaluate(async sid => (await window.gravityDesktop.listSessions()).find(s => s.sessionId === sid), sess1Id);
    assert.notEqual(slowSessionState.status, 'idle', 'Turn should remain active while awaiting escalated Stage 3 approval');
    await page.getByTestId(`btn-allow-once-${slowReqId}`).click();
    await escalatedCard.waitFor({ state: 'detached', timeout: 5000 });
    await waitForTurnSettled(page, sess1Id, 2, 15000);
    assert.ok(guardian.state.abortedSlowCalls >= 1, 'Expected slow Guardian HTTP call to be aborted upon Stage 2 takeover');

    // 2C. Trigger Stage 2 `ask` with riskScore=62, intentAlignment='uncertain' -> Screenshot 04 -> Option 2 (prefix 1)
    await sendPromptViaComposer(page, sess1Id, 'Commit the refactored rate limiter changes.');
    const askCard = page.locator('[data-testid^="inline-request-view-"]').first();
    await askCard.waitFor({ timeout: 10000 });
    const askReqId = (await askCard.getAttribute('data-testid')).slice('inline-request-view-'.length);

    const scoreBadge = page.getByTestId(`risk-score-${askReqId}`);
    await scoreBadge.waitFor();
    assert.ok((await scoreBadge.innerText()).includes('62'), 'Expected riskScore 62 badge');
    const alignBadge = page.getByTestId(`intent-alignment-${askReqId}`);
    await alignBadge.waitFor();
    assert.ok((await alignBadge.innerText()).trim().length > 0, 'Expected intentAlignment badge text');
    await page.getByTestId(`request-ai-reason-${askReqId}`).waitFor();
    assert.match(await page.getByTestId(`btn-allow-once-${askReqId}`).innerText(), /^1\.\s*Yes/);
    assert.match(await page.getByTestId(`btn-allow-prefix-${askReqId}`).innerText(), /^2\.\s*Yes.*git commit/);
    assert.match(await page.getByTestId(`btn-approve-for-me-${askReqId}`).innerText(), /^3\.\s*Approve for me/);
    assert.match(await page.getByTestId(`btn-reject-feedback-${askReqId}`).innerText(), /^4\.\s*No/);

    await askCard.scrollIntoViewIfNeeded();
    // Screenshot 04: Stage 3 Approval Card Dark (riskScore 62 + intentAlignment + options 1-4)
    await snap(page, '04-chat-stage3-approval-dark.png');

    // Click Option 2 -> remember prefix 1 ("git commit")
    await page.getByTestId(`btn-allow-prefix-${askReqId}`).click();
    await askCard.waitFor({ state: 'detached', timeout: 5000 });
    await waitForTurnSettled(page, sess1Id, 3, 15000);

    // Trigger another `git commit` command to verify remembered prefix 1 auto-approves & increments hitCount!
    const callsBeforePrefixHit = guardian.calls.length;
    await sendPromptViaComposer(page, sess1Id, 'Commit updated unit test snapshots.');
    await waitForTurnSettled(page, sess1Id, 4, 15000);
    assert.equal(guardian.calls.length, callsBeforePrefixHit, 'Remembered prefix 1 should auto-approve without calling Guardian');

    // Trigger prefix 2 (`git stash`) -> click Option 2
    await sendPromptViaComposer(page, sess1Id, 'Stash benchmark scratch changes.');
    const stashCard = page.locator('[data-testid^="inline-request-view-"]').first();
    await stashCard.waitFor({ timeout: 10000 });
    const stashReqId = (await stashCard.getAttribute('data-testid')).slice('inline-request-view-'.length);
    await page.getByTestId(`btn-allow-prefix-${stashReqId}`).click();
    await stashCard.waitFor({ state: 'detached', timeout: 5000 });
    await waitForTurnSettled(page, sess1Id, 5, 15000);

    // Trigger Stage 2 `ask` (`release:verify`) -> click Option 3 (`3. Approve for me`) -> approves + delegates WITHOUT looping!
    await sendPromptViaComposer(page, sess1Id, 'Run beta release verification.');
    const delCard = page.locator('[data-testid^="inline-request-view-"]').first();
    await delCard.waitFor({ timeout: 10000 });
    const delReqId = (await delCard.getAttribute('data-testid')).slice('inline-request-view-'.length);
    const callsBeforeOption3 = guardian.calls.length;
    await page.getByTestId(`btn-approve-for-me-${delReqId}`).click();
    await delCard.waitFor({ state: 'detached', timeout: 5000 });
    await waitForTurnSettled(page, sess1Id, 6, 15000);
    assert.equal(guardian.calls.length, callsBeforeOption3, 'Option 3 on an already Stage-2-ask card must NOT re-invoke Guardian or loop');

    // Trigger `git tag` -> click Option 4 (`4. No with feedback`), type custom instructions, confirm reject!
    const beforeRejectCount = await getAssistantCount(page, sess1Id);
    await sendPromptViaComposer(page, sess1Id, 'Tag beta release v0.2.4-beta.1.');
    const rejCard = page.locator('[data-testid^="inline-request-view-"]').first();
    await rejCard.waitFor({ timeout: 10000 });
    const rejReqId = (await rejCard.getAttribute('data-testid')).slice('inline-request-view-'.length);
    await page.getByTestId(`btn-reject-feedback-${rejReqId}`).click();
    await page.getByTestId(`reject-feedback-box-${rejReqId}`).waitFor();
    await typeField(page.getByTestId(`reject-feedback-input-${rejReqId}`), 'Please run the full benchmark suite before creating a release tag.');
    await page.getByTestId(`confirm-reject-btn-${rejReqId}`).click();
    await rejCard.waitFor({ state: 'detached', timeout: 5000 });
    // Reject-with-feedback finishes the rejected turn AND automatically sends a follow-up turn with the user's feedback!
    await waitForTurnSettled(page, sess1Id, beforeRejectCount + 2, 15000);

    // 2D. Open Composer approval/trust popover -> verify active delegation + 2 remembered prefixes + hit count -> Screenshot 06 -> revoke prefix 0 & revoke delegation!
    await dismissToastIfVisible(page);
    await page.getByTestId(`approval-mode-pill-${sess1Id}`).click();
    const approvalPopover = page.getByTestId(`approval-menu-${sess1Id}`);
    await approvalPopover.waitFor();
    await page.getByTestId('btn-revoke-delegation').waitFor();
    await page.getByTestId('btn-revoke-prefix-0').waitFor();
    await page.getByTestId('btn-revoke-prefix-1').waitFor();
    const popoverText = await approvalPopover.innerText();
    assert.ok(popoverText.includes('git commit') && popoverText.includes('git stash'), 'Popover should list both remembered prefixes');

    // Screenshot 06: Composer approval/trust popover with delegation + prefixes + hit counts + revoke buttons
    await snap(page, '06-composer-grants-popover-dark.png', { dismissToast: false });

    // Verify grants snapshot before & after individual revokes
    const grantsBefore = await page.evaluate(sid => window.gravityDesktop.listSessionApprovalGrants(sid), sess1Id);
    assert.equal(grantsBefore.delegatedToGuardian, true);
    assert.equal(grantsBefore.prefixes.length, 2);
    const removedPrefix = grantsBefore.prefixes[0].prefix;
    const keptPrefix = grantsBefore.prefixes[1].prefix;

    await page.getByTestId('btn-revoke-prefix-0').click();
    await page.waitForFunction(
      async ({ sid, gone }) => !(await window.gravityDesktop.listSessionApprovalGrants(sid)).prefixes.some(p => p.prefix === gone),
      { sid: sess1Id, gone: removedPrefix }
    );
    const grantsAfterPrefix = await page.evaluate(sid => window.gravityDesktop.listSessionApprovalGrants(sid), sess1Id);
    assert.equal(grantsAfterPrefix.prefixes.length, 1);
    assert.equal(grantsAfterPrefix.prefixes[0].prefix, keptPrefix);
    assert.equal(grantsAfterPrefix.delegatedToGuardian, true);

    await page.getByTestId('btn-revoke-delegation').click();
    await page.getByTestId('btn-revoke-delegation').waitFor({ state: 'detached' });
    const grantsAfterDel = await page.evaluate(sid => window.gravityDesktop.listSessionApprovalGrants(sid), sess1Id);
    assert.equal(grantsAfterDel.delegatedToGuardian, false);
    assert.equal(grantsAfterDel.prefixes.length, 1);

    await page.keyboard.press('Escape');
    await approvalPopover.waitFor({ state: 'detached' });

    // 2E. Open a Stage 3 card, switch to Claude Code Light, capture Screenshot 05, settle & switch back to Dark
    const beforeLightCount = await getAssistantCount(page, sess1Id);
    await sendPromptViaComposer(page, sess1Id, 'Preview database schema migration.');
    const lightCard = page.locator('[data-testid^="inline-request-view-"]').first();
    await lightCard.waitFor({ timeout: 10000 });
    const lightReqId = (await lightCard.getAttribute('data-testid')).slice('inline-request-view-'.length);

    await switchThemeViaUI(page, 'claude-code-light', false);
    await lightCard.waitFor();
    await lightCard.scrollIntoViewIfNeeded();
    await snap(page, '05-chat-stage3-approval-light.png');

    await page.getByTestId(`btn-allow-once-${lightReqId}`).click();
    await lightCard.waitFor({ state: 'detached' });
    await waitForTurnSettled(page, sess1Id, beforeLightCount + 1, 15000);
    await switchThemeViaUI(page, 'claude-code-dark', false);

    recordScenario('2. Full Codex-Style Guardian User Journey', 'PASS', `guardianCalls=${guardian.calls.length}, abortedSlow=${guardian.state.abortedSlowCalls}`);

    /* ------------------------------------------------------------------------
     * SCENARIO 3: Multi-Session (4-Cap), Split-2 Drag/Swap, Layout Shortcuts,
     *             Rich Inspector, ThinkingBlock Bidirectional & Branch Tree
     * ---------------------------------------------------------------------- */
    // 3A. Create sessions 2, 3, 4 (total = 4 active)
    const sess2Id = await createSessionViaModal(page, envFixture.workspace, 'API Gateway Benchmarks');
    await sendPromptViaComposer(page, sess2Id, 'Profile rate limiter throughput under concurrent load.');
    await waitForTurnSettled(page, sess2Id, 1, 15000);

    const sess3Id = await createSessionViaModal(page, envFixture.workspace, 'Schema Migration Audit');
    await sendPromptViaComposer(page, sess3Id, 'Summarize zero-downtime migration steps for PostgreSQL indexes.');
    await waitForTurnSettled(page, sess3Id, 1, 15000);

    const sess4Id = await createSessionViaModal(page, envFixture.workspace, 'Release Telemetry Review');
    await sendPromptViaComposer(page, sess4Id, 'Verify P99 latency metrics for sliding window eviction.');
    await waitForTurnSettled(page, sess4Id, 1, 15000);

    const activeFour = await page.evaluate(async () => (await window.gravityDesktop.listSessions()).filter(s => s.status !== 'closed' && !s.archivedAt).length);
    assert.equal(activeFour, 4, 'Expected exactly 4 concurrent active sessions');

    // Attempt 5th session via UI modal -> verify clean cap enforcement without crashing!
    await page.getByTestId('sidebar-new-session-btn').click();
    await page.getByTestId('new-session-modal').waitFor();
    await typeField(page.getByTestId('new-session-cwd-input'), envFixture.workspace);
    await typeField(page.getByTestId('new-session-title-input'), 'Should Hit 4-Session Cap');
    await page.getByTestId('confirm-create-session-btn').click();
    const capAlert = page.getByTestId('new-session-modal').getByRole('alert');
    await capAlert.waitFor({ timeout: 5000 });
    assert.match(await capAlert.innerText(), /4/);
    await page.keyboard.press('Escape');
    await page.getByTestId('new-session-modal').waitFor({ state: 'detached' });

    // 3B. Split-2 layout + drag/place session into right pane + swap
    await page.getByTestId(`tab-item-${sess1Id}`).click();
    await page.getByTestId('layout-btn-split-2').click();
    const leftSlot = page.getByTestId('workspace-slot-0');
    const rightSlot = page.getByTestId('workspace-slot-1');
    await leftSlot.getByTestId(`session-pane-${sess1Id}`).waitFor();

    // Drag session 2 from sidebar into right slot
    await page.getByTestId(`sidebar-session-${sess2Id}`).dragTo(rightSlot);
    await rightSlot.getByTestId(`session-pane-${sess2Id}`).waitFor({ timeout: 10000 });

    // Swap panes by dragging tab 1 onto right slot, then restore session 1 on left & session 2 on right
    await page.getByTestId(`tab-item-${sess1Id}`).dragTo(rightSlot);
    await rightSlot.getByTestId(`session-pane-${sess1Id}`).waitFor({ timeout: 10000 });
    await leftSlot.getByTestId(`session-pane-${sess2Id}`).waitFor({ timeout: 10000 });
    await page.getByTestId(`tab-item-${sess2Id}`).dragTo(rightSlot);
    await leftSlot.getByTestId(`session-pane-${sess1Id}`).waitFor({ timeout: 10000 });
    await rightSlot.getByTestId(`session-pane-${sess2Id}`).waitFor({ timeout: 10000 });

    // 3C. Right Inspector -> Context & Cost: 24h / 7d / 30d heatmaps & Context / Reviewer / Translator subviews + Quota footer
    await page.getByTestId('inspector-tab-context').click();
    await page.getByTestId('context-cost-inspector').waitFor();

    // Switch heatmaps 24h -> 7d -> 30d -> 24h
    await page.getByTestId('heatmap-range-7d').click();
    await page.getByTestId('heatmap-7d-matrix').waitFor();
    await page.getByTestId('heatmap-range-30d').click();
    await page.getByTestId('heatmap-30d-calendar').waitFor();
    await page.getByTestId('heatmap-range-24h').click();
    await page.getByTestId('heatmap-24h-bars').waitFor();

    // Switch subviews: Reviewer -> Translator -> Context
    await page.getByTestId('ctx-view-switch-reviewer').click();
    await page.getByTestId('external-reviewer-telemetry-view').waitFor();
    await page.getByTestId('ctx-view-switch-translator').click();
    await page.getByTestId('external-translator-telemetry-view').waitFor();
    await page.getByTestId('ctx-view-switch-context').click();
    await page.getByTestId('token-heatmap-section').waitFor();

    // Hover & click Quota footer in left pane -> verify buckets render cleanly
    await dismissToastIfVisible(page);
    const quotaBtn = leftSlot.getByTestId('quota-weekly');
    await quotaBtn.waitFor();
    await quotaBtn.hover();
    const quotaPanel = leftSlot.getByTestId('quota-details');
    await quotaPanel.getByTestId('quota-bucket').first().waitFor({ timeout: 25000 });
    assert.ok(await quotaPanel.getByTestId('quota-bucket').count() >= 2, 'Expected quota buckets from fixture');
    await quotaBtn.click(); // pin open
    assert.ok(await quotaPanel.isVisible());

    // Screenshot 07: Split-2 with two active sessions + Context & Cost Inspector + Quota footer open
    await snap(page, '07-split-pane-context-dark.png', { dismissToast: false });

    // Dismiss quota popover cleanly
    await page.keyboard.press('Escape');
    await quotaPanel.waitFor({ state: 'detached' });

    // 3D. Layout shortcuts: Ctrl+B, Ctrl+J, floating vs docked inspector, Shift+Tab execution mode, Ctrl+= / Ctrl+0 UI zoom
    // Focus topbar/neutral body so shortcuts don't conflict with textarea
    await page.getByTestId('app-topbar').click({ position: { x: 10, y: 10 } });

    // Ctrl+B collapse & restore sidebar
    await page.keyboard.press('Control+b');
    await page.waitForFunction(() => document.querySelector('[data-testid="project-sidebar"]')?.classList.contains('is-collapsed'));
    await page.keyboard.press('Control+b');
    await page.waitForFunction(() => !document.querySelector('[data-testid="project-sidebar"]')?.classList.contains('is-collapsed'));

    // Ctrl+J collapse & restore inspector
    await page.keyboard.press('Control+j');
    await page.waitForFunction(() => document.querySelector('[data-testid="right-inspector"]')?.classList.contains('is-collapsed'));
    await page.keyboard.press('Control+j');
    await page.waitForFunction(() => !document.querySelector('[data-testid="right-inspector"]')?.classList.contains('is-collapsed'));

    // Floating vs docked inspector toggle
    const inspector = page.getByTestId('right-inspector');
    assert.equal(await inspector.getAttribute('data-inspector-mode'), 'docked');
    await page.getByTestId('inspector-float-toggle').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="right-inspector"]')?.getAttribute('data-inspector-mode') === 'floating');
    await page.getByTestId('inspector-float-toggle').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="right-inspector"]')?.getAttribute('data-inspector-mode') === 'docked');

    // Shift+Tab execution mode cycle
    const modePill = leftSlot.getByTestId(`execution-mode-pill-${sess1Id}`);
    const modeBefore = await modePill.innerText();
    await leftSlot.getByTestId(`composer-input-${sess1Id}`).focus();
    await page.keyboard.press('Shift+Tab');
    await page.waitForFunction(
      ({ sid, prev }) => document.querySelector(`[data-testid="execution-mode-pill-${sid}"]`)?.textContent !== prev,
      { sid: sess1Id, prev: modeBefore }
    );
    // Cycle back to default cleanly
    await page.evaluate(sid => window.gravityDesktop.setSessionMode(sid, 'default'), sess1Id);

    // Ctrl+= / Ctrl+0 UI zoom
    const initialDpr = await page.evaluate(() => window.devicePixelRatio);
    await page.keyboard.press('Control+Equal');
    await page.getByTestId('app-toast').filter({ hasText: '110%' }).waitFor({ timeout: 5000 });
    await page.waitForFunction(base => Math.abs(window.devicePixelRatio / base - 1.1) < 0.02, initialDpr);
    await page.keyboard.press('Control+0');
    await page.getByTestId('app-toast').filter({ hasText: '100%' }).waitFor({ timeout: 5000 });
    await page.waitForFunction(base => Math.abs(window.devicePixelRatio / base - 1) < 0.02, initialDpr);

    // Return to single pane for clean ThinkingBlock & Branch tests
    await page.getByTestId('layout-btn-single').click();
    await page.getByTestId(`tab-item-${sess1Id}`).click();

    // 3E. ThinkingBlock dual-track toggle (zh/raw) + collapse & re-expand (bidirectional localStorage persistence)
    const thoughtBlock = page.getByTestId(`thinking-block-${thoughtId}`);
    await thoughtBlock.scrollIntoViewIfNeeded();
    await page.getByTestId(`thought-btn-raw-${thoughtId}`).click();
    assert.ok(await thoughtBlock.evaluate(el => el.classList.contains('is-raw-track')));
    await page.getByTestId(`thought-btn-zh-${thoughtId}`).click();
    assert.ok(await thoughtBlock.evaluate(el => el.classList.contains('is-zh-track')));

    const thoughtHead = thoughtBlock.locator('.cc-thinking-head');
    const wasExpanded = (await thoughtHead.getAttribute('aria-expanded')) === 'true';
    if (!wasExpanded) await thoughtHead.click();
    assert.equal(await thoughtHead.getAttribute('aria-expanded'), 'true');
    // Collapse -> localStorage['gravity.thoughts.expanded'] === 'false'
    await thoughtHead.click();
    assert.equal(await thoughtHead.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => window.localStorage.getItem('gravity.thoughts.expanded')), 'false');
    // Re-expand -> localStorage['gravity.thoughts.expanded'] === 'true'
    await thoughtHead.click();
    assert.equal(await thoughtHead.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => window.localStorage.getItem('gravity.thoughts.expanded')), 'true');

    // 3F. ArrowUp edit previous user message on sess3 -> fork branch -> inline branch switcher (1/2) & Right Inspector Branch Tree
    await page.getByTestId(`tab-item-${sess3Id}`).click();
    const sess3Composer = page.getByTestId(`composer-input-${sess3Id}`);
    await sess3Composer.click();
    await sess3Composer.press('ArrowUp');
    const msgEditor = page.getByRole('textbox', { name: '编辑原消息' });
    await msgEditor.waitFor({ timeout: 5000 });
    await typeField(msgEditor, 'Summarize zero-downtime migration steps using CREATE INDEX CONCURRENTLY and lock_timeout.');
    await msgEditor.press('Control+Enter');

    // Wait for forked branch session to replace tab
    await page.waitForFunction(
      oldId => {
        const inp = document.querySelector('[data-testid^="composer-input-"]');
        return inp && inp.getAttribute('data-testid') !== 'composer-input-' + oldId;
      },
      sess3Id,
      { timeout: 15000 }
    );
    const branchId = (await page.locator('[data-testid^="composer-input-"]').first().getAttribute('data-testid')).slice('composer-input-'.length);
    assert.notEqual(branchId, sess3Id);
    await waitForTurnSettled(page, branchId, 1, 15000);

    // Verify inline branch switcher (`2 / 2`) & switch to previous branch (`1 / 2`)
    const switcher = page.locator('[data-testid^="branch-switcher-"]').first();
    await switcher.waitFor({ timeout: 10000 });
    assert.match(await switcher.innerText(), /2\s*\/\s*2/);
    await switcher.locator('[data-testid^="branch-prev-"]').click();
    await page.getByTestId(`session-pane-${sess3Id}`).waitFor({ timeout: 10000 });
    assert.match(await page.locator('[data-testid^="branch-switcher-"]').first().innerText(), /1\s*\/\s*2/);

    // Verify Right Inspector Branch Tree tab & switch back to forked branch via tree node
    await page.getByTestId('inspector-tab-tree').click();
    await page.getByTestId('conversation-tree-panel').waitFor();
    assert.match(await page.getByTestId('conversation-tree-branch-count').innerText(), /2/);
    await page.getByTestId(`tree-node-${branchId}`).click();
    await page.getByTestId(`session-pane-${branchId}`).waitFor({ timeout: 10000 });

    recordScenario('3. Multi-Session 4-Cap, Split-2 Drag/Swap, Shortcuts, Context, Thinking & Branches', 'PASS', `4-cap enforced, branch ${sess3Id} -> ${branchId} verified`);

    /* ------------------------------------------------------------------------
     * SCENARIO 4: Themes (All 6 Presets), en-US Bilingual Sweep, Plugins,
     *             Profiles, Session Actions, & Full Restart Persistence
     * ---------------------------------------------------------------------- */
    // 4A. Settings -> Themes: capture Screenshot 10 (Dark) & cycle all 6 presets verifying data-theme
    await page.keyboard.press('Control+,');
    await page.getByTestId('settings-tab-themes').click();
    await page.getByTestId('theme-group-dark').waitFor();
    await snap(page, '10-settings-themes-dark.png');

    for (const presetId of ALL_PRESET_THEMES) {
      await page.getByTestId(`theme-card-${presetId}`).click();
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, presetId);
    }

    // 4B. Switch locale to en-US + Claude Code Light -> sweep Settings -> Plugins & Approvals for zero CJK leaks
    await page.getByTestId('theme-card-claude-code-light').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'claude-code-light');
    await page.getByTestId('settings-tab-general').click();
    await page.locator('.settings-section .segmented-btn').filter({ hasText: 'English' }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'en-US');

    function assertNoLeakedCjk(text, contextLabel) {
      const cleaned = text.replace(/简体中文|中文/g, '');
      const match = CJK_RE.exec(cleaned);
      if (match) {
        const idx = match.index;
        const snippet = cleaned.slice(Math.max(0, idx - 25), idx + 35).replace(/\s+/g, ' ');
        recordFinding('MEDIUM', `en-US CJK leak (${contextLabel})`, `Found CJK near: "${snippet}"`);
        throw new Error(`Leaked CJK in en-US ${contextLabel}: "${snippet}"`);
      }
    }

    // Open Settings -> Plugins and sweep all 4 tabs (builtins, plugins, mcp, skills)
    await page.getByTestId('settings-tab-plugins').click();
    await page.getByTestId('plugins-manager-modal').waitFor();
    // Wait for refresh to finish populating mock plugins
    await page.getByTestId('plugins-tab-plugins').click();
    await page.getByTestId('plugin-row-chrome-devtools-mcp').waitFor({ timeout: 10000 });
    assertNoLeakedCjk(await page.getByTestId('theme-settings-modal').innerText(), 'Settings -> Plugins (Plugins tab)');

    // Screenshot 09: en-US + Claude Code Light Settings -> Plugins
    await snap(page, '09-settings-plugins-en-light.png');

    for (const tab of ['builtins', 'mcp', 'skills']) {
      await page.getByTestId(`plugins-tab-${tab}`).click();
      await delay(120);
      assertNoLeakedCjk(await page.getByTestId('theme-settings-modal').innerText(), `Settings -> Plugins (${tab} tab)`);
    }

    // Open Settings -> Approvals and sweep Rules, Audit (UI chrome/labels), Reviewer for zero CJK leaks
    await page.getByTestId('settings-tab-approvals').click();
    await page.getByTestId('approval-drawer').waitFor();
    for (const tab of ['rules', 'reviewer']) {
      await page.getByTestId(`drawer-tab-${tab}`).click();
      await delay(120);
      assertNoLeakedCjk(await page.getByTestId('theme-settings-modal').innerText(), `Settings -> Approvals (${tab} tab)`);
    }
    await page.getByTestId('drawer-tab-audit').click();
    await delay(120);
    // Audit UI chrome (nav, tabs, headers, verdict badges, decision source labels) must have zero CJK;
    // audit row `.list-row-desc` contains backend/model reason strings recorded during earlier zh-CN turns — inspect separately!
    const auditChromeText = await page.getByTestId('theme-settings-modal').evaluate(el => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.audit-row .list-row-desc').forEach(n => n.remove());
      return clone.textContent || '';
    });
    assertNoLeakedCjk(auditChromeText, 'Settings -> Approvals (audit chrome/badges)');
    const auditReasonCjkCount = await page.locator('.audit-row .list-row-desc').evaluateAll(
      nodes => nodes.filter(n => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(n.textContent || '')).length
    );
    if (auditReasonCjkCount > 0) {
      recordFinding(
        'LOW',
        'i18n/audit-reasons',
        `${auditReasonCjkCount} audit entry reason strings stored by backend ApprovalEngine remain in Chinese when UI switches to en-US (expected for historical zh-CN mock reviewer reasons, though backend static reasons like "用户仅允许此次操作" are also hardcoded Chinese).`
      );
    }

    // 4C. Profile creation & switching (confirm session isolation)
    await page.getByTestId('settings-tab-accounts').click();
    await page.getByTestId('accounts-manager-modal').waitFor();
    await typeField(page.getByTestId('create-profile-input'), 'QA Isolated Profile');
    await page.getByTestId('create-profile-btn').click();
    const newProfileRow = page.locator('[data-testid^="profile-row-"]').filter({ hasText: 'QA Isolated Profile' });
    await newProfileRow.waitFor({ timeout: 10000 });
    const isoProfileId = (await newProfileRow.getAttribute('data-testid')).slice('profile-row-'.length);

    // Switch to isolated profile -> confirm 0 sessions & distinct profile model catalog
    await page.getByTestId(`switch-profile-${isoProfileId}`).click();
    await page.getByTestId(`profile-row-${isoProfileId}`).locator('.badge-accent').waitFor({ timeout: 15000 });
    const isoSessions = await page.evaluate(() => window.gravityDesktop.listSessions());
    assert.deepEqual(isoSessions, [], 'Isolated profile must start with zero sessions');

    // Switch back to default profile -> confirm all default sessions remain intact
    await page.getByTestId('switch-profile-default').click();
    await page.getByTestId('profile-row-default').locator('.badge-accent').waitFor({ timeout: 15000 });
    const restoredDefaultSessions = await page.evaluate(() => window.gravityDesktop.listSessions());
    assert.ok(restoredDefaultSessions.some(s => s.sessionId === sess1Id), 'Default profile sessions must survive profile switch');

    // Close settings & switch back to zh-CN + claude-code-dark? Keep solarized-dark + en-US to verify persistence across restart!
    await page.getByTestId('settings-tab-themes').click();
    await page.getByTestId('theme-card-solarized-dark').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'solarized-dark');
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-overlay').waitFor({ state: 'detached' });

    // 4D. Session rename, pin, archive, restore, & delete
    const sess4Row = page.getByTestId(`sidebar-session-${sess4Id}`);
    await sess4Row.hover();
    await page.getByTestId(`rename-btn-${sess4Id}`).click();
    const renameInput = page.getByTestId(`rename-input-${sess4Id}`);
    await renameInput.waitFor();
    await typeField(renameInput, 'Renamed Telemetry QA');
    await renameInput.press('Enter');
    await page.locator(`[data-testid="sidebar-session-${sess4Id}"] .thread-title`).filter({ hasText: 'Renamed Telemetry QA' }).waitFor();

    // Pin session 4 (blur focus + move pointer away so hover/focus-within actions hide and .thread-pin icon becomes visible!)
    await sess4Row.hover();
    await page.getByTestId(`pin-btn-${sess4Id}`).click();
    await page.evaluate(() => (document.activeElement)?.blur?.());
    await page.getByTestId('app-topbar').hover();
    await sess4Row.locator('.thread-pin').waitFor();
    const pinnedState = await page.evaluate(async sid => (await window.gravityDesktop.listSessions()).find(s => s.sessionId === sid)?.pinned, sess4Id);
    assert.equal(pinnedState, true, 'Session 4 should be persisted as pinned');

    // Archive session 4 -> verify appears in archived-sessions -> restore -> then delete!
    await sess4Row.hover();
    await page.getByTestId(`manage-session-${sess4Id}`).click();
    const manageDialog = page.locator('dialog.session-actions-dialog[open]');
    await manageDialog.waitFor();
    await manageDialog.getByRole('button', { name: /Archive conversation|归档会话/ }).click();
    await manageDialog.waitFor({ state: 'detached' });

    const archiveDetails = page.getByTestId('archived-sessions');
    await archiveDetails.waitFor();
    await archiveDetails.locator('summary').click();
    await page.getByTestId(`archived-session-${sess4Id}`).click();
    await manageDialog.waitFor();
    await manageDialog.getByRole('button', { name: /Restore conversation|恢复会话/ }).click();
    await manageDialog.waitFor({ state: 'detached' });
    await page.getByTestId(`sidebar-session-${sess4Id}`).waitFor();

    // Delete disposable session 4 permanently
    await page.getByTestId(`sidebar-session-${sess4Id}`).hover();
    await page.getByTestId(`manage-session-${sess4Id}`).click();
    await manageDialog.waitFor();
    await manageDialog.getByRole('button', { name: /Delete conversation|删除会话/ }).click();
    await manageDialog.getByRole('button', { name: /Permanently delete|确认永久删除/ }).click();
    await manageDialog.waitFor({ state: 'detached' });
    await page.getByTestId(`sidebar-session-${sess4Id}`).waitFor({ state: 'detached' });

    assert.deepEqual(pageErrors, [], 'Page errors encountered during Launch #1: ' + JSON.stringify(pageErrors));
    recordScenario('4A-D. Themes, en-US Bilingual Sweep, Profiles & Session Actions', 'PASS', 'All 6 presets, zero CJK leaks in UI chrome, isolated profile & session lifecycle verified');

    // 4E. Full Electron close & relaunch -> verify persisted messages, theme, and settings survive restart!
    logStep('RESTART', 'Closing Gravity.exe to verify cross-process persistence...');
    await appInstance.close();
    appInstance = undefined;

    relaunchedApp = await launchPackagedApp(executable, envFixture.profile, envFixture.env, envFixture.workspace);
    const page2 = relaunchedApp.page;
    await page2.waitForFunction(() => document.documentElement.dataset.theme === 'solarized-dark');
    assert.equal(await page2.evaluate(() => document.documentElement.lang), 'en-US', 'Locale en-US should persist across relaunch');

    const persistedBoot = await page2.evaluate(() => window.gravityDesktop.getBootstrap());
    assert.equal(persistedBoot.preferences.theme, 'solarized-dark');
    assert.equal(persistedBoot.preferences.locale, 'en-US');
    assert.equal(persistedBoot.approvalConfig.mode, 'hybrid');
    assert.equal(persistedBoot.approvalConfig.externalReviewer.model, 'gpt-6.2-astra');
    assert.equal(persistedBoot.sessions.some(s => s.sessionId === sess4Id), false, 'Deleted session must stay deleted after relaunch');
    assert.equal(persistedBoot.sessions.some(s => s.sessionId === sess1Id), true, 'Primary session must persist after relaunch');

    const persistedMsgs = await page2.evaluate(async sid => (await window.gravityDesktop.getSessionMessagePage(sid)).messages, sess1Id);
    assert.ok(persistedMsgs.length >= 16, `Expected persisted messages for ${sess1Id}, got ${persistedMsgs.length}`);
    assert.ok(persistedMsgs.some(m => m.content.includes('滑动窗口限流中间件重构完成')), 'Expected first turn markdown persisted');
    assert.deepEqual(relaunchedApp.pageErrors, [], 'Page errors encountered during Launch #2: ' + JSON.stringify(relaunchedApp.pageErrors));

    recordScenario('4E. Full Electron Close & Relaunch Persistence', 'PASS', `theme=solarized-dark, locale=en-US, approval=hybrid, ${persistedMsgs.length} messages restored`);

    // Final verification of all 10 PNG screenshots
    const expectedShots = [
      '01-welcome-dark.png',
      '02-welcome-light.png',
      '03-chat-guardian-reviewing-dark.png',
      '04-chat-stage3-approval-dark.png',
      '05-chat-stage3-approval-light.png',
      '06-composer-grants-popover-dark.png',
      '07-split-pane-context-dark.png',
      '08-settings-approvals-dark.png',
      '09-settings-plugins-en-light.png',
      '10-settings-themes-dark.png',
    ];
    for (const file of expectedShots) {
      const st = await stat(path.join(SCREENSHOT_DIR, file));
      assert.ok(st.size > 10_000, `Expected ${file} > 10KB, got ${st.size}`);
    }

    console.log('\n=== OFFLINE E2E SUMMARY ===');
    for (const r of scenarioResults) console.log(`  [${r.status}] ${r.name} — ${r.detail}`);
    if (findings.length) {
      console.log('\n=== QA FINDINGS ===');
      for (const f of findings) console.log(`  [${f.severity}] ${f.area}: ${f.detail}`);
    }
    console.log(`\nALL 10 SCREENSHOTS VERIFIED IN ${SCREENSHOT_DIR}`);
  } finally {
    if (relaunchedApp) await relaunchedApp.close().catch(() => {});
    if (appInstance) await appInstance.close().catch(() => {});
    await guardian.close().catch(() => {});
    await removeTreeWithRetry(envFixture.root);
  }
})().catch(err => {
  console.error('\nOFFLINE E2E FAILED:', err);
  process.exitCode = 1;
});
