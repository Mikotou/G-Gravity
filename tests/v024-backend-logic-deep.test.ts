// @vitest-environment node
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { ApprovalEngine, DEFAULT_APPROVAL_CONFIG } from '../src/main/approval/approval-engine';
import { canEnforceCurlLimit } from '../src/main/approval/curl-download';
import {
  callIndependentModelWithUsage,
  discoverExternalModels,
  reviewWithIndependentModel,
  validateExternalEndpoint,
  type AiReviewResult,
  type ReviewContext,
  type Reviewer,
} from '../src/main/approval/external-reviewer';
import { approvalWorkspaceKey } from '../src/main/approval/session-grants';
import {
  assessShellHighRiskFloor,
  networkTargetFloor,
  parseShellCommand,
  screenCommand,
} from '../src/main/approval/shell-screening';
import { CoreService } from '../src/main/core-service';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { ConversationTreeStore, summarizeBranchMessages } from '../src/main/session/conversation-tree-store';
import { InspectorStore } from '../src/main/session/inspector-store';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { ClientStore } from '../src/main/storage/client-store';
import { ConversationMessages } from '../src/main/storage/conversation-messages';
import { reviewerCircuit, translatorCircuit } from '../src/main/llm/external-llm-transport';
import {
  testExternalTranslator,
  translateWithExternalModel,
} from '../src/main/translation/external-translator';
import { readAllSessionMessages } from './helpers/core-bridge';
import {
  MAX_PARALLEL_ACTIVE_SESSIONS,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionUpdateNotification,
  type ApprovalGuardActivityEvent,
  type ApprovalReviewingEvent,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ExternalAiReviewerConfig,
  type ExternalTranslatorConfig,
  type PendingApprovalRequest,
} from '../src/shared';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitForCondition<T>(
  probe: () => T | undefined,
  timeoutMs = 2000,
  label = 'condition'
): Promise<T> {
  const immediate = probe();
  if (immediate !== undefined) return Promise.resolve(immediate);
  return new Promise<T>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const value = probe();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
      }
    }, 10);
  });
}

class StubDeepAcpClient extends EventEmitter {
  private handlers = new Map<string, (params: unknown, id: number) => unknown | Promise<unknown>>();
  options: { args?: string[]; cwd?: string } = { args: ['acp'] };
  connected = true;
  binaryPath = 'agy';
  initializeResult = {
    protocolVersion: 1,
    agentInfo: { name: 'stub-deep-acp', version: '0.2.4' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: true, resume: true, close: true },
    },
  };
  private seq = 0;
  newSessionDelayMs = 0;
  promptResolver?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

  registerRequestHandler(method: string, handler: (params: unknown, id: number) => unknown | Promise<unknown>) {
    this.handlers.set(method, handler);
  }
  async start() {
    this.connected = true;
    return this.initializeResult;
  }
  async stop() {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnected', 'ACP 已停止');
  }
  notify(_method: string, _params?: unknown) {
    // No-op stub notification transport
  }
  async request(method: string, params?: Record<string, unknown>) {
    if (method === 'session/new') {
      if (this.newSessionDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.newSessionDelayMs));
      }
      return {
        sessionId: `sess-deep-${++this.seq}`,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        models: {
          currentModelId: 'gemini-4-neon',
          availableModels: [{ modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
        },
      };
    }
    if (method === 'session/resume' || method === 'session/load') {
      return {
        sessionId: String(params?.sessionId || `sess-resumed-${++this.seq}`),
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        models: {
          currentModelId: 'gemini-4-neon',
          availableModels: [{ modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
        },
      };
    }
    if (method === 'session/prompt') {
      if (this.promptResolver) return this.promptResolver(params || {});
      return { stopReason: 'end_turn', usage: { inputTokens: 64, outputTokens: 24, totalTokens: 88 } };
    }
    if (method === 'session/list') {
      return { sessions: [] };
    }
    if (method === 'session/close' || method === 'session/cancel') return {};
    return { ok: true, method, params };
  }
  emitSessionUpdate(notification: AcpSessionUpdateNotification) {
    this.emit('session/update', notification);
  }
  async triggerPermissionRequest(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
    const handler = this.handlers.get('session/request_permission');
    if (!handler) throw new Error('session/request_permission handler not registered');
    return (await handler(params, ++this.seq)) as AcpRequestPermissionResult;
  }
}

const tempDirs: string[] = [];
const engines: ApprovalEngine[] = [];
const services: CoreService[] = [];
const servers: Server[] = [];
const acpClients: AcpClient[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeEngine(config: Partial<ApproveForMeConfig>, reviewer?: Reviewer, now?: () => number): ApprovalEngine {
  const dir = makeTempDir('gravity-v024-deep-eng-');
  const store = new ClientStore(dir);
  const engine = new ApprovalEngine({ store, config, reviewer, now });
  engines.push(engine);
  return engine;
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
    sessionId: overrides.sessionId ?? 'sess-deep-1',
    toolCall: {
      toolCallId: overrides.toolCallId ?? `tc-${Math.random().toString(36).slice(2, 9)}`,
      kind: overrides.kind ?? 'execute',
      title: overrides.title ?? 'run_command',
      rawInput: overrides.rawInput ?? { CommandLine: 'git commit -m "chore: race"' },
      ...(overrides.locations ? { locations: overrides.locations } : {}),
    },
    options: [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
    ],
  };
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
  lastVerifiedAt: '2026-11-23T00:00:00.000Z',
};

async function startLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; baseUrl: string; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return false;
    return true;
  }
}

function forceKillTreeFallback(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already exited
  }
}

afterEach(async () => {
  translatorCircuit.reset();
  reviewerCircuit.reset();
  for (const client of acpClients.splice(0)) {
    await client.stop().catch(() => {});
  }
  for (const s of services.splice(0)) {
    await s.dispose().catch(() => {});
  }
  for (const e of engines.splice(0)) {
    e.dispose();
  }
  for (const srv of servers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
  vi.restoreAllMocks();
});

/* ============================================================================
 * Group 1: Shell Screening & Download Adversarial Bypasses
 * ========================================================================== */
describe('Group 1: Shell Screening & Download Adversarial Bypasses', () => {
  const safeDownloadEnabledConfig: ApproveForMeConfig = {
    ...DEFAULT_APPROVAL_CONFIG,
    mode: 'rules-only',
    enableSafeDownloadAutoApprove: true,
    maxDownloadSizeMB: 50,
  };

  it('1.1) blocks all chained shell, download, redirect, size-overflow & command-substitution bypasses in both rules-only and permissive hybrid modes', async () => {
    const workspace = makeTempDir('gravity-g1-ws-');

    const mustDenyCommands = [
      'git status && rm -rf /',
      "find . -not -path '*/.gemini/*' ; cat ~/.gemini/oauth_creds.json",
      'echo $(cat ~/.gemini/oauth_creds.json)',
      'echo `cat ~/.gemini/oauth_creds.json`',
    ];

    const mustNeverAutoApproveCommands = [
      "rg --glob '!.gemini/**' foo | sh",
      "find . -not -path '*/.gemini/*' -exec rm {} \\;",
      'curl -fsS --max-filesize 1024 https://example.com/a.txt -o ../escape.txt',
      'curl -fsS --max-filesize 1024 --config evil.rc https://example.com/a.txt -o a.txt',
      'curl -fsS --max-filesize 1024 -K evil.rc https://example.com/a.txt -o a.txt',
      'curl -fsSL --max-filesize 1024 https://example.com/a.txt -o a.txt',
      'curl -fsS --max-filesize 1024 http://example.com/a.txt -o a.txt',
      'curl -fsS --max-filesize 60000000 https://example.com/big.bin -o big.bin',
      'echo $(whoami)',
      'echo `whoami`',
    ];

    // Even with a compromised/overly permissive Stage 2 reviewer, none of these may auto-approve
    const permissiveReviewer: Reviewer = vi.fn().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'safe',
      riskScore: 0,
      intentAlignment: 'aligned',
      reason: 'mock compromised reviewer',
      latencyMs: 3,
    });

    const rulesEngine = makeEngine({
      mode: 'rules-only',
      enableSafeDownloadAutoApprove: true,
      maxDownloadSizeMB: 50,
    });
    const hybridEngine = makeEngine(
      {
        mode: 'hybrid',
        enableSafeDownloadAutoApprove: true,
        maxDownloadSizeMB: 50,
        externalReviewer: connectedLocalReviewer,
      },
      permissiveReviewer
    );

    for (const cmd of mustDenyCommands) {
      const screened = screenCommand(cmd, workspace, safeDownloadEnabledConfig);
      expect(screened.verdict, `screenCommand must deny: ${cmd}`).toBe('deny');
      expect(screened.riskLevel, `riskLevel critical: ${cmd}`).toBe('critical');

      const rulesRes = await rulesEngine.requestPermission(makePerm({ rawInput: { CommandLine: cmd } }), workspace);
      expect(rulesRes, `rules-only must reject: ${cmd}`).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });

      const hybridRes = await hybridEngine.requestPermission(makePerm({ rawInput: { CommandLine: cmd } }), workspace);
      expect(hybridRes, `hybrid must hard-deny without calling Stage 2: ${cmd}`).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
    }
    expect(permissiveReviewer).not.toHaveBeenCalled();

    for (const cmd of mustNeverAutoApproveCommands) {
      const screened = screenCommand(cmd, workspace, safeDownloadEnabledConfig);
      expect(screened.verdict, `screenCommand must NOT auto_approve: ${cmd}`).not.toBe('auto_approve');
      expect(['force_ask', 'deny'], `screenCommand verdict for ${cmd}`).toContain(screened.verdict);

      if (screened.verdict === 'deny') {
        expect(
          await rulesEngine.requestPermission(makePerm({ sessionId: 'sess-g1-rules', rawInput: { CommandLine: cmd } }), workspace),
          `rules-only must deny: ${cmd}`
        ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
        expect(
          await hybridEngine.requestPermission(makePerm({ sessionId: 'sess-g1-hybrid', rawInput: { CommandLine: cmd } }), workspace),
          `hybrid must deny: ${cmd}`
        ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
        continue;
      }

      // Verify rules-only escalates to human prompt (never auto-approves)
      let rulesCard: PendingApprovalRequest | undefined;
      const onRulesReq = (card: PendingApprovalRequest) => {
        rulesCard = card;
      };
      rulesEngine.once('requested', onRulesReq);
      const rulesPerm = rulesEngine.requestPermission(
        makePerm({ sessionId: 'sess-g1-rules', rawInput: { CommandLine: cmd } }),
        workspace
      );
      const rulesOutcome = await Promise.race([
        waitForCondition(() => rulesCard, 1000, `rules requested for ${cmd}`).then(() => 'prompted' as const),
        rulesPerm.then((r) => `settled:${JSON.stringify(r)}`),
      ]);
      rulesEngine.off('requested', onRulesReq);
      expect(rulesOutcome, `rules-only must prompt instead of auto-approving: ${cmd}`).toBe('prompted');
      expect(rulesCard?.commandPrefix, `must not offer reusable prefix: ${cmd}`).toBeUndefined();
      rulesEngine.cancelSession('sess-g1-rules');
      expect((await rulesPerm).outcome.outcome).toBe('cancelled');

      // Verify hybrid with misaligned/medium+ Stage 2 STILL escalates to Stage 3
      const misalignedReviewer: Reviewer = vi.fn().mockResolvedValue({
        recommended: 'approve',
        riskLevel: 'high',
        riskScore: 72,
        intentAlignment: 'misaligned',
        reason: 'adversarial bypass does not match user intent',
        latencyMs: 5,
      });
      const guardHybrid = makeEngine(
        {
          mode: 'hybrid',
          enableSafeDownloadAutoApprove: true,
          maxDownloadSizeMB: 50,
          externalReviewer: connectedLocalReviewer,
        },
        misalignedReviewer
      );
      let hybridCard: PendingApprovalRequest | undefined;
      const onHybridReq = (card: PendingApprovalRequest) => {
        hybridCard = card;
      };
      guardHybrid.once('requested', onHybridReq);
      const hybridPerm = guardHybrid.requestPermission(
        makePerm({ sessionId: 'sess-g1-hybrid', rawInput: { CommandLine: cmd } }),
        workspace
      );
      const hybridOutcome = await Promise.race([
        waitForCondition(() => hybridCard, 1000, `hybrid requested for ${cmd}`).then(() => 'prompted' as const),
        hybridPerm.then((r) => `settled:${JSON.stringify(r)}`),
      ]);
      guardHybrid.off('requested', onHybridReq);
      expect(hybridOutcome, `hybrid must escalate misaligned high-risk bypass: ${cmd}`).toBe('prompted');
      expect(hybridCard?.aiSuggestion?.recommended, `misaligned high-risk must override Stage 2 approve: ${cmd}`).toBe('ask');
      guardHybrid.cancelSession('sess-g1-hybrid');
      expect((await hybridPerm).outcome.outcome).toBe('cancelled');
    }
  });

  it('1.2) enforces Decision D2 hard-deny + workspace ./scratch/ guidance when writing to ~/.gemini/antigravity-cli/brain/s1/scratch/out.md', async () => {
    const workspace = makeTempDir('gravity-g1-d2-');
    const engine = makeEngine({ mode: 'rules-only' });

    // Tool call write_file
    const toolRes = await engine.requestPermission(
      makePerm({
        kind: 'edit',
        title: 'write_file',
        rawInput: {
          Path: '~/.gemini/antigravity-cli/brain/s1/scratch/out.md',
          Content: 'scratch output',
        },
      }),
      workspace
    );
    expect(toolRes).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    const toolAudit = engine.listAudit()[0];
    expect(toolAudit.verdict).toBe('denied');
    expect(toolAudit.reason).toContain('./scratch/');

    // Shell redirection write
    const shellCmd = 'echo hello > ~/.gemini/antigravity-cli/brain/s1/scratch/out.md';
    const shellScreen = screenCommand(shellCmd, workspace, engine.getConfig());
    expect(shellScreen.verdict).toBe('deny');
    expect(shellScreen.explanation.risk).toContain('./scratch/');

    const shellRes = await engine.requestPermission(makePerm({ rawInput: { CommandLine: shellCmd } }), workspace);
    expect(shellRes).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
  });

  it('1.3) blocks workspace-local curl hijack, existing-file overwrite, hidden dotfiles, and reserved Windows device outputs', () => {
    const workspace = makeTempDir('gravity-g1-curl-hijack-');

    // Existing file overwrite must be blocked
    writeFileSync(path.join(workspace, 'existing.json'), '{"old":true}');
    const overwrite = screenCommand(
      'curl -fsS --max-filesize 1048576 https://example.com/data.json -o existing.json',
      workspace,
      safeDownloadEnabledConfig
    );
    expect(overwrite.verdict).not.toBe('auto_approve');

    // Hidden dotfile / .git / reserved device names / private IP targets must be blocked
    for (const cmd of [
      'curl -fsS --max-filesize 1024 https://example.com/a -o .npmrc',
      'curl -fsS --max-filesize 1024 https://example.com/a -o .git/hooks/pre-commit',
      'curl -fsS --max-filesize 1024 https://example.com/a -o CON',
      'curl -fsS --max-filesize 1024 https://169.254.169.254/latest/meta-data -o meta.txt',
      'curl -fsS --max-filesize 1024 https://[::ffff:127.0.0.1]/secret -o secret.txt',
    ]) {
      expect(screenCommand(cmd, workspace, safeDownloadEnabledConfig).verdict, cmd).not.toBe('auto_approve');
    }

    // Planting a rogue curl.bat inside the workspace must prevent Windows curl auto-approval
    writeFileSync(path.join(workspace, 'curl.bat'), '@echo off\r\necho hijacked\r\n');
    expect(
      canEnforceCurlLimit('curl', ['-fsS', '--max-filesize', '1048576', 'https://example.com/data.json', '-o', 'fresh.json'], workspace, workspace)
    ).toBe(false);
    const hijacked = screenCommand(
      'curl -fsS --max-filesize 1048576 https://example.com/data.json -o fresh.json',
      workspace,
      safeDownloadEnabledConfig
    );
    expect(hijacked.verdict).not.toBe('auto_approve');
  });

  it('1.4) allows legitimate read-only searches and bounded safe HTTPS downloads when enabled', async () => {
    const workspace = makeTempDir('gravity-g1-legit-');
    const engine = makeEngine({
      mode: 'rules-only',
      enableSafeDownloadAutoApprove: true,
      maxDownloadSizeMB: 50,
    });

    const legitimateCommands = [
      'find . -maxdepth 3 -name "*.ts" -not -path "*/.gemini/*" | head -n 20',
      "rg --glob '!.gemini/**' pattern | wc -l",
      'Get-ChildItem -Exclude .gemini',
      'curl -fsS --max-filesize 1048576 https://example.com/data.json -o data.json',
    ];

    for (const cmd of legitimateCommands) {
      const screened = screenCommand(cmd, workspace, engine.getConfig());
      expect(screened.verdict, `legitimate command must auto_approve: ${cmd}`).toBe('auto_approve');
      const res = await engine.requestPermission(makePerm({ rawInput: { CommandLine: cmd } }), workspace);
      expect(res, `engine must auto-allow: ${cmd}`).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
    }
  });

  it('1.5) [RED-TEAM PROBE] sort -o / --output and find -fprint0 file-writing flags must NEVER auto-approve', async () => {
    const workspace = makeTempDir('gravity-g1-sort-find-');
    const engine = makeEngine({ mode: 'rules-only' });

    const mutatingFilterBypassCases = [
      'sort -o overwritten.txt README.md',
      'sort --output=overwritten.txt README.md',
      'find . -fprint0 leaked-list.txt',
    ];

    for (const cmd of mutatingFilterBypassCases) {
      const screened = screenCommand(cmd, workspace, engine.getConfig());
      expect.soft(
        screened.verdict,
        `file-writing flag must NEVER return auto_approve from screenCommand: ${cmd}`
      ).not.toBe('auto_approve');

      let prompted = false;
      const onReq = () => {
        prompted = true;
      };
      engine.once('requested', onReq);
      const perm = engine.requestPermission(makePerm({ sessionId: 'sess-g1-sort', rawInput: { CommandLine: cmd } }), workspace);
      const outcome = await Promise.race([
        waitForCondition(() => (prompted ? true : undefined), 500, `prompt for ${cmd}`).then(() => 'prompted' as const),
        perm.then((res) => `auto-settled:${JSON.stringify(res)}`),
      ]);
      engine.off('requested', onReq);
      if (outcome === 'prompted') {
        engine.cancelSession('sess-g1-sort');
        await perm;
      }
      expect.soft(outcome, `ApprovalEngine must prompt human instead of auto-approving: ${cmd}`).toBe('prompted');
    }
  });

  it('1.6) [RED-TEAM PROBE] double-quoted command substitution ("$(...)" / "`...`") flags local hardFloor and blocks in rules-only & misaligned hybrid', async () => {
    const workspace = makeTempDir('gravity-g1-dquote-sub-');
    const rulesEngine = makeEngine({ mode: 'rules-only' });
    const misalignedReviewer: Reviewer = vi.fn().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'medium',
      riskScore: 45,
      intentAlignment: 'misaligned',
      reason: 'unexpected command substitution',
      latencyMs: 5,
    });
    const hybridEngine = makeEngine(
      { mode: 'hybrid', externalReviewer: connectedLocalReviewer },
      misalignedReviewer
    );

    const doubleQuotedSubstitutions = ['echo "$(whoami)"', 'echo "`whoami`"'];
    for (const cmd of doubleQuotedSubstitutions) {
      const floor = assessShellHighRiskFloor(cmd, parseShellCommand(cmd));
      expect.soft(floor.hardFloor, `assessShellHighRiskFloor must flag double-quoted substitution: ${cmd}`).toBe(true);

      // Without AI (rules-only), command substitution strictly escalates to human
      let rulesEscalated = false;
      rulesEngine.once('requested', () => { rulesEscalated = true; });
      const rulesPerm = rulesEngine.requestPermission(
        makePerm({ sessionId: 'sess-g1-dquote-rules', rawInput: { CommandLine: cmd } }),
        workspace
      );
      await waitForCondition(() => (rulesEscalated ? true : undefined), 500, `rules escalation for ${cmd}`);
      rulesEngine.cancelSession('sess-g1-dquote-rules');
      await rulesPerm;

      let escalated = false;
      const onReq = () => {
        escalated = true;
      };
      hybridEngine.once('requested', onReq);
      const perm = hybridEngine.requestPermission(
        makePerm({ sessionId: 'sess-g1-dquote', rawInput: { CommandLine: cmd } }),
        workspace
      );
      const outcome = await Promise.race([
        waitForCondition(() => (escalated ? true : undefined), 500, `escalation for ${cmd}`).then(() => 'escalated-to-human' as const),
        perm.then((res) => `auto-approved-by-stage2:${JSON.stringify(res)}`),
      ]);
      hybridEngine.off('requested', onReq);
      if (outcome === 'escalated-to-human') {
        hybridEngine.cancelSession('sess-g1-dquote');
        await perm;
      }
      expect.soft(outcome, `misaligned double-quoted command substitution must NOT auto-approve via Stage 2: ${cmd}`).toBe(
        'escalated-to-human'
      );
    }
  });

  it('1.7) [RED-TEAM PROBE] networkTargetFloor and fetch_url must block bracketed IPv6 local/mapped and CGNAT SSRF targets', async () => {
    const workspace = makeTempDir('gravity-g1-ssrf-tool-');
    const engine = makeEngine({ mode: 'rules-only' });

    const ssrfUrls = [
      'https://[::ffff:127.0.0.1]/admin',
      'https://[fe80::1]/metadata',
      'https://[fc00::1]/internal',
      'https://[fd12:3456::1]/secret',
      'https://100.64.0.1/status',
    ];

    for (const url of ssrfUrls) {
      expect.soft(networkTargetFloor({ url }) !== 'standard', `networkTargetFloor must reject ${url}`).toBe(true);

      let prompted = false;
      const onReq = () => {
        prompted = true;
      };
      engine.once('requested', onReq);
      const perm = engine.requestPermission(
        makePerm({
          sessionId: 'sess-g1-ssrf',
          kind: 'fetch',
          title: 'fetch_url',
          rawInput: { url },
        }),
        workspace
      );
      const outcome = await Promise.race([
        waitForCondition(() => (prompted ? true : undefined), 500, `prompt for ${url}`).then(() => 'prompted' as const),
        perm.then((res) => `auto-approved:${JSON.stringify(res)}`),
      ]);
      engine.off('requested', onReq);
      if (outcome === 'prompted') {
        engine.cancelSession('sess-g1-ssrf');
        await perm;
      }
      expect.soft(outcome, `fetch_url must NOT auto-approve SSRF URL ${url}`).toBe('prompted');
    }
  });
});

/* ============================================================================
 * Group 2: ApprovalEngine Concurrency & Race Conditions
 * ========================================================================== */
describe('Group 2: ApprovalEngine Concurrency & Race Conditions', () => {
  it('Race 1: cancelStage2Review racing with Stage 2 response settles ACP permission EXACTLY ONCE via Stage 3 human decision with zero pending leak', async () => {
    const cwd = makeTempDir('gravity-g2-race1-');

    // Run both same-tick race orderings:
    // (A) cancelStage2Review() THEN resolveReviewer() on same tick
    // (B) resolveReviewer() THEN cancelStage2Review() on same tick (before microtasks flush)
    for (const order of ['cancel-then-resolve', 'resolve-then-cancel'] as const) {
      const reviewDeferred = createDeferred<AiReviewResult>();
      const reviewer: Reviewer = vi.fn().mockImplementation(() => reviewDeferred.promise);
      const engine = makeEngine({ mode: 'hybrid', externalReviewer: connectedLocalReviewer }, reviewer);

      const reviewEvents: ApprovalReviewingEvent[] = [];
      engine.on('approval-reviewing', (ev: ApprovalReviewingEvent) => reviewEvents.push(ev));
      const requestedCards: PendingApprovalRequest[] = [];
      engine.on('requested', (card: PendingApprovalRequest) => requestedCards.push(card));

      let settledCount = 0;
      let settledValue: AcpRequestPermissionResult | undefined;
      const permPromise = engine
        .requestPermission(makePerm({ sessionId: `sess-r1-${order}`, rawInput: { CommandLine: 'git commit -m "race1"' } }), cwd)
        .then((res) => {
          settledCount += 1;
          settledValue = res;
          return res;
        });

      const started = await waitForCondition(
        () => reviewEvents.find((ev) => ev.status === 'reviewing'),
        1000,
        `reviewing event (${order})`
      );

      const approvePayload: AiReviewResult = {
        recommended: 'approve',
        riskLevel: 'safe',
        riskScore: 5,
        intentAlignment: 'aligned',
        reason: 'raced stage2 approval',
        latencyMs: 8,
      };

      let cancelRes: { cancelled: boolean };
      if (order === 'cancel-then-resolve') {
        cancelRes = engine.cancelStage2Review(started.requestId);
        reviewDeferred.resolve(approvePayload);
      } else {
        reviewDeferred.resolve(approvePayload);
        cancelRes = engine.cancelStage2Review(started.requestId);
      }
      expect(cancelRes.cancelled).toBe(true);

      // Flush microtasks + macrotask to verify the raced Stage 2 resolve did NOT auto-settle the promise
      await new Promise((r) => setTimeout(r, 30));
      expect(settledCount, `Stage 2 race must not auto-settle (${order})`).toBe(0);
      expect(requestedCards.filter((c) => c.requestId === started.requestId)).toHaveLength(1);
      expect(engine.listPending()).toHaveLength(1);
      expect(engine.listAwaitingUser()).toHaveLength(1);

      // Now settle via Stage 3 human decision (reject_with_feedback to distinguish clearly from Stage 2 approve)
      const humanDecision = await engine.submitDecision({
        requestId: started.requestId,
        sessionId: started.sessionId,
        decision: 'reject_with_feedback',
        feedbackText: 'Human took over from Stage 2',
      });
      expect(humanDecision.outcome).toBe('rejected');
      await permPromise;

      await new Promise((r) => setTimeout(r, 20));
      expect(settledCount).toBe(1);
      expect(settledValue).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
      expect(engine.listPending()).toHaveLength(0);
      expect(engine.listAwaitingUser()).toHaveLength(0);
      expect(reviewEvents.filter((e) => e.status === 'resolved')).toHaveLength(0);
    }
  });

  it('Race 2: Mode downgrade from hybrid to manual mid-Stage-2 prevents auto-approval and escalates to Stage 3', async () => {
    const dataDir = makeTempDir('gravity-g2-race2-');
    const acp = new StubDeepAcpClient();
    const inFlightReview = createDeferred<AiReviewResult>();
    let callNum = 0;

    const reviewer: Reviewer = vi.fn().mockImplementation(async () => {
      callNum += 1;
      if (callNum === 1) {
        return { recommended: 'approve', riskLevel: 'low', reason: 'probe ok', latencyMs: 4 };
      }
      return inFlightReview.promise;
    });

    const core = new CoreService({
      dataDir,
      acp: acp as never,
      reviewer,
      enableAutoUpdateCheck: false,
    });
    services.push(core);

    expect((await core.testExternalReviewerConnection(connectedLocalReviewer)).ok).toBe(true);
    await core.updateApprovalConfig({ mode: 'hybrid', externalReviewer: connectedLocalReviewer });

    const session = await core.createSession({ cwd: dataDir, title: 'Race 2 Session' });

    const reviewEvents: ApprovalReviewingEvent[] = [];
    core.on('approval-reviewing', (ev: ApprovalReviewingEvent) => reviewEvents.push(ev));
    const requestedCards: PendingApprovalRequest[] = [];
    core.on('approval-requested', (card: PendingApprovalRequest) => requestedCards.push(card));

    let settled = false;
    const permPromise = acp
      .triggerPermissionRequest(
        makePerm({ sessionId: session.sessionId, toolCallId: 'tc-race2', rawInput: { CommandLine: 'git commit -m "mid-flight"' } })
      )
      .then((res) => {
        settled = true;
        return res;
      });

    await waitForCondition(
      () => reviewEvents.find((ev) => ev.status === 'reviewing'),
      1000,
      'Stage 2 reviewing start'
    );

    // Downgrade mode to manual while HTTP review is in-flight
    const updatedCfg = await core.updateApprovalConfig({ mode: 'manual' });
    expect(updatedCfg.mode).toBe('manual');

    // Now resolve Stage 2 with a clean approve verdict
    inFlightReview.resolve({
      recommended: 'approve',
      riskLevel: 'safe',
      riskScore: 2,
      intentAlignment: 'aligned',
      reason: 'looks safe',
      latencyMs: 12,
    });

    const escalatedCard = await waitForCondition(
      () => requestedCards.find((c) => c.toolCallId === 'tc-race2'),
      1000,
      'Stage 3 escalation card after mode downgrade'
    );
    expect(settled).toBe(false);
    expect(escalatedCard.aiSuggestion).toBeUndefined();
    expect(escalatedCard.explanation.risk).toContain('审批配置已变更');

    // Human completes Stage 3 decision
    await core.submitApprovalDecision({
      requestId: escalatedCard.requestId,
      sessionId: session.sessionId,
      decision: 'allow_once',
    });
    expect(await permPromise).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(core.approval.listPending()).toHaveLength(0);
  });

  it('Race 3: Session cancel and close mid-Stage-2 cleanly abort AbortSignal, resolve cancelled, and leave zero dangling requests or unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const dataDir = makeTempDir('gravity-g2-race3-');
      const acp = new StubDeepAcpClient();
      const signals: AbortSignal[] = [];
      let callIndex = 0;

      const reviewer: Reviewer = vi.fn().mockImplementation((_cmd, _cwd, _cfg, ctx?: ReviewContext) => {
        callIndex += 1;
        if (callIndex === 1) {
          return Promise.resolve({ recommended: 'approve', riskLevel: 'low', reason: 'probe ok', latencyMs: 3 });
        }
        if (ctx?.signal) signals.push(ctx.signal);
        return new Promise<AiReviewResult>((_resolve, reject) => {
          ctx?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted by session cancel/close', 'AbortError')),
            { once: true }
          );
        });
      });

      const core = new CoreService({
        dataDir,
        acp: acp as never,
        reviewer,
        enableAutoUpdateCheck: false,
      });
      services.push(core);

      expect((await core.testExternalReviewerConnection(connectedLocalReviewer)).ok).toBe(true);
      await core.updateApprovalConfig({ mode: 'hybrid', externalReviewer: connectedLocalReviewer });

      const sessionA = await core.createSession({ cwd: dataDir, title: 'Race 3 Cancel' });
      const sessionB = await core.createSession({ cwd: dataDir, title: 'Race 3 Close' });

      const reviewEvents: ApprovalReviewingEvent[] = [];
      core.on('approval-reviewing', (ev: ApprovalReviewingEvent) => reviewEvents.push(ev));

      // 3A: Cancel prompt mid-Stage-2
      const permA = acp.triggerPermissionRequest(
        makePerm({ sessionId: sessionA.sessionId, toolCallId: 'tc-r3-cancel', rawInput: { CommandLine: 'git commit -m "cancel"' } })
      );
      await waitForCondition(() => reviewEvents.find((e) => e.toolCallId === 'tc-r3-cancel' && e.status === 'reviewing'));
      await core.cancelPrompt(sessionA.sessionId);

      expect(await permA).toEqual({ outcome: { outcome: 'cancelled' } });
      expect(signals[0]?.aborted).toBe(true);
      expect(core.approval.listPending().filter((p) => p.sessionId === sessionA.sessionId)).toHaveLength(0);

      // 3B: Close session mid-Stage-2
      const permB = acp.triggerPermissionRequest(
        makePerm({ sessionId: sessionB.sessionId, toolCallId: 'tc-r3-close', rawInput: { CommandLine: 'git commit -m "close"' } })
      );
      await waitForCondition(() => reviewEvents.find((e) => e.toolCallId === 'tc-r3-close' && e.status === 'reviewing'));
      await core.closeSession(sessionB.sessionId);

      expect(await permB).toEqual({ outcome: { outcome: 'cancelled' } });
      expect(signals[1]?.aborted).toBe(true);
      expect(core.approval.listPending()).toHaveLength(0);

      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('Race 4: Burst Guard Storm across multiple concurrent sessions emits accurate guard-activity events and clears cleanly when drained', async () => {
    const cwd = makeTempDir('gravity-g2-race4-');
    const fastApproveReviewer: Reviewer = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return {
        recommended: 'approve',
        riskLevel: 'low',
        riskScore: 10,
        intentAlignment: 'aligned',
        reason: 'burst approved',
        latencyMs: 15,
      };
    });

    const engine = makeEngine(
      { mode: 'hybrid', externalReviewer: connectedLocalReviewer },
      fastApproveReviewer
    );

    const guardEvents: ApprovalGuardActivityEvent[] = [];
    engine.on('guard-activity', (ev: ApprovalGuardActivityEvent) => guardEvents.push(ev));

    // Fire 4 concurrent requests on each of 3 separate sessions (12 total)
    const sessionIds = ['sess-storm-1', 'sess-storm-2', 'sess-storm-3'];
    const allPerms = sessionIds.flatMap((sessionId) =>
      Array.from({ length: 4 }, (_, idx) =>
        engine.requestPermission(
          makePerm({
            sessionId,
            toolCallId: `tc-${sessionId}-${idx}`,
            rawInput: { CommandLine: `git commit -m "storm-${idx}"` },
          }),
          cwd
        )
      )
    );

    const results = await Promise.all(allPerms);
    for (const r of results) {
      expect(r).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    }
    expect(engine.listPending()).toHaveLength(0);

    // Every session hit BURST_THRESHOLD (>= 2) and must have emitted exactly one 'burst-guard-enabled'
    for (const sid of sessionIds) {
      const enabled = guardEvents.filter((e) => e.sessionId === sid && e.kind === 'burst-guard-enabled');
      expect(enabled, `single burst-guard-enabled for ${sid}`).toHaveLength(1);
      expect(enabled[0].activeCount).toBeGreaterThanOrEqual(2);
    }

    // Drain session 1 via explicit reset, session 2 via short proactive timer expiry, session 3 via cancelSession
    engine.resetTurnBurstCounter('sess-storm-1');
    engine.resetTurnBurstCounter('sess-storm-1'); // idempotent: no duplicate cleared event
    expect(guardEvents.filter((e) => e.sessionId === 'sess-storm-1' && e.kind === 'burst-guard-cleared')).toHaveLength(1);
    expect(guardEvents.filter((e) => e.sessionId === 'sess-storm-2' && e.kind === 'burst-guard-cleared')).toHaveLength(0);

    // Shorten session 2 burst timer expiry via dispose-free cancel/reset check + test auto-timer drain on a fresh session
    engine.cancelSession('sess-storm-2');
    engine.cancelSession('sess-storm-3');
    for (const sid of sessionIds) {
      const cleared = guardEvents.filter((e) => e.sessionId === sid && e.kind === 'burst-guard-cleared');
      expect(cleared, `single burst-guard-cleared for ${sid}`).toHaveLength(1);
      expect(cleared[0].activeCount).toBe(0);
    }

    // Verify timer-driven automatic drain emits enabled -> cleared without manual reset
    engine.enableBurstGuard('sess-storm-timer', 40);
    expect(guardEvents.filter((e) => e.sessionId === 'sess-storm-timer' && e.kind === 'burst-guard-enabled')).toHaveLength(1);
    await waitForCondition(
      () => guardEvents.find((e) => e.sessionId === 'sess-storm-timer' && e.kind === 'burst-guard-cleared'),
      1000,
      'auto timer burst-guard-cleared'
    );
  });

  it('Race 5: SessionGrants survive CoreService restart, respect Windows case-insensitivity, and support selective prefix vs delegation revocation', async () => {
    const dataDir = makeTempDir('gravity-g2-race5-');
    const upperWinCwd = 'C:\\Proj\\App';
    const lowerWinCwd = 'c:\\proj\\app';
    expect(approvalWorkspaceKey(upperWinCwd)).toBe(approvalWorkspaceKey(lowerWinCwd));

    // Boot 1: Grant 'npm test', 'git diff', and enable Guardian delegation on C:\Proj\App
    const acp1 = new StubDeepAcpClient();
    const core1 = new CoreService({ dataDir, acp: acp1 as never, enableAutoUpdateCheck: false });
    services.push(core1);
    await core1.updateApprovalConfig({ mode: 'manual', fastPassLowRiskDev: false });

    const session = await core1.createSession({ cwd: upperWinCwd, title: 'Grants Restart Test' });

    // 1) Grant prefix 'npm test'
    const ev1 = once(core1, 'approval-requested');
    const p1 = acp1.triggerPermissionRequest(
      makePerm({ sessionId: session.sessionId, toolCallId: 'tc-npm', rawInput: { CommandLine: 'npm test' } })
    );
    const [c1] = (await ev1) as [PendingApprovalRequest];
    expect(c1.commandPrefix).toBe('npm test');
    await core1.submitApprovalDecision({
      requestId: c1.requestId,
      sessionId: session.sessionId,
      decision: 'allow_session_prefix',
      allowedPrefix: 'npm test',
    });
    expect(await p1).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    // 2) Grant prefix 'git diff'
    const ev2 = once(core1, 'approval-requested');
    const p2 = acp1.triggerPermissionRequest(
      makePerm({ sessionId: session.sessionId, toolCallId: 'tc-diff', rawInput: { CommandLine: 'git diff HEAD~1' } })
    );
    const [c2] = (await ev2) as [PendingApprovalRequest];
    expect(c2.commandPrefix).toBe('git diff');
    await core1.submitApprovalDecision({
      requestId: c2.requestId,
      sessionId: session.sessionId,
      decision: 'allow_session_prefix',
      allowedPrefix: 'git diff',
    });
    expect(await p2).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    // 3) Enable session delegation (option 3)
    const ev3 = once(core1, 'approval-requested');
    const p3 = acp1.triggerPermissionRequest(
      makePerm({ sessionId: session.sessionId, toolCallId: 'tc-del', rawInput: { CommandLine: 'cargo test' } })
    );
    const [c3] = (await ev3) as [PendingApprovalRequest];
    await core1.submitApprovalDecision({
      requestId: c3.requestId,
      sessionId: session.sessionId,
      decision: 'approve_for_me_ai',
    });
    expect(await p3).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    await core1.dispose();
    services.pop();

    // Boot 2: Fresh CoreService on the same dataDir
    const acp2 = new StubDeepAcpClient();
    const core2 = new CoreService({ dataDir, acp: acp2 as never, enableAutoUpdateCheck: false });
    services.push(core2);

    // Must recover both prefixes + delegation immediately from persisted state
    const recoveredSnap = await core2.listSessionApprovalGrants(session.sessionId);
    expect(recoveredSnap.delegatedToGuardian).toBe(true);
    expect(recoveredSnap.prefixes.map((p) => p.prefix).sort()).toEqual(['git diff', 'npm test']);

    // Resume the session using lowercase Windows path c:\proj\app (normalized drive letter keeps lowercase \proj\app)
    await core2.resumeSession(session.sessionId, lowerWinCwd);
    expect(core2.sessions.get(session.sessionId).cwd).toBe('C:\\proj\\app');

    // Revoke ONLY 'npm test'
    const afterRevokeNpm = await core2.revokeSessionApprovalGrant({
      sessionId: session.sessionId,
      prefix: 'npm test',
    });
    expect(afterRevokeNpm.prefixes.map((p) => p.prefix)).toEqual(['git diff']);
    expect(afterRevokeNpm.delegatedToGuardian).toBe(true);

    // 'git diff' must STILL auto-approve via session-prefix on both resumed C:\proj\app and raw lowercase c:\proj\app
    const diffRes = await acp2.triggerPermissionRequest(
      makePerm({ sessionId: session.sessionId, toolCallId: 'tc-diff-hit', rawInput: { CommandLine: 'git diff --stat' } })
    );
    expect(diffRes).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect((await core2.listApprovalAudit(5))[0].decisionSource).toBe('session-prefix');

    const rawLowerCaseHit = await core2.approval.requestPermission(
      makePerm({ sessionId: session.sessionId, toolCallId: 'tc-diff-raw-lower', rawInput: { CommandLine: 'git diff --name-only' } }),
      lowerWinCwd
    );
    expect(rawLowerCaseHit).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect((await core2.listApprovalAudit(5))[0].decisionSource).toBe('session-prefix');

    // 'npm test' must prompt again (NOT auto-approve)
    const npmPromptEv = once(core2, 'approval-requested');
    const npmPerm = acp2.triggerPermissionRequest(
      makePerm({ sessionId: session.sessionId, toolCallId: 'tc-npm-again', rawInput: { CommandLine: 'npm test -- --run' } })
    );
    const [npmCard] = (await npmPromptEv) as [PendingApprovalRequest];
    expect(npmCard.commandPrefix).toBe('npm test');
    await core2.submitApprovalDecision({
      requestId: npmCard.requestId,
      sessionId: session.sessionId,
      decision: 'allow_once',
    });
    expect(await npmPerm).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    // Revoke ONLY delegation -> delegatedToGuardian === false while 'git diff' stays intact and still auto-approves in manual mode
    const afterRevokeDel = await core2.revokeSessionApprovalGrant({
      sessionId: session.sessionId,
      revokeDelegation: true,
    });
    expect(afterRevokeDel.delegatedToGuardian).toBe(false);
    expect(afterRevokeDel.prefixes.map((p) => p.prefix)).toEqual(['git diff']);

    const diffAfterDelRevoke = await acp2.triggerPermissionRequest(
      makePerm({ sessionId: session.sessionId, toolCallId: 'tc-diff-after', rawInput: { CommandLine: 'git diff src/' } })
    );
    expect(diffAfterDelRevoke).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect((await core2.listApprovalAudit(5))[0].decisionSource).toBe('session-prefix');
  });
});

/* ============================================================================
 * Group 3: External Reviewer & Translator D3 Security & Fault-Tolerance
 * ========================================================================== */
describe('Group 3: External Reviewer & Translator D3 Security & Fault-Tolerance', () => {
  it('3.1) HTTP 302 Redirect Trap: real loopback 302 is rejected by BOTH reviewer and translator (redirect: error enforced)', async () => {
    let targetHits = 0;
    const { baseUrl } = await startLoopbackServer((req, res) => {
      if (req.url === '/redirect-target') {
        targetHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'should never reach' } }] }));
        return;
      }
      res.writeHead(302, { Location: `${baseUrl}/redirect-target` });
      res.end();
    });

    const reviewerCfg: ExternalAiReviewerConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `${baseUrl}/api/v1`,
      model: 'gpt-6.2-astra',
      apiKey: 'sk-test-redirect-key',
      timeoutMs: 3000,
    };
    const translatorCfg: ExternalTranslatorConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `${baseUrl}/api/v1`,
      model: 'gpt-6.2-astra',
      apiKey: 'sk-test-redirect-key',
      timeoutMs: 3000,
    };

    await expect(callIndependentModelWithUsage(reviewerCfg, 'sys', 'input')).rejects.toThrow();
    await expect(reviewWithIndependentModel('git status', '.', reviewerCfg)).rejects.toThrow();
    await expect(discoverExternalModels({ provider: 'openai-compatible', endpoint: `${baseUrl}/api/v1`, apiKey: 'sk-test-redirect-key' })).rejects.toThrow();
    await expect(translateWithExternalModel('Checking the configuration file.', translatorCfg, fetch, undefined, { skipCircuitCheck: true })).rejects.toThrow();
    expect(targetHits).toBe(0);
  });

  it('3.2) Oversized Response Trap: >300KB streaming body rejects cleanly without hang/OOM on both reviewer & translator and fails closed in ApprovalEngine', async () => {
    const { baseUrl } = await startLoopbackServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'A'.repeat(16 * 1024);
      let written = 0;
      const sendNext = () => {
        if (res.destroyed || res.writableEnded) return;
        while (written < 360 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', sendNext);
            return;
          }
        }
        res.end();
      };
      sendNext();
    });

    const reviewerCfg: ExternalAiReviewerConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `${baseUrl}/api/v1`,
      model: 'gpt-6.2-astra',
      apiKey: 'sk-test-oversize',
      timeoutMs: 4000,
      connectionStatus: 'connected',
      verificationMethod: 'review-call',
      lastVerifiedAt: '2026-11-23T00:00:00.000Z',
    };
    const translatorCfg: ExternalTranslatorConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `${baseUrl}/api/v1`,
      model: 'gpt-6.2-astra',
      apiKey: 'sk-test-oversize',
      timeoutMs: 4000,
    };

    await expect(reviewWithIndependentModel('git commit -m "x"', '.', reviewerCfg)).rejects.toThrow(/超限/);
    await expect(
      translateWithExternalModel('Checking file', translatorCfg, fetch, undefined, { skipCircuitCheck: true })
    ).rejects.toThrow(/超限/);

    // ApprovalEngine must fail closed to Stage 3 ask when reviewer receives oversized payload
    const engine = makeEngine({ mode: 'hybrid', externalReviewer: reviewerCfg });
    const reqEv = once(engine, 'requested');
    const perm = engine.requestPermission(makePerm({ rawInput: { CommandLine: 'git commit -m "oversize"' } }), makeTempDir('gravity-g3-os-'));
    const [card] = (await reqEv) as [PendingApprovalRequest];
    expect(card.aiSuggestion?.recommended).toBe('ask');
    expect(card.aiSuggestion?.isError).toBe(true);
    engine.cancelSession(card.sessionId);
    expect((await perm).outcome.outcome).toBe('cancelled');
  });

  it('3.3) Malformed / Non-JSON / Truncated JSON / riskScore > 90 / critical / allowAlignedHighRiskPass=false / intentAlignment=misaligned medium+ ALWAYS fail closed to Stage 3 ask', async () => {
    type FailureMode = 'non-json' | 'bad-content' | 'truncated' | 'high-risk-91' | 'high-risk-95' | 'critical-level' | 'high-risk-70' | 'misaligned';
    let mode: FailureMode = 'non-json';

    const { baseUrl } = await startLoopbackServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'non-json') {
        res.end('<html><body>Not JSON</body></html>');
        return;
      }
      if (mode === 'bad-content') {
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Sure, approve it!' } }] }));
        return;
      }
      if (mode === 'truncated') {
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: 'length', message: { content: '{"recommended":"approve","riskLevel":"safe","reason":"ok' } }],
          })
        );
        return;
      }
      if (mode === 'high-risk-91') {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    recommended: 'approve',
                    riskLevel: 'high',
                    riskScore: 91,
                    intentAlignment: 'aligned',
                    reason: 'boundary riskScore=91 exceeds default 90 ceiling',
                  }),
                },
              },
            ],
          })
        );
        return;
      }
      if (mode === 'critical-level') {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    recommended: 'approve',
                    riskLevel: 'critical',
                    riskScore: 70,
                    intentAlignment: 'aligned',
                    reason: 'critical risk level must never auto-approve',
                  }),
                },
              },
            ],
          })
        );
        return;
      }
      if (mode === 'high-risk-70') {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    recommended: 'approve',
                    riskLevel: 'high',
                    riskScore: 70,
                    intentAlignment: 'aligned',
                    reason: 'high riskScore=70 must not auto-approve when allowAlignedHighRiskPass is false',
                  }),
                },
              },
            ],
          })
        );
        return;
      }
      if (mode === 'high-risk-95') {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    recommended: 'approve',
                    riskLevel: 'safe',
                    riskScore: 95,
                    intentAlignment: 'aligned',
                    reason: 'contradictory high risk score exceeds ceiling',
                  }),
                },
              },
            ],
          })
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  recommended: 'approve',
                  riskLevel: 'medium',
                  riskScore: 45,
                  intentAlignment: 'misaligned',
                  reason: 'medium risk unrelated to user request',
                }),
              },
            },
          ],
        })
      );
    });

    const reviewerCfg: ExternalAiReviewerConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `${baseUrl}/api/v1`,
      model: 'gpt-6.2-astra',
      apiKey: 'sk-test-failclosed',
      timeoutMs: 3000,
      connectionStatus: 'connected',
      verificationMethod: 'review-call',
      lastVerifiedAt: '2026-11-23T00:00:00.000Z',
    };
    const engine = makeEngine({ mode: 'hybrid', externalReviewer: reviewerCfg });
    const cwd = makeTempDir('gravity-g3-fc-');

    const cases: FailureMode[] = ['non-json', 'bad-content', 'truncated', 'high-risk-91', 'high-risk-95', 'critical-level', 'misaligned'];
    for (const testCase of cases) {
      mode = testCase;
      const reqEv = once(engine, 'requested');
      const perm = engine.requestPermission(
        makePerm({ sessionId: `sess-fc-${testCase}`, rawInput: { CommandLine: `git commit -m "${testCase}"` } }),
        cwd
      );
      const [card] = (await reqEv) as [PendingApprovalRequest];
      expect(card.aiSuggestion?.recommended, `case ${testCase} must fail closed to ask`).toBe('ask');
      engine.cancelSession(`sess-fc-${testCase}`);
      expect((await perm).outcome.outcome).toBe('cancelled');
    }

    // With allowAlignedHighRiskPass disabled, riskLevel='high' + riskScore=70 must also fail closed to Stage 3 ask
    const strictEngine = makeEngine({ mode: 'hybrid', allowAlignedHighRiskPass: false, externalReviewer: reviewerCfg });
    mode = 'high-risk-70';
    const strictEv = once(strictEngine, 'requested');
    const strictPerm = strictEngine.requestPermission(
      makePerm({ sessionId: 'sess-fc-strict-70', rawInput: { CommandLine: 'git commit -m "strict-70"' } }),
      cwd
    );
    const [strictCard] = (await strictEv) as [PendingApprovalRequest];
    expect(strictCard.aiSuggestion?.recommended, 'allowAlignedHighRiskPass=false must block high-risk-70').toBe('ask');
    strictEngine.cancelSession('sess-fc-strict-70');
    expect((await strictPerm).outcome.outcome).toBe('cancelled');
  });

  it('3.4) API Key Redaction: HTTP 401 and 500 echoing caller secret NEVER leak secret into thrown errors or aiSuggestion.reason', async () => {
    const secret = 'sk-test-super-secret-99999';
    let statusToSend = 401;

    const { baseUrl } = await startLoopbackServer((_req, res) => {
      res.writeHead(statusToSend, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `Unauthorized caller key=${secret} rejected by gateway` },
        })
      );
    });

    const reviewerCfg: ExternalAiReviewerConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `${baseUrl}/api/v1`,
      model: 'gpt-6.2-astra',
      apiKey: secret,
      timeoutMs: 3000,
      connectionStatus: 'connected',
      verificationMethod: 'review-call',
      lastVerifiedAt: '2026-11-23T00:00:00.000Z',
    };
    const translatorCfg: ExternalTranslatorConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `${baseUrl}/api/v1`,
      model: 'gpt-6.2-astra',
      apiKey: secret,
      timeoutMs: 3000,
    };

    const engine = makeEngine({ mode: 'hybrid', externalReviewer: reviewerCfg });
    const cwd = makeTempDir('gravity-g3-redact-');

    for (const status of [401, 500]) {
      statusToSend = status;

      // Direct reviewer call
      let reviewerErrMsg = '';
      try {
        await callIndependentModelWithUsage(reviewerCfg, 'sys', 'user');
      } catch (err) {
        reviewerErrMsg = err instanceof Error ? err.message : String(err);
      }
      expect(reviewerErrMsg).toContain(`HTTP ${status}`);
      expect(reviewerErrMsg).not.toContain(secret);

      // ApprovalEngine Stage 2 fallback -> aiSuggestion.reason
      const reqEv = once(engine, 'requested');
      const perm = engine.requestPermission(
        makePerm({ sessionId: `sess-redact-${status}`, rawInput: { CommandLine: `git commit -m "redact-${status}"` } }),
        cwd
      );
      const [card] = (await reqEv) as [PendingApprovalRequest];
      expect(card.aiSuggestion?.isError).toBe(true);
      expect(card.aiSuggestion?.reason).toBeTruthy();
      expect(card.aiSuggestion?.reason).not.toContain(secret);
      engine.cancelSession(`sess-redact-${status}`);
      await perm;

      // Direct translator call & testExternalTranslator
      let translatorErrMsg = '';
      try {
        await translateWithExternalModel('Checking config', translatorCfg, fetch, undefined, { skipCircuitCheck: true });
      } catch (err) {
        translatorErrMsg = err instanceof Error ? err.message : String(err);
      }
      expect(translatorErrMsg).toContain(`HTTP ${status}`);
      expect(translatorErrMsg).not.toContain(secret);

      const probeResult = await testExternalTranslator(translatorCfg);
      expect(probeResult.ok).toBe(false);
      expect(probeResult.error).not.toContain(secret);
    }
  });

  it('3.5) Subpath Preservation: both callIndependentModel and translateWithExternalModel hit /api/v1/chat/completions (never /v1/chat/completions or /api/v1/v1/...)', async () => {
    const requestedPaths: string[] = [];
    const { baseUrl } = await startLoopbackServer((req, res) => {
      requestedPaths.push(req.url || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '正在检查配置文件。' } }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        })
      );
    });

    const endpoint = `${baseUrl}/api/v1`;
    const { text: reviewerOut } = await callIndependentModelWithUsage(
      {
        enabled: true,
        provider: 'openai-compatible',
        endpoint,
        model: 'gpt-6.2-astra',
        apiKey: 'sk-test-subpath',
        timeoutMs: 3000,
      },
      'sys',
      'user'
    );
    expect(reviewerOut).toBe('正在检查配置文件。');

    const translatorOut = await translateWithExternalModel(
      'Checking the configuration file.',
      {
        enabled: true,
        provider: 'openai-compatible',
        endpoint,
        model: 'gpt-6.2-astra',
        apiKey: 'sk-test-subpath',
        timeoutMs: 3000,
      },
      fetch,
      undefined,
      { skipCircuitCheck: true }
    );
    expect(translatorOut.text).toBe('正在检查配置文件。');

    expect(requestedPaths).toEqual(['/api/v1/chat/completions', '/api/v1/chat/completions']);
    for (const p of requestedPaths) {
      expect(p).not.toBe('/v1/chat/completions');
      expect(p).not.toContain('/api/v1/v1/');
    }
  });

  it('3.6) SSRF Host Fuzzing: validateExternalEndpoint rejects all numeric, hex, IPv4-mapped IPv6, metadata, CGNAT, RFC1918, .local & Google-internal hosts', () => {
    const forbiddenEndpoints = [
      'https://2130706433',
      'https://0x7f000001',
      'https://[::ffff:127.0.0.1]',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://172.16.0.1',
      'https://192.168.0.1',
      'https://internal.local',
      'https://cloudcode-pa.googleapis.com',
      'https://daily-cloudcode-pa.googleapis.com',
      'https://0177.0.0.1',
      'https://[fe80::1]',
      'https://metadata.google.internal',
    ];

    for (const endpoint of forbiddenEndpoints) {
      expect(
        () =>
          validateExternalEndpoint({
            enabled: true,
            provider: 'openai-compatible',
            endpoint,
            model: 'gpt-6.2-astra',
            apiKey: 'sk-test-ssrf',
            timeoutMs: 3000,
          }),
        `validateExternalEndpoint must reject SSRF/internal host: ${endpoint}`
      ).toThrow();
    }
  });
});

/* ============================================================================
 * Group 4: Persistence, Crash Recovery & Concurrency
 * ========================================================================== */
describe('Group 4: Persistence, Crash Recovery & Concurrency', () => {
  it('4.1) CRITICAL RACE: synchronous write() supersedes pending writeDebounced() and prevents stale clobbering (including Windows mixed-case)', async () => {
    const dir = makeTempDir('gravity-g4-race-');
    const store = new ClientStore(dir);

    // Case A: debounced(60ms) -> immediate sync write -> wait 120ms
    store.writeDebounced('race.json', { version: 1 }, 60);
    store.write('race.json', { version: 2 });
    await new Promise((r) => setTimeout(r, 120));
    expect(store.read<{ version: number } | null>('race.json', null)).toEqual({ version: 2 });

    // Case B: mixed-case filename on Windows (RaceCase.json vs racecase.json)
    store.writeDebounced('RaceCase.json', { version: 10 }, 50);
    store.write('racecase.json', { version: 20 });
    await new Promise((r) => setTimeout(r, 110));
    expect(store.read<{ version: number } | null>('racecase.json', null)).toEqual({ version: 20 });

    // Case C: writeDebounced timer already fired & in-flight async writeInBackground raced by sync write()
    store.writeDebounced('inflight-race.json', { version: 100, blob: 'x'.repeat(20_000) }, 1);
    await new Promise((r) => setTimeout(r, 2));
    store.write('inflight-race.json', { version: 200 });
    await new Promise((r) => setTimeout(r, 80));
    expect(store.read<{ version: number } | null>('inflight-race.json', null)).toEqual({ version: 200 });
  });

  it('4.2) Crash recovery from .bak: corrupting primary JSON transparently recovers valid snapshot from .bak', () => {
    const dir = makeTempDir('gravity-g4-bak-');
    const store = new ClientStore(dir);

    // Settings file with shadow backup
    const prefs = { theme: 'claude-dark', locale: 'zh-CN', fontSize: 14 };
    store.write('preferences.json', prefs);
    expect(existsSync(path.join(dir, 'preferences.json.bak'))).toBe(true);

    // Corrupt primary with truncated garbage
    writeFileSync(path.join(dir, 'preferences.json'), '{broken', 'utf8');
    expect(store.read('preferences.json', null)).toEqual(prefs);

    // Message index v2 with shadow backup via ConversationMessages
    const msgs = new ConversationMessages(store);
    msgs.load('default');
    const sampleMsg: ChatMessageItem = {
      id: 'm-bak-1',
      sessionId: 'sess-bak',
      role: 'user',
      content: 'survive crash via .bak',
      createdAt: '2026-11-23T00:00:00.000Z',
    };
    msgs.upsert(sampleMsg);
    msgs.save();
    expect(existsSync(path.join(dir, 'message-index-v2-default.json.bak'))).toBe(true);

    writeFileSync(path.join(dir, 'message-index-v2-default.json'), '{broken', 'utf8');
    const recoveredMsgs = new ConversationMessages(new ClientStore(dir));
    recoveredMsgs.load('default');
    expect(recoveredMsgs.get('sess-bak')).toEqual([expect.objectContaining({ id: 'm-bak-1', content: 'survive crash via .bak' })]);
  });

  it('4.3) High-frequency burst (150 tool_call_update + message upserts + session metadata) + immediate dispose() preserves 100% of final state on fresh CoreService boot', async () => {
    const dataDir = makeTempDir('gravity-g4-burst-');
    const workspaceDir = makeTempDir('gravity-g4-ws-');
    const acp1 = new StubDeepAcpClient();
    const core1 = new CoreService({ dataDir, acp: acp1 as never, enableAutoUpdateCheck: false });
    services.push(core1);

    const session = await core1.createSession({ cwd: workspaceDir, title: 'Burst Initial Title' });
    const sid = session.sessionId;

    // Seed initial tool calls: 1 terminal command + 1 file edit diff
    acp1.emitSessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-term-burst',
        kind: 'execute',
        title: 'run_command',
        rawInput: { command: 'npm run build:all' },
        status: 'in_progress',
      },
    });
    acp1.emitSessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-edit-burst',
        kind: 'edit',
        title: 'edit_file',
        rawInput: { path: 'src/app.ts', oldText: 'const v = 0;', newText: 'const v = 1;' },
        status: 'in_progress',
      },
    });

    // Tight loop: 150 tool_call_updates + 150 assistant message chunks + session metadata updates
    for (let i = 1; i <= 150; i++) {
      const isLast = i === 150;
      acp1.emitSessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-term-burst',
          rawOutput: isLast ? { stdout: 'FINAL_BURST_OUTPUT_150', exitCode: 0 } : { stdout: `stream-line-${i}` },
          status: isLast ? 'completed' : 'in_progress',
        },
      });
      acp1.emitSessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: isLast ? '[END-150]' : `c${i}-` },
        },
      });
      if (i % 25 === 0) {
        const cur = core1.sessions.get(sid);
        core1.sessions.updateSessionRecord({ ...cur, title: `Burst Updated #${i}`, pinned: true }, true);
      }
    }

    // Complete the file edit diff right before dispose
    acp1.emitSessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-edit-burst',
        toolContent: [{ type: 'diff', path: 'src/app.ts', oldText: 'const v = 0;', newText: 'const v = 150;' }],
        status: 'completed',
      },
    });

    // Immediately dispose without waiting for any 300ms debounce timer
    await core1.dispose();
    services.pop();

    // Boot fresh CoreService on the exact same dataDir
    const acp2 = new StubDeepAcpClient();
    const core2 = new CoreService({ dataDir, acp: acp2 as never, enableAutoUpdateCheck: false });
    services.push(core2);

    // 1) Final messages survived 100%
    const recoveredMessages = await readAllSessionMessages(core2, sid);
    expect(recoveredMessages.length).toBeGreaterThanOrEqual(1);
    const assistantMsg = recoveredMessages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain('c1-');
    expect(assistantMsg!.content).toContain('c149-');
    expect(assistantMsg!.content.endsWith('[END-150]')).toBe(true);
    expect(assistantMsg!.isStreaming).toBe(false);
    expect(assistantMsg!.toolCalls).toHaveLength(2);

    // 2) Final inspector diffs & terminals survived 100%
    const inspector = await core2.getSessionInspector(sid);
    expect(inspector.terminals).toHaveLength(1);
    expect(inspector.terminals[0]).toMatchObject({
      toolCallId: 'tc-term-burst',
      command: 'npm run build:all',
      output: 'FINAL_BURST_OUTPUT_150',
      status: 'completed',
      exitCode: 0,
    });
    expect(inspector.diffs).toHaveLength(1);
    expect(inspector.diffs[0]).toMatchObject({
      filePath: 'src/app.ts',
      toolCallId: 'tc-edit-burst',
      newText: 'const v = 150;',
    });
    expect(inspector.diffs[0].lines.some((l) => l.type === 'add' && l.content === 'const v = 150;')).toBe(true);

    // 3) Final session metadata survived 100%
    const recoveredSession = core2.sessions.get(sid);
    expect(recoveredSession.title).toBe('Burst Updated #150');
    expect(recoveredSession.pinned).toBe(true);
    expect(recoveredSession.cwd).toBe(workspaceDir);
  });

  it('4.4) MAX_PARALLEL_ACTIVE_SESSIONS = 4: concurrent 5th createSession rejects cleanly without corrupting existing 4; closing 1 frees slot immediately', async () => {
    expect(MAX_PARALLEL_ACTIVE_SESSIONS).toBe(4);
    const dir = makeTempDir('gravity-g4-max4-');
    const store = new ClientStore(dir);
    const acp = new StubDeepAcpClient();
    acp.newSessionDelayMs = 25;
    const mux = new SessionMultiplexer(acp as never, store);

    // Fire 5 concurrent createSession calls racing on the same multiplexer
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => mux.createSession({ cwd: dir, title: `Parallel-${i + 1}` }))
    );

    const fulfilled = attempts.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof mux.createSession>>> => r.status === 'fulfilled');
    const rejected = attempts.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toContain('最多同时打开 4 个活动会话');
    expect(mux.activeSessionCount).toBe(4);

    // All 4 existing sessions remain intact and active
    const activeIds = fulfilled.map((f) => f.value.sessionId);
    for (const id of activeIds) {
      expect(mux.isActive(id)).toBe(true);
      expect(mux.get(id).status).toBe('idle');
    }

    // Also verify external slot reservation respects the exact same cap of 4
    expect(() => mux.reserveExternalSlot()).toThrow(/4 个活动会话/);

    // Close 1 session -> immediately frees slot for a new 4th session
    await mux.closeSession(activeIds[0]);
    expect(mux.activeSessionCount).toBe(3);
    expect(mux.isActive(activeIds[0])).toBe(false);

    const replacement = await mux.createSession({ cwd: dir, title: 'Parallel-Replacement' });
    expect(mux.activeSessionCount).toBe(4);
    expect(mux.isActive(replacement.sessionId)).toBe(true);
    for (const id of activeIds.slice(1)) {
      expect(mux.isActive(id)).toBe(true);
    }
  });

  it('4.5) ConversationTreeStore handles multi-level forks, sibling indices, cascade subtree deletion, and persisted reload integrity', () => {
    const dir = makeTempDir('gravity-g4-tree-');
    const store = new ClientStore(dir);
    const trees = new ConversationTreeStore(store);
    trees.setProfile('default');

    // root -> branchA (turn 0), root -> branchB (same fork point turn 0), branchA -> branchA1 (turn 1)
    trees.recordBranch({
      rootSessionId: 'root-1',
      rootPromptPreview: 'Initial question',
      branchId: 'branch-a',
      parentBranchId: 'root-1',
      forkAfterMessageId: null,
      forkUserTurnIndex: 0,
      forkPromptPreview: 'Alternative A',
      nowIso: '2026-11-23T01:00:00.000Z',
    });
    trees.recordBranch({
      rootSessionId: 'root-1',
      branchId: 'branch-b',
      parentBranchId: 'root-1',
      forkAfterMessageId: null,
      forkUserTurnIndex: 0,
      forkPromptPreview: 'Alternative B',
      nowIso: '2026-11-23T01:01:00.000Z',
    });
    trees.recordBranch({
      rootSessionId: 'root-1',
      branchId: 'branch-a1',
      parentBranchId: 'branch-a',
      forkAfterMessageId: 'msg-a-1',
      forkUserTurnIndex: 1,
      forkPromptPreview: 'Nested under A',
      nowIso: '2026-11-23T01:02:00.000Z',
    });

    // Reload from disk into fresh instance
    const reloaded = new ConversationTreeStore(new ClientStore(dir));
    reloaded.setProfile('default', new Set(['root-1', 'branch-a', 'branch-b', 'branch-a1']));
    expect(reloaded.hasTree('branch-a1')).toBe(true);
    expect(reloaded.resolveRootId('branch-a1')).toBe('root-1');

    const treeState = reloaded.buildTreeState('root-1', {
      getSession: () => undefined,
      getMessageStats: () => summarizeBranchMessages([]),
      getTelemetry: () => undefined,
      getRootTitle: () => 'Tree Root',
    });
    expect(treeState.totalBranches).toBe(4);
    expect(treeState.activeBranchId).toBe('branch-a1');
    expect(treeState.nodesById['root-1'].siblingCount).toBe(3);
    expect(treeState.nodesById['branch-a'].siblingIndex).toBe(2);
    expect(treeState.nodesById['branch-b'].siblingIndex).toBe(3);
    expect(treeState.nodesById['branch-a1'].depth).toBe(2);
    expect(treeState.nodesById['branch-a1'].isOnActivePath).toBe(true);
    expect(treeState.nodesById['branch-b'].isOnActivePath).toBe(false);

    // Deleting middle branch-a must cascade to branch-a1 and fall back activeBranchId to root-1
    const removed = reloaded.removeBranchOrTree('branch-a');
    expect(removed.sort()).toEqual(['branch-a', 'branch-a1']);
    expect(reloaded.getStoredTree('root-1')?.activeBranchId).toBe('root-1');
    expect(reloaded.listBranchIds('root-1').sort()).toEqual(['branch-b', 'root-1']);
  });
});

/* ============================================================================
 * Group 5: Real Windows Subprocess Tree Cleanup & PluginsManager Adversarial Tests
 * ========================================================================== */
describe('Group 5: Real Windows Subprocess Tree Cleanup & PluginsManager Adversarial Tests', () => {
  it('5.1) AcpClient.stop() terminates a real 3-generation Windows process tree (holding stdout open and ignoring stdin EOF) within 3 seconds', async () => {
    const dir = makeTempDir('gravity-g5-proctree-');
    const fixturePath = path.join(dir, 'three-gen-fixture.cjs');
    const pidDir = path.join(dir, 'pids');
    mkdirSync(pidDir, { recursive: true });

    const fixtureCode = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const role = process.argv[2];
const pidDir = process.argv[3];

if (role === 'grandchild') {
  fs.writeFileSync(path.join(pidDir, 'gen3.pid'), String(process.pid), 'utf8');
  setInterval(() => {}, 60000);
} else if (role === 'child') {
  const gc = spawn(process.execPath, [__filename, 'grandchild', pidDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  gc.unref();
  fs.writeFileSync(path.join(pidDir, 'gen2.pid'), String(process.pid), 'utf8');
  setInterval(() => {}, 60000);
} else if (role === 'root') {
  const child = spawn(process.execPath, [__filename, 'child', pidDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(path.join(pidDir, 'gen1.pid'), String(process.pid), 'utf8');

  // Deliberately ignore stdin EOF and keep process alive
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: 'three-gen-fixture', version: '1.0.0' },
              agentCapabilities: { loadSession: true },
            },
          }) + '\\n');
        }
      } catch {}
    }
  });
  process.stdin.on('end', () => {
    // Ignore stdin EOF intentionally
  });
  setInterval(() => {}, 60000);
}
`;
    writeFileSync(fixturePath, fixtureCode, 'utf8');

    let pids: number[] = [];
    const client = new AcpClient({
      spawn: (_bin, _args, opts) => nodeSpawn(process.execPath, [fixturePath, 'root', pidDir], opts),
    });
    acpClients.push(client);

    try {
      const init = await client.start();
      expect(init.protocolVersion).toBe(1);

      // Wait until all 3 generations have written their PIDs
      const readPid = (file: string): number | undefined => {
        const full = path.join(pidDir, file);
        if (!existsSync(full)) return undefined;
        const n = Number(readFileSync(full, 'utf8').trim());
        return Number.isSafeInteger(n) && n > 1 ? n : undefined;
      };

      const gen1 = await waitForCondition(() => readPid('gen1.pid'), 3000, 'gen1.pid');
      const gen2 = await waitForCondition(() => readPid('gen2.pid'), 3000, 'gen2.pid');
      const gen3 = await waitForCondition(() => readPid('gen3.pid'), 3000, 'gen3.pid');
      pids = [gen1, gen2, gen3];

      // Confirm all 3 processes are genuinely alive before stop()
      expect(new Set(pids).size).toBe(3);
      for (const pid of pids) {
        expect(isPidAlive(pid), `PID ${pid} must be alive before AcpClient.stop()`).toBe(true);
      }

      const stopStarted = Date.now();
      await client.stop();

      // Wait up to remaining budget within 3 seconds for OS process teardown
      await waitForCondition(
        () => (pids.every((pid) => !isPidAlive(pid)) ? true : undefined),
        Math.max(100, 3000 - (Date.now() - stopStarted)),
        'all 3 generation PIDs terminated (ESRCH)'
      );
      const elapsedMs = Date.now() - stopStarted;
      expect(elapsedMs).toBeLessThan(3000);
      expect(client.connected).toBe(false);

      // Explicitly verify process.kill(pid, 0) throws ESRCH for all 3 PIDs
      for (const pid of pids) {
        let errCode: string | undefined;
        try {
          process.kill(pid, 0);
        } catch (err) {
          errCode = (err as NodeJS.ErrnoException)?.code;
        }
        expect(errCode, `PID ${pid} must throw ESRCH after stop()`).toBe('ESRCH');
      }
    } finally {
      // Safety net to never leak processes if an assertion fails
      for (const pid of pids) {
        if (isPidAlive(pid)) forceKillTreeFallback(pid);
      }
    }
  }, 15_000);

  it('5.2) PluginsManager rejects path traversal, .gemini directory, CLI flag injection, and null bytes on install without invoking CLI', async () => {
    const dir = makeTempDir('gravity-g5-plugins-adv-');
    const executor = vi.fn<CliExecutor>(async () => ({ stdout: '[]' }));
    const manager = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store')),
      executor,
      homeDir: path.join(dir, 'home'),
      binaryPath: 'test-only-agy',
    });

    const adversarialTargets = [
      'C:\\plugins\\..\\secret',
      'C:\\Users\\Admin\\.gemini\\plugins\\x',
      '--help',
      '-v',
      'valid-plugin\0--evil',
      'C:\\plugins\\ok\0evil',
      '\\\\evil-unc-host\\share\\plugin',
    ];

    for (const target of adversarialTargets) {
      await expect(
        manager.runPluginAction({ action: 'install', target }),
        `install must reject adversarial target: ${JSON.stringify(target)}`
      ).rejects.toThrow();
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it('5.3) PluginsManager partial-failure resilience & secret scrubbing works in both directions (plugin list fails OR mcp list fails)', async () => {
    const dir = makeTempDir('gravity-g5-plugins-partial-');
    const workspace = path.join(dir, 'workspace');
    const skillFile = path.join(workspace, '.agents', 'skills', 'deep-skill', 'SKILL.md');
    mkdirSync(path.dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, '---\nname: Deep Skill\ndescription: Always discovered\n---\nbody', 'utf8');

    const secretBearer = 'secret-token-abc123';
    const oversizedSecretStderr =
      `fatal: auth failed Authorization: Bearer ${secretBearer} sk-ant-secret999999999999 ` +
      'X'.repeat(600);

    // Direction A: plugin list fails with secret stderr, mcp list succeeds
    const execA = vi.fn<CliExecutor>(async (_binary, args) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        throw Object.assign(new Error(`plugin error Bearer ${secretBearer}`), { stderr: oversizedSecretStderr });
      }
      if (args[0] === 'mcp' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            mcpServers: {
              search: { command: 'npx', args: ['search-mcp'], enabled: true },
            },
          }),
        };
      }
      return { stdout: '' };
    });

    const mgrA = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store-a')),
      executor: execA,
      homeDir: path.join(dir, 'home-a'),
      binaryPath: 'test-only-agy',
    });
    const snapA = await mgrA.getSnapshot(workspace);
    expect(snapA.plugins).toEqual([]);
    expect(snapA.mcpServers).toEqual([expect.objectContaining({ name: 'search', commandOrUrl: 'npx', enabled: true })]);
    expect(snapA.skills).toEqual([expect.objectContaining({ name: 'Deep Skill', scope: 'workspace' })]);
    expect(snapA.sectionErrors?.plugins).toBeTruthy();
    expect(snapA.sectionErrors?.mcp).toBeUndefined();
    expect(snapA.sectionErrors!.plugins!).not.toContain(secretBearer);
    expect(snapA.sectionErrors!.plugins!).not.toContain('sk-ant-secret999999999999');
    expect(snapA.sectionErrors!.plugins!.length).toBeLessThanOrEqual(240);
    expect(snapA.lastCommandOutput || '').not.toContain(secretBearer);

    // Direction B (vice versa): mcp list fails with secret stderr, plugin list succeeds
    const execB = vi.fn<CliExecutor>(async (_binary, args) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            plugins: [{ name: 'code-intel', version: '1.2.0', enabled: true }],
          }),
        };
      }
      if (args[0] === 'mcp' && args[1] === 'list') {
        throw Object.assign(new Error(`mcp error Bearer ${secretBearer}`), { stderr: oversizedSecretStderr });
      }
      return { stdout: '' };
    });

    const mgrB = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store-b')),
      executor: execB,
      homeDir: path.join(dir, 'home-b'),
      binaryPath: 'test-only-agy',
    });
    const snapB = await mgrB.getSnapshot(workspace);
    expect(snapB.plugins).toEqual([expect.objectContaining({ name: 'code-intel', version: '1.2.0', enabled: true })]);
    expect(snapB.mcpServers).toEqual([]);
    expect(snapB.skills).toEqual([expect.objectContaining({ name: 'Deep Skill', scope: 'workspace' })]);
    expect(snapB.sectionErrors?.mcp).toBeTruthy();
    expect(snapB.sectionErrors?.plugins).toBeUndefined();
    expect(snapB.sectionErrors!.mcp!).not.toContain(secretBearer);
    expect(snapB.sectionErrors!.mcp!).not.toContain('sk-ant-secret999999999999');
    expect(snapB.sectionErrors!.mcp!.length).toBeLessThanOrEqual(240);
    expect(snapB.lastCommandOutput || '').not.toContain(secretBearer);
  });
});
