// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMacTerminalLogin } from '../src/main/accounts/macos-login';
import { AcpClient } from '../src/main/acp/acp-client';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import { screenCommand } from '../src/main/approval/shell-screening';
import type { Reviewer } from '../src/main/approval/external-reviewer';
import { CoreService } from '../src/main/core-service';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { ClientStore } from '../src/main/storage/client-store';
import { SwarmArchive } from '../src/main/swarm/swarm-archive';
import { SwarmTracker } from '../src/main/swarm/swarm-tracker';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { GitHubUpdater } from '../src/main/updater/github-updater';
import { windowsUpdateScript } from '../src/main/updater/windows-installer';
import {
  DEFAULT_APPROVAL_CONFIG,
  type AcpConfigOption,
  type AcpRequestPermissionParams,
  type ExternalAiReviewerConfig,
  type PendingApprovalRequest,
} from '../src/shared';

/* ============================================================================
 * Helpers & Fixtures
 * ========================================================================== */

const tempDirs: string[] = [];
const engines: ApprovalEngine[] = [];
const services: CoreService[] = [];
const telemetries: TelemetryStore[] = [];
const servers: Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const connectedLocalReviewer: ExternalAiReviewerConfig = {
  enabled: true,
  provider: 'local-ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5-coder:7b',
  timeoutMs: 3000,
  maxOutputTokens: 2048,
  thinkingLevel: 'auto',
  connectionStatus: 'connected',
  verificationMethod: 'review-call',
  lastVerifiedAt: '2026-11-25T00:00:00.000Z',
};

function makePerm(overrides: {
  sessionId?: string;
  toolCallId?: string;
  kind?: string;
  title?: string;
  rawInput?: string | Record<string, unknown>;
  locations?: Array<{ path: string }>;
} = {}): AcpRequestPermissionParams {
  return {
    sessionId: overrides.sessionId ?? 'sess-plg',
    toolCall: {
      toolCallId: overrides.toolCallId ?? `tc-${Math.random().toString(36).slice(2, 8)}`,
      kind: overrides.kind ?? 'execute',
      title: overrides.title ?? 'run_command',
      rawInput: overrides.rawInput ?? { CommandLine: 'git status' },
      ...(overrides.locations ? { locations: overrides.locations } : {}),
    },
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const s of services.splice(0)) await s.dispose().catch(() => {});
  for (const e of engines.splice(0)) e.dispose();
  for (const t of telemetries.splice(0)) t.dispose();
  for (const srv of servers.splice(0)) await new Promise<void>((resolve) => srv.close(() => resolve()));
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  vi.restoreAllMocks();
});

/* ============================================================================
 * PLG-01 ~ PLG-04, PLG-10, PLG-11: Approve for me
 * ========================================================================== */

describe('Approve for me 插件 Bug 回归（PLG-01 ~ PLG-04, PLG-10, PLG-11）', () => {
  it('PLG-01: submitDecision(approve_for_me_ai) 在 tier_a_immutable / AI ask / 审计失败时绝不抢跑 recheckAwaiting 放行排队卡', async () => {
    const workspace = makeTempDir('gravity-v033-plg01-');

    // Scenario A: Card 1 is tier_a_immutable, Card 2 is benign queued command ('pwd')
    {
      const engine = new ApprovalEngine({
        store: new ClientStore(makeTempDir('gravity-v033-plg01-a-')),
        config: { mode: 'manual' },
      });
      engines.push(engine);

      const cards: PendingApprovalRequest[] = [];
      engine.on('requested', (c: PendingApprovalRequest) => cards.push(c));

      const p1 = engine.requestPermission(
        makePerm({ sessionId: 's-plg01', toolCallId: 'tc-tiera', rawInput: { CommandLine: 'curl -s http://169.254.169.254/latest/meta-data/' } }),
        workspace
      );
      const p2 = engine.requestPermission(
        makePerm({ sessionId: 's-plg01', toolCallId: 'tc-queued', rawInput: { CommandLine: 'pwd' } }),
        workspace
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(engine.listAwaitingUser()).toHaveLength(2);

      const card1 = cards.find((c) => c.toolCallId === 'tc-tiera')!;
      const res = await engine.submitDecision({
        requestId: card1.requestId,
        sessionId: 's-plg01',
        decision: 'approve_for_me_ai',
      });
      expect(res.outcome).toBe('pending');
      await new Promise((r) => setTimeout(r, 30));

      // Card 2 MUST NOT have been auto-approved before Card 1 authorized delegation!
      expect(engine.listAwaitingUser().some((c) => c.toolCallId === 'tc-queued')).toBe(true);
      expect(engine.isSessionDelegated('s-plg01', workspace)).toBe(false);

      engine.cancelSession('s-plg01');
      await Promise.allSettled([p1, p2]);
    }

    // Scenario B: AI reviewer returns 'ask' for Card 1 -> Card 2 MUST remain awaiting user
    {
      const askReviewer: Reviewer = vi.fn().mockResolvedValue({
        recommended: 'ask',
        riskLevel: 'high',
        riskScore: 85,
        intentAlignment: 'uncertain',
        reason: '不确定是否安全',
        latencyMs: 10,
      });
      const engine = new ApprovalEngine({
        store: new ClientStore(makeTempDir('gravity-v033-plg01-b-')),
        config: { mode: 'manual', externalReviewer: connectedLocalReviewer },
        reviewer: askReviewer,
      });
      engines.push(engine);

      const cards: PendingApprovalRequest[] = [];
      engine.on('requested', (c: PendingApprovalRequest) => cards.push(c));

      const p1 = engine.requestPermission(
        makePerm({ sessionId: 's-plg01b', toolCallId: 'tc-ask1', rawInput: { CommandLine: 'git push origin main' } }),
        workspace
      );
      const p2 = engine.requestPermission(
        makePerm({ sessionId: 's-plg01b', toolCallId: 'tc-pwd2', rawInput: { CommandLine: 'pwd' } }),
        workspace
      );
      await new Promise((r) => setTimeout(r, 20));
      const card1 = cards.find((c) => c.toolCallId === 'tc-ask1')!;

      const res = await engine.submitDecision({
        requestId: card1.requestId,
        sessionId: 's-plg01b',
        decision: 'approve_for_me_ai',
      });
      expect(res.outcome).toBe('pending');
      await new Promise((r) => setTimeout(r, 30));

      expect(engine.listAwaitingUser().some((c) => c.toolCallId === 'tc-pwd2')).toBe(true);
      engine.cancelSession('s-plg01b');
      await Promise.allSettled([p1, p2]);
    }
  });

  it('PLG-02: Stage 1A 绝不扫描代码 Content/Replacement 正文，编辑 secret-vault.ts 等源码不被误杀硬拒绝', async () => {
    const workspace = makeTempDir('gravity-v033-plg02-');
    const vaultPath = path.join(workspace, 'src', 'main', 'services', 'secret-vault.ts');
    mkdirSync(path.dirname(vaultPath), { recursive: true });
    writeFileSync(vaultPath, 'export const old = 1;\n', 'utf8');

    const engine = new ApprovalEngine({
      store: new ClientStore(makeTempDir('gravity-v033-plg02-store-')),
      config: { mode: 'rules-only' },
    });
    engines.push(engine);
    engine.setSessionExecutionMode('sess-plg02', 'accept-edits');

    const writeRes = await engine.requestPermission(
      makePerm({
        sessionId: 'sess-plg02',
        kind: 'edit',
        title: 'write_file',
        rawInput: {
          Path: vaultPath,
          Content: 'const max_tokens_limit = 4096;\nconst password_hash = computeHash(oauth_token);\n',
        },
        locations: [{ path: vaultPath }],
      }),
      workspace
    );
    expect(writeRes).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    const editRes = await engine.requestPermission(
      makePerm({
        sessionId: 'sess-plg02',
        kind: 'edit',
        title: 'edit_file',
        rawInput: {
          Path: vaultPath,
          Target: 'password_hash',
          Replacement: 'const refresh_token_cookie_secret = verifyCredentials(input);',
        },
        locations: [{ path: vaultPath }],
      }),
      workspace
    );
    expect(editRes).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('PLG-03: 链式/管道 git diff --ext-diff / --no-index 与 git show --ext-diff 均被阻断（绝不 0ms 自动放行）', () => {
    const workspace = makeTempDir('gravity-v033-plg03-');
    const cfg = { ...DEFAULT_APPROVAL_CONFIG, mode: 'rules-only' as const };

    for (const bypassCmd of [
      'pwd && git diff --ext-diff',
      'pwd && git diff --no-index /etc/hosts README.md',
      'git show --ext-diff HEAD',
      'git status && git show --ext-diff HEAD:package.json',
      'git diff --ext-diff | head -n 10',
    ]) {
      expect(screenCommand(bypassCmd, workspace, cfg).verdict, `must NOT auto_approve: ${bypassCmd}`).not.toBe('auto_approve');
    }
    expect(screenCommand('pwd && git diff --stat', workspace, cfg).verdict).toBe('auto_approve');
  });

  it('PLG-04: 403 错 Key 测试连接失败后，更换正确 Key 立即重测可直接成功（不被 300s 熔断锁死）', async () => {
    const server = createServer((req, res) => {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer sk-v033-correct-key') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  recommended: 'approve',
                  riskLevel: 'safe',
                  riskScore: 5,
                  intentAlignment: 'aligned',
                  reason: '连接测试通过',
                }),
              },
            },
          ],
        })
      );
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}/v1`;

    const core = new CoreService({
      dataDir: makeTempDir('gravity-v033-plg04-'),
      enableAutoUpdateCheck: false,
    });
    services.push(core);

    const wrongRes = await core.testExternalReviewerConnection({
      enabled: true,
      provider: 'openai-compatible',
      endpoint,
      model: 'gpt-4o-mini',
      apiKey: 'sk-v033-wrong-key',
      timeoutMs: 3000,
    });
    expect(wrongRes.ok).toBe(false);

    // Immediately retry with corrected API key (0ms wait — must NOT be locked out for 300s!)
    const rightRes = await core.testExternalReviewerConnection({
      enabled: true,
      provider: 'openai-compatible',
      endpoint,
      model: 'gpt-4o-mini',
      apiKey: 'sk-v033-correct-key',
      timeoutMs: 3000,
    });
    expect(rightRes.ok).toBe(true);
  });

  it('PLG-10: PowerShell @\'...\'@ here-string 内部含单引号时词法正确，不反转引号状态', async () => {
    const workspace = makeTempDir('gravity-v033-plg10-');
    const cmdWithApostrophe = [
      "@'",
      "msg = \"it's a valid apostrophe inside here-string\"",
      'print(msg)',
      "'@ | python -",
    ].join('\n');

    // In hybrid mode, AI-primary review must still see it as non-unbalanced static here-string (not Tier A parse failure)
    const reviewer = vi.fn<Reviewer>().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'low',
      riskScore: 12,
      intentAlignment: 'aligned',
      reason: '只读打印脚本，含合法撇号',
      latencyMs: 10,
    });
    const engine = new ApprovalEngine({
      store: new ClientStore(makeTempDir('gravity-v033-plg10-store-')),
      config: { mode: 'hybrid', externalReviewer: connectedLocalReviewer },
      reviewer,
    });
    engines.push(engine);

    const res = await engine.requestPermission(
      makePerm({ sessionId: 's-plg10', rawInput: { CommandLine: cmdWithApostrophe } }),
      workspace
    );
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(reviewer).toHaveBeenCalledTimes(1);
    // Inline interpreter (`node -`) remains tier_b_intent_gated, but is NOT falsely flagged as malformed/tier_a_immutable
    expect(reviewer.mock.calls[0][3]?.floorTier).toBe('tier_b_intent_gated');
    expect(reviewer.mock.calls[0][3]?.localRiskReason ?? '').not.toMatch(/未闭合|malformed|syntax/i);
  });

  it('PLG-11: cancelStage2Review 规则变更后保留人工接管不重送 AI，且 approve_for_me_ai 拒绝保留原 aiSuggestion.reason', async () => {
    const workspace = makeTempDir('gravity-v033-plg11-');

    // Part A: cancelStage2Review manualTakeover survives subsequent updateConfig()
    {
      let reviewCalls = 0;
      const hangingReviewer: Reviewer = vi.fn((_cmd, _cwd, _cfg, ctx) => {
        reviewCalls += 1;
        return new Promise((_res, rej) => {
          ctx?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }) as unknown as Reviewer;
      const engine = new ApprovalEngine({
        store: new ClientStore(makeTempDir('gravity-v033-plg11-a-')),
        config: { mode: 'hybrid', externalReviewer: connectedLocalReviewer },
        reviewer: hangingReviewer,
      });
      engines.push(engine);

      let reviewingId = '';
      engine.on('approval-reviewing', (ev: { requestId: string; status: string }) => {
        if (ev.status === 'reviewing') reviewingId = ev.requestId;
      });
      const perm = engine.requestPermission(
        makePerm({ sessionId: 's-plg11a', rawInput: { CommandLine: 'git commit -m "manual takeover"' } }),
        workspace
      );
      await vi.waitFor(() => expect(reviewingId).not.toBe(''));
      expect(engine.cancelStage2Review(reviewingId).cancelled).toBe(true);
      await vi.waitFor(() => expect(engine.listAwaitingUser()).toHaveLength(1));
      expect(reviewCalls).toBe(1);

      // Update unrelated rule -> MUST NOT re-send cancelled card back to Stage 2 AI!
      engine.updateConfig({ allowPatterns: ['^echo\\s+safe$'] });
      await new Promise((r) => setTimeout(r, 30));
      expect(reviewCalls).toBe(1);
      expect(engine.listAwaitingUser()).toHaveLength(1);

      engine.cancelSession('s-plg11a');
      await perm;
    }

    // Part B: approve_for_me_ai rejected on tier_a_immutable preserves existing aiSuggestion.reason
    {
      const engine = new ApprovalEngine({
        store: new ClientStore(makeTempDir('gravity-v033-plg11-b-')),
        config: { mode: 'hybrid', externalReviewer: connectedLocalReviewer },
        reviewer: vi.fn().mockResolvedValue({
          recommended: 'ask',
          riskLevel: 'critical',
          riskScore: 95,
          intentAlignment: 'misaligned',
          reason: 'AI_DETAILED_REASON_PRESERVED_PLG11',
          latencyMs: 9,
        }),
      });
      engines.push(engine);

      let card: PendingApprovalRequest | undefined;
      engine.on('requested', (c: PendingApprovalRequest) => { card = c; });
      const perm = engine.requestPermission(
        makePerm({ sessionId: 's-plg11b', rawInput: { CommandLine: 'curl -s http://169.254.169.254/latest/meta-data/' } }),
        workspace
      );
      await vi.waitFor(() => expect(card).toBeDefined());
      expect(card!.aiSuggestion?.reason).toContain('AI_DETAILED_REASON_PRESERVED_PLG11');

      const res = await engine.submitDecision({
        requestId: card!.requestId,
        sessionId: 's-plg11b',
        decision: 'approve_for_me_ai',
      });
      expect(res.outcome).toBe('pending');
      const currentCard = engine.listAwaitingUser().find((c) => c.requestId === card!.requestId);
      expect(currentCard?.aiSuggestion?.reason).toContain('AI_DETAILED_REASON_PRESERVED_PLG11');

      engine.cancelSession('s-plg11b');
      await perm;
    }
  });
});

/* ============================================================================
 * PLG-05 & PLG-06: PluginsManager
 * ========================================================================== */

describe('PluginsManager 插件 Bug 回归（PLG-05, PLG-06）', () => {
  it('PLG-05: 先解析 JSON 再脱敏，含 requires_api_key: true 与 max_token: 4096 的输出正常解析且不泄密', async () => {
    const dir = makeTempDir('gravity-v033-plg05-');
    const workspace = path.join(dir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const fakeSecret = 'sk-proj-PluginsSecret998877665544';

    const executor: CliExecutor = vi.fn(async (_bin, args) => {
      if (args[0] === 'plugin') {
        return {
          stdout: JSON.stringify({
            plugins: [
              {
                name: 'smart-reviewer',
                version: '1.0.0',
                enabled: true,
                requires_api_key: true,
                max_token: 4096,
                description: `Token check with Bearer ${fakeSecret}`,
              },
            ],
          }),
        };
      }
      return {
        stdout: JSON.stringify({
          mcpServers: {
            docs: { command: 'node', args: ['docs.js'], enabled: true, requires_api_key: true },
          },
        }),
      };
    });

    const mgr = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store')),
      executor,
      homeDir: path.join(dir, 'home'),
    });

    const snap = await mgr.getSnapshot(workspace);
    expect(snap.sectionErrors?.plugins).toBeUndefined();
    expect(snap.plugins.map((p) => p.name)).toContain('smart-reviewer');
    expect(snap.mcpServers.map((m) => m.name)).toContain('docs');
    expect(JSON.stringify(snap)).not.toContain(fakeSecret);
  });

  it('PLG-06: 单个 Scope 异常（如 ENOTDIR）不归零全部 Skills，且正确发现 cookie-debugging/SKILL.md', async () => {
    const dir = makeTempDir('gravity-v033-plg06-');
    const workspace = path.join(dir, 'workspace');
    const homeDir = path.join(dir, 'home');

    const cookieSkill = path.join(workspace, '.agents', 'skills', 'cookie-debugging', 'SKILL.md');
    const okSkill = path.join(workspace, '.agents', 'skills', 'code-audit', 'SKILL.md');
    mkdirSync(path.dirname(cookieSkill), { recursive: true });
    mkdirSync(path.dirname(okSkill), { recursive: true });
    writeFileSync(cookieSkill, '---\nname: Cookie Debugging\ndescription: Inspect cookies safely\n---\nbody', 'utf8');
    writeFileSync(okSkill, '---\nname: Code Audit\ndescription: General audit\n---\nbody', 'utf8');

    // Occupy global skills scope (~/.gemini/config/skills) with a regular FILE to trigger ENOTDIR (non-ENOENT error)
    const brokenScope = path.join(homeDir, '.gemini', 'config', 'skills');
    mkdirSync(path.dirname(brokenScope), { recursive: true });
    writeFileSync(brokenScope, 'not-a-directory', 'utf8');

    const mgr = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store')),
      executor: vi.fn<CliExecutor>(async (_bin, args) => ({
        stdout: args[0] === 'plugin' ? JSON.stringify({ plugins: [] }) : JSON.stringify({ mcpServers: {} }),
      })),
      homeDir,
    });

    const snap = await mgr.getSnapshot(workspace);
    const names = snap.skills.map((s) => s.name);
    expect(names).toContain('Code Audit');
    expect(names).toContain('Cookie Debugging');
  });
});

/* ============================================================================
 * PLG-07 & PLG-14: Swarm
 * ========================================================================== */

describe('Swarm 插件 Bug 回归（PLG-07, PLG-14）', () => {
  it('PLG-07: count > 1 批量派生共享输出 id 时保留全部独立 Worker 行（dev-1..3）而不互相覆盖', () => {
    const tracker = new SwarmTracker();
    tracker.consume('s-batch', {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-batch-1',
      name: 'swarm',
      status: 'completed',
      rawInput: { action: 'add', name: 'dev', n: 3, brief: 'parallel slice' },
      rawOutput: { id: 'shared-output-id', count: 3 },
    });

    const state = tracker.getState('s-batch');
    expect(state.workers).toHaveLength(3);
    expect(state.workers.map((w) => w.name)).toEqual(['dev-1', 'dev-2', 'dev-3']);
    expect(new Set(state.workers.map((w) => w.id)).size).toBe(3);
  });

  it('PLG-14: 存储报错时 getState() 不二次触发阻塞重试，且 flush() 单会话报错不阻塞其余会话落盘', () => {
    const dir = makeTempDir('gravity-v033-plg14-');
    const disk = new ClientStore(dir);
    const tracker = new SwarmTracker(disk);
    const dir2 = makeTempDir('gravity-v033-plg14-flush-');
    const disk2 = new ClientStore(dir2);
    const tracker2 = new SwarmTracker(disk2);
    let reopened: SwarmTracker | undefined;
    try {
      tracker.setProfile('default');

      // Part A: archive write fails -> subsequent getState() must NOT call archive.write again while in error state
      const writeSpy = vi.spyOn(SwarmArchive.prototype, 'write').mockImplementation(() => {
        throw new Error('simulated sqlite busy');
      });
      tracker.consume('s-err', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-err-1',
        name: 'post_message',
        status: 'completed',
        rawInput: { sender: 'lead', content: 'first' },
      });
      const callsAfterConsume = writeSpy.mock.calls.length;
      expect(callsAfterConsume).toBeGreaterThanOrEqual(1);
      tracker.getState('s-err');
      expect(writeSpy.mock.calls.length).toBe(callsAfterConsume);
      writeSpy.mockRestore();

      // Part B: flush() isolates per-session failure so s-good still persists when s-bad fails
      tracker2.setProfile('default');
      const origWrite = SwarmArchive.prototype.write;
      let blockAll = true;
      vi.spyOn(SwarmArchive.prototype, 'write').mockImplementation(function (this: SwarmArchive, sid, operation) {
        if (blockAll || sid === 's-bad') throw new Error(`write failed for ${sid}`);
        return origWrite.call(this, sid, operation);
      });

      tracker2.consume('s-bad', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-bad',
        name: 'post_message',
        status: 'completed',
        rawInput: { sender: 'a', content: 'bad session msg' },
      });
      tracker2.consume('s-good', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-good',
        name: 'post_message',
        status: 'completed',
        rawInput: { sender: 'b', content: 'good session msg' },
      });

      blockAll = false;
      expect(() => tracker2.flush()).not.toThrow();

      reopened = new SwarmTracker(disk2);
      reopened.setProfile('default');
      expect(reopened.getState('s-good').boardMessages.map((m) => m.content)).toEqual(['good session msg']);
    } finally {
      reopened?.clear();
      tracker2.clear();
      tracker.clear();
    }
  });
});

/* ============================================================================
 * PLG-08 & PLG-09: GitHub Updater & Windows Installer
 * ========================================================================== */

describe('GitHub Updater & Windows Installer Bug 回归（PLG-08, PLG-09）', () => {
  it('PLG-08: 非 200 释放 body、特殊字符 tag 安全编码、以及 Windows rename 瞬态 EBUSY 重试不删 .part', async () => {
    // 1. Non-200 body cancel + special tag encoding (+ in tag)
    let errorBodyCancelled = false;
    let expandedAssetsUrl = '';
    const updater1 = new GitHubUpdater({
      currentVersion: '0.3.2',
      updatesDir: makeTempDir('gravity-v033-plg08-tag-'),
      platform: 'win32',
      arch: 'x64',
      fetcher: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.github.com')) {
          const stream = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(new Uint8Array([123, 125])); },
            cancel() { errorBodyCancelled = true; },
          });
          return new Response(stream, { status: 403 });
        }
        if (url === 'https://github.com/Mikotou/G-Gravity/releases/latest') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/Mikotou/G-Gravity/releases/tag/v0.3.3+hotfix.1' },
          });
        }
        if (url.includes('/releases/expanded_assets/')) {
          expandedAssetsUrl = url;
          return new Response(
            '<a href="/Mikotou/G-Gravity/releases/download/v0.3.3%2Bhotfix.1/Gravity.exe">Gravity.exe</a>',
            { status: 200, headers: { 'content-type': 'text/html' } }
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch,
    });

    const checked = await updater1.checkForUpdates();
    expect(checked.status).toBe('available');
    expect(errorBodyCancelled).toBe(true);
    expect(expandedAssetsUrl).toContain('v0.3.3%2Bhotfix.1');

    // 2. Windows transient EBUSY/EPERM on fs.promises.rename retries cleanly without deleting .part
    const updatesDir2 = makeTempDir('gravity-v033-plg08-rename-');
    const payload = Buffer.from('MZ-v033-rename-retry');
    const origRename = fsPromises.rename.bind(fsPromises);
    let renameFails = 2;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (renameFails > 0 && String(oldPath).endsWith('.part')) {
        renameFails -= 1;
        throw Object.assign(new Error('EBUSY: Defender scanning file'), { code: 'EBUSY' });
      }
      return origRename(oldPath, newPath);
    });

    const updater2 = new GitHubUpdater({
      currentVersion: '0.3.2',
      updatesDir: updatesDir2,
      platform: 'win32',
      arch: 'x64',
      fetcher: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.github.com')) {
          return Response.json({
            tag_name: 'v0.3.3',
            assets: [{ name: 'Gravity.exe', size: payload.length, browser_download_url: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.3.3/Gravity.exe' }],
          });
        }
        return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
      }) as unknown as typeof fetch,
    });

    const dl = await updater2.downloadUpdate();
    expect(dl.status).toBe('downloaded');
    expect(dl.downloadedFilePath).toBeTruthy();
    expect(readFileSync(dl.downloadedFilePath!)).toEqual(payload);
    expect(renameFails).toBe(0);

    // 3. Per-chunk stall timeout guard check in github-updater.ts (no rigid 180s total abort killing slow healthy stream)
    const updaterSrc = readFileSync(path.resolve(process.cwd(), 'src/main/updater/github-updater.ts'), 'utf8');
    expect(updaterSrc).not.toContain('180_000');
  });

  it('PLG-09: windows-installer.ts 校验 $targetPid 退出、放宽重试、支持缺失目标时的 File.Move 回滚并清理脚本', () => {
    const scriptText = windowsUpdateScript(12345, 'C:\\App\\Gravity.exe', 'C:\\App\\staged.exe', 'C:\\App\\bak.exe', 'C:\\App\\dl.exe');

    // 1. Must verify $targetPid exited after wait loop (at least 2 Get-Process checks)
    const pidChecks = scriptText.match(/Get-Process\s+-Id\s+\$targetPid/g) || [];
    expect(pidChecks.length).toBeGreaterThanOrEqual(2);

    // 2. Rollback must handle missing $targetExe via Test-Path + [IO.File]::Move fallback
    expect(scriptText).toMatch(/Test-Path/);
    expect(scriptText).toMatch(/\[IO\.File\]::Move/);

    // 3. Widened retry window (> 15 attempts)
    const retryMatch = /\$attempt\s+-lt\s+(\d+)/.exec(scriptText);
    expect(retryMatch).not.toBeNull();
    expect(Number(retryMatch![1])).toBeGreaterThan(15);

    // 4. Real PowerShell execution on Windows: simulate AV deleting $targetExe before Start-Process throws
    if (process.platform === 'win32') {
      const dir = makeTempDir('gravity-v033-plg09-ps-');
      const target = path.join(dir, 'Gravity.exe');
      const stage = path.join(dir, 'staged.exe');
      const backup = path.join(dir, 'backup.exe');
      const download = path.join(dir, 'download.exe');
      const psFile = path.join(dir, 'apply-update.ps1');
      writeFileSync(target, 'old-good-binary');
      writeFileSync(stage, 'new-quarantined-binary');
      writeFileSync(download, 'new-quarantined-binary');

      // First Start-Process simulates AV quarantining/deleting $targetExe then throwing
      writeFileSync(
        psFile,
        '\uFEFF' + [
          '$script:launchCount = 0',
          'function Start-Process { param($FilePath) $script:launchCount++; if ($script:launchCount -eq 1) { Remove-Item -LiteralPath $FilePath -Force; throw "AV quarantined" } }',
          'function Start-Sleep { param($Milliseconds) }',
          windowsUpdateScript(2147483647, target, stage, backup, download),
        ].join('\r\n')
      );

      const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
        windowsHide: true,
        timeout: 10_000,
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(existsSync(target), 'rollback must restore target binary even when quarantined/deleted').toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('old-good-binary');
    }
  });
});

/* ============================================================================
 * PLG-12 & PLG-13: Telemetry & Translator
 * ========================================================================== */

describe('Telemetry & Translator 插件 Bug 回归（PLG-12, PLG-13）', () => {
  it('PLG-12: v1→v2 非 default Profile 先载入保留 default 历史；ensure 重算 pressureLevel；applyContextWindow 清除 estimated', () => {
    const dir = makeTempDir('gravity-v033-plg12-');
    const disk = new ClientStore(dir);
    const now = () => Date.UTC(2026, 10, 25, 12, 0, 0);

    // Seed v1 legacy files (no v2-* files yet)
    const templateStore = new TelemetryStore({ store: new ClientStore(makeTempDir('gravity-v033-plg12-tpl-')), now });
    telemetries.push(templateStore);
    const baseState = templateStore.ensure('legacy-default-sess', 'gemini-4-neon');
    disk.write('session-telemetry.json', {
      states: { 'legacy-default-sess': { ...baseState, usedContextTokens: 45_000 } },
      sessionCounts: {
        'legacy-default-sess': {
          'gemini-4-neon': { inputTokens: 5000, cachedInputTokens: 0, outputTokens: 1000, thinkingTokens: 0 },
        },
      },
      reportedUsed: { 'legacy-default-sess': 45_000 },
      checkpointLimits: {},
      learnedModelLimits: {},
    });

    // Load non-default profile 'work' FIRST -> must NOT erase default's migrated history!
    const workStore = new TelemetryStore({ store: disk, now, profileId: 'work' });
    workStore.flush(true);
    workStore.dispose();

    const defaultStore = new TelemetryStore({ store: disk, now, profileId: 'default' });
    telemetries.push(defaultStore);
    expect(defaultStore.getSessionTelemetry('legacy-default-sess')?.costSummary.inputTokens).toBe(5000);

    // Part B: ensure() recalculates pressureLevel when maxContextTokens grows (96% critical -> 9.6% healthy)
    const pressureStore = new TelemetryStore({
      store: new ClientStore(makeTempDir('gravity-v033-plg12-pressure-')),
      now,
    });
    telemetries.push(pressureStore);
    pressureStore.applyContextWindow('s-press', 96_000, 100_000);
    expect(pressureStore.getSessionTelemetry('s-press')?.pressureLevel).toBe('critical');
    pressureStore.setCheckpointWindowLimit('s-press', 1_000_000, 'gemini-4-neon');
    const updated = pressureStore.ensure('s-press', 'gemini-4-neon');
    expect(updated.pressureLevel).toBe('healthy');

    // Part C: applyContextWindow() clears estimated: true when real measurement arrives
    pressureStore.beginTurn('s-est', 'long prompt');
    pressureStore.applyContextWindow('s-est', 100_000, 256_000);
    pressureStore.beginManualCompaction('s-est');
    pressureStore.applyContextWindow('s-est', 20_000, 256_000);
    pressureStore.finishManualCompaction('s-est');
    const comp = pressureStore.getSessionTelemetry('s-est')?.compactions?.at(-1);
    expect(comp?.estimated).toBeFalsy();
  });

  it('PLG-13: TranslationService 在 dispose() 后完成的外部翻译绝不写入已销毁 TelemetryStore', async () => {
    const dir = makeTempDir('gravity-v033-plg13-');
    let resolveInFlight!: (val: { text: string; latencyMs: number; usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; thinkingTokens: number; totalTokens: number; providerReported: boolean } }) => void;
    let shouldHold = false;

    const core = new CoreService({
      dataDir: dir,
      homeDir: path.join(dir, 'home'),
      enableAutoUpdateCheck: false,
      externalTranslator: async () => {
        if (!shouldHold) {
          return { text: '正在检查配置文件。', latencyMs: 5 };
        }
        return new Promise((resolve) => { resolveInFlight = resolve; });
      },
    });
    services.push(core);

    const probe = await core.testExternalTranslatorConnection({
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5:3b',
      timeoutMs: 5000,
    });
    expect(probe.ok).toBe(true);
    await core.updateTranslationConfig({
      engine: 'external-api',
      externalTranslator: {
        enabled: true,
        provider: 'local-ollama',
        endpoint: 'http://127.0.0.1:11434',
        model: 'qwen2.5:3b',
        timeoutMs: 5000,
      },
    });

    shouldHold = true;
    const translationService = (
      core as unknown as {
        translation: {
          translateThoughtSegment: (text: string, thoughtId: string, signal?: AbortSignal) => Promise<unknown>;
        };
      }
    ).translation;
    // Start an in-flight external translation without a pre-aborted signal so dispose() must guard telemetry recording directly
    const inFlight = translationService.translateThoughtSegment('Inspecting telemetry lifecycle after dispose.', 'th-plg13');
    await vi.waitFor(() => expect(typeof resolveInFlight).toBe('function'));

    const recordSpy = vi.spyOn(core.telemetry, 'recordExternalTranslationUsage');
    await core.dispose();

    resolveInFlight({
      text: '正在检查销毁后的遥测生命周期。',
      latencyMs: 12,
      usage: { inputTokens: 80, cachedInputTokens: 0, outputTokens: 30, thinkingTokens: 0, totalTokens: 110, providerReported: true },
    });
    await inFlight.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(recordSpy).not.toHaveBeenCalled();
  });
});

/* ============================================================================
 * PLG-15 & PLG-16: TitleOrganizer, AccountQuota & macOS Login
 * ========================================================================== */

describe('TitleOrganizer & AccountQuota/Login 插件 Bug 回归（PLG-15, PLG-16）', () => {
  it('PLG-15: 临时标题会话在 session/close 完成前持续保持隐藏（无幽灵遥测），且 renameSession/togglePinSession 校验切号锁', async () => {
    const dir = makeTempDir('gravity-v033-plg15-');
    const client = new AcpClient();
    const initRes = {
      protocolVersion: 1,
      agentInfo: { name: 'Antigravity CLI', version: '1.5.17' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} } },
    };
    client.initializeResult = initRes;
    vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(client, 'start').mockResolvedValue(initRes);
    vi.spyOn(client, 'notify').mockImplementation(() => {});

    const cfgOpts = (model = 'gemini-4-neon', mode = 'default', effort = 'high'): AcpConfigOption[] => [
      { id: 'model', name: 'Model', currentValue: model, options: [{ value: 'gemini-4-neon', name: 'Neon' }, { value: 'gemini-4-hydrogen', name: 'Hydrogen' }] },
      { id: 'mode', name: 'Mode', currentValue: mode, options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
      { id: 'thought_level', name: 'Effort', currentValue: effort, options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    ];

    let seq = 0;
    let tempSessionId = '';
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      const rec = (params || {}) as Record<string, unknown>;
      if (method === 'session/new') {
        const sid = `sess-org-${++seq}`;
        if (seq === 2) tempSessionId = sid;
        return { sessionId: sid, configOptions: cfgOpts() };
      }
      if (method === 'session/set_config_option') {
        return { configOptions: cfgOpts('gemini-4-hydrogen', 'plan', 'medium') };
      }
      if (method === 'session/prompt') {
        const sid = String(rec.sessionId);
        client.emit('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: JSON.stringify([{ sessionId: 'sess-org-1', categoryTag: 'Core', organizedTitle: 'Core｜临时会话测试' }]) },
          },
        });
        return { stopReason: 'end_turn' };
      }
      if (method === 'session/close') {
        // Emit trailing usage_update WHILE session/close is still running!
        await new Promise((r) => setTimeout(r, 25));
        client.emit('session/update', {
          sessionId: String(rec.sessionId),
          update: { sessionUpdate: 'usage_update', usage: { inputTokens: 500, outputTokens: 100 } },
        });
        return {};
      }
      return {};
    });

    const core = new CoreService({ acp: client, dataDir: dir, homeDir: path.join(dir, 'home'), enableAutoUpdateCheck: false });
    services.push(core);

    const userSess = await core.createSession({ cwd: dir, title: '需要整理的会话' });
    await core.organizeTitles({ scope: 'session', sessionIds: [userSess.sessionId] });

    expect(tempSessionId).toBeTruthy();
    expect(core.telemetry.getSessionTelemetry(tempSessionId)).toBeUndefined();

    // Part B: renameSession & togglePinSession must enforce accounts.assertReady()
    vi.spyOn(core.accounts, 'assertReady').mockImplementation(() => {
      throw new Error('正在切换账号 Profile，请稍候');
    });
    await expect(core.renameSession(userSess.sessionId, '新标题')).rejects.toThrow(/切换账号/);
    await expect(core.togglePinSession(userSess.sessionId)).rejects.toThrow(/切换账号/);
  });

  it('PLG-16: Windows read-quota.ps1 子进程秒退返回退出码 1、macos-login 清理失败不覆盖 exit 0、macOS 看门狗不屏蔽 SIGTERM', async () => {
    // 1. Windows read-quota.ps1 exits with code 1 (not 2) when child exits immediately without writing result
    const psScriptPath = path.resolve(process.cwd(), 'assets/quota/read-quota.ps1');
    const psScriptSrc = readFileSync(psScriptPath, 'utf8');
    expect(psScriptSrc).toMatch(/exit\s+1/);

    if (process.platform === 'win32') {
      const dir = makeTempDir('gravity-v033-plg16-win-');
      const resultFile = path.join(dir, 'quota-result.json');
      const started = Date.now();
      const run = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath],
        {
          env: {
            ...process.env,
            GRAVITY_QUOTA_BINARY: process.execPath,
            GRAVITY_QUOTA_COMMAND: `"${process.execPath}" -e "process.exit(1)"`,
            GRAVITY_QUOTA_CWD: dir,
            GRAVITY_QUOTA_RESULT: resultFile,
            GRAVITY_QUOTA_WAIT: '8',
          },
          windowsHide: true,
          timeout: 10_000,
        }
      );
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(Date.now() - started).toBeLessThan(6000);
    }

    // 2. macos-login.ts: cleanup failure in finally MUST NOT mask successful exit 0 login
    const loginTempDir = makeTempDir('gravity-v033-plg16-maclogin-');
    const origRm = fsPromises.rm.bind(fsPromises);
    vi.spyOn(fsPromises, 'rm').mockImplementation(async (targetPath, opts) => {
      if (String(targetPath).includes('gravity-login-')) {
        throw Object.assign(new Error('EACCES: temp dir busy'), { code: 'EACCES' });
      }
      return origRm(targetPath, opts);
    });

    const controller = new AbortController();
    await expect(
      runMacTerminalLogin('/usr/local/bin/agy', ['acp', '--login'], {
        tempDir: loginTempDir,
        signal: controller.signal,
        pollMs: 10,
        startupTimeoutMs: 2000,
        openTerminal: async (scriptPath) => {
          writeFileSync(path.join(path.dirname(scriptPath), 'state'), 'exit 0\n', 'utf8');
        },
      })
    ).resolves.toBeUndefined();

    // 3. macOS read-quota-macos.sh watchdog subshell must NOT trap TERM (causes 500ms sleep on every normal query)
    const macQuotaSh = readFileSync(path.resolve(process.cwd(), 'assets/quota/read-quota-macos.sh'), 'utf8');
    const insidePtySection = macQuotaSh.slice(0, macQuotaSh.indexOf('fi\n') + 3);
    expect(insidePtySection).not.toMatch(/trap\s+''\s+HUP\s+TERM/);
  });
});
