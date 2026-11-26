// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAccountQuota, waitForMacQuotaProbe, AccountQuotaUnavailable } from '../src/main/accounts/account-quota';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import { canEnforceCurlLimit } from '../src/main/approval/curl-download';
import { callIndependentModelWithUsage } from '../src/main/approval/external-reviewer';
import { CoreService } from '../src/main/core-service';
import { executeOfficialCli, PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { openExternalTarget } from '../src/main/services/external-opener';
import { ClientStore } from '../src/main/storage/client-store';
import { translatorCircuit } from '../src/main/llm/external-llm-transport';
import { translateWithExternalModel } from '../src/main/translation/external-translator';
import type {
  AcpRequestPermissionParams,
  ApprovalAuditEntry,
  ExternalAiReviewerConfig,
  ExternalTranslatorConfig,
  PendingApprovalRequest,
} from '@shared';

/* ============================================================================
 * Shared Helpers & Lifecycle
 * ========================================================================== */

const tempDirs: string[] = [];
const engines: ApprovalEngine[] = [];
const services: CoreService[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function tryCreateSymlink(target: string, linkPath: string, type: 'file' | 'junction' = 'file'): boolean {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

function makeEditPerm(sessionId: string, filePath: string): AcpRequestPermissionParams {
  return {
    sessionId,
    toolCall: {
      toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'edit',
      title: 'write_file',
      rawInput: { Path: filePath, Content: '// test edit' },
      locations: [{ path: filePath }],
    },
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

class FakeSpawnChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new Writable({
    write: (chunk, _enc, done) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const msg = JSON.parse(line) as { id?: number | string; method?: string };
        if (msg.method === 'initialize') {
          queueMicrotask(() =>
            this.stdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  protocolVersion: 1,
                  agentInfo: { name: 'fixture-settings', version: '1.0.0' },
                  agentCapabilities: { sessionCapabilities: { close: true } },
                },
              }) + '\n'
            )
          );
        } else if (msg.method === 'session/new') {
          queueMicrotask(() =>
            this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'pps-sess-1' } }) + '\n')
          );
        } else if (msg.method === 'session/close') {
          queueMicrotask(() => this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n'));
        }
      }
      done();
    },
  });
  constructor() {
    super();
    this.stdin.on('finish', () => setImmediate(() => this.emit('close', 0)));
  }
  kill() {
    this.exitCode = 0;
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

/** Build a tiny synthetic Windows PE buffer containing VS_VERSION_INFO for curl version 8.10. */
function createSyntheticCurlExe(major = 8, minor = 10): Buffer {
  const buf = Buffer.alloc(128);
  buf.write('MZ', 0, 'ascii');
  const key = Buffer.from('VS_VERSION_INFO\0', 'utf16le'); // 32 bytes
  key.copy(buf, 16); // offset 16..48 (4-byte aligned)
  buf.writeUInt32LE(0xfeef04bd, 48); // VS_FIXEDFILEINFO signature
  buf.writeUInt32LE(0x00010000, 52); // strucVersion
  buf.writeUInt32LE(((major & 0xffff) << 16) | (minor & 0xffff), 56); // dwFileVersionMS
  return buf;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  translatorCircuit.reset();
  for (const s of services.splice(0)) {
    await s.dispose().catch(() => {});
  }
  for (const e of engines.splice(0)) {
    e.dispose();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  vi.restoreAllMocks();
});

/* ============================================================================
 * 1. B-P1-2 / SEC-2: openExternalTarget executable & symlink hardening
 * ========================================================================== */

describe('B-P1-2 / SEC-2: openExternalTarget executable & symlink credential protection', () => {
  it.each(['.bat', '.exe', '.ps1', '.lnk'])(
    'forces reveal-in-folder (never default-app) when action="browser" targets local %s file',
    async (ext) => {
      const workspace = makeTempDir('gravity-v031-opener-exec-');
      const target = path.join(workspace, `payload${ext}`);
      writeFileSync(target, 'dummy payload');

      const handler = vi.fn();
      const result = await openExternalTarget(
        { target, action: 'browser', cwd: workspace },
        { openTargetHandler: handler }
      );

      expect(result.opened).toBe(true);
      expect(result.modeUsed).toBe('reveal-in-folder');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.any(String), 'reveal-in-folder', false);
    }
  );

  it('rejects symlinks pointing to forbidden credential files (oauth_token.json and .gemini/*.pb)', async () => {
    const root = makeTempDir('gravity-v031-opener-sym-');
    const workspace = path.join(root, 'workspace');
    const secretDir = path.join(root, 'outside', '.gemini', 'antigravity');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(secretDir, { recursive: true });

    const oauthTarget = path.join(secretDir, 'oauth_token.json');
    const pbTarget = path.join(secretDir, 'state.pb');
    writeFileSync(oauthTarget, '{"token":"secret"}');
    writeFileSync(pbTarget, 'binary-state');

    const linkOauth = path.join(workspace, 'notes.md');
    const linkPb = path.join(workspace, 'summary.txt');
    const ok1 = tryCreateSymlink(oauthTarget, linkOauth, 'file');
    const ok2 = tryCreateSymlink(pbTarget, linkPb, 'file');
    expect(ok1 && ok2).toBe(true);

    const handler = vi.fn();
    for (const linkPath of [linkOauth, linkPb]) {
      for (const action of ['default-app', 'reveal-in-folder', 'browser', 'copy'] as const) {
        await expect(
          openExternalTarget({ target: linkPath, action, cwd: workspace }, { openTargetHandler: handler })
        ).rejects.toThrow(/敏感凭据|拒绝打开/);
      }
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

/* ============================================================================
 * 2. B-P1-5: ApprovalEngine workspace symlink escape boundary
 * ========================================================================== */

describe('B-P1-5: ApprovalEngine treats workspace symlinks pointing outside cwd as outside workspace', () => {
  it('never auto-approves edits through a workspace file symlink or symlinked directory pointing outside cwd', async () => {
    const root = makeTempDir('gravity-v031-approval-sym-');
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    const storeDir = path.join(root, 'store');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const realInsideFile = path.join(workspace, 'inside.ts');
    const outsideTarget = path.join(outside, 'outside-config.ts');
    const credentialTarget = path.join(outside, 'secret-config.json');
    writeFileSync(realInsideFile, 'export const ok = true;');
    writeFileSync(outsideTarget, 'export const outside = true;');
    writeFileSync(credentialTarget, '{"secret":true}');

    const fileLink = path.join(workspace, 'escape-file.ts');
    const credentialLink = path.join(workspace, 'escape-cred.ts');
    const dirLink = path.join(workspace, 'escape-dir');
    expect(tryCreateSymlink(outsideTarget, fileLink, 'file')).toBe(true);
    expect(tryCreateSymlink(credentialTarget, credentialLink, 'file')).toBe(true);
    expect(tryCreateSymlink(outside, dirLink, 'junction')).toBe(true);

    const engine = new ApprovalEngine({
      store: new ClientStore(storeDir),
      config: { mode: 'rules-only' },
    });
    engines.push(engine);
    engine.setSessionExecutionMode('sess-sym', 'accept-edits');

    // Control check: genuine file inside workspace auto-approves under accept-edits
    const insideResult = await engine.requestPermission(makeEditPerm('sess-sym', realInsideFile), workspace);
    expect(insideResult.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });

    // Symlink to outside file MUST escalate to human (hardHumanFloor, never auto-approved)
    const asked: PendingApprovalRequest[] = [];
    engine.on('requested', (card: PendingApprovalRequest) => {
      asked.push(card);
      void engine.submitDecision({ requestId: card.requestId, sessionId: card.sessionId, decision: 'reject_with_feedback' });
    });

    const escapeFileResult = await engine.requestPermission(makeEditPerm('sess-sym', fileLink), workspace);
    expect(escapeFileResult.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
    expect(asked).toHaveLength(1);
    expect(asked[0].riskLevel).toBe('high');
    expect(asked[0].commandPrefix).toBeUndefined();

    // New non-existent file inside a symlinked directory pointing outside cwd MUST ALSO escalate to human!
    const newOutsidePath = path.join(dirLink, 'brand-new-escape.ts');
    const escapeDirResult = await engine.requestPermission(makeEditPerm('sess-sym', newOutsidePath), workspace);
    expect(escapeDirResult.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
    expect(asked).toHaveLength(2);
    expect(asked[1].riskLevel).toBe('high');
    expect(asked[1].commandPrefix).toBeUndefined();

    // Symlink resolving to a credential-named file MUST be hard-denied directly without human prompt!
    const credResult = await engine.requestPermission(makeEditPerm('sess-sym', credentialLink), workspace);
    expect(credResult.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
    expect(asked).toHaveLength(2);
  });
});

/* ============================================================================
 * 3. B-P1-6: ClientStore / ApprovalEngine.listAudit(50) bounded tail read & rotation
 * ========================================================================== */

describe('B-P1-6: ClientStore & ApprovalEngine.listAudit(50) bounded tail read and rotation', () => {
  it('reads exact latest 50 audit entries accurately and rotates oversized (> 2 MB) audit.jsonl on append', () => {
    const dir = makeTempDir('gravity-v031-audit-');
    const store = new ClientStore(dir);
    const engine = new ApprovalEngine({ store });
    engines.push(engine);

    const auditFile = path.join(dir, 'audit.jsonl');
    const totalRecords = 6000;
    const filler = 'x'.repeat(420);
    const lines: string[] = [];
    for (let i = 1; i <= totalRecords; i++) {
      const entry: ApprovalAuditEntry = {
        id: `audit-${String(i).padStart(5, '0')}`,
        timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        sessionId: 'sess-audit',
        toolCallId: `tc-${i}`,
        cwd: dir,
        toolName: 'run_command',
        commandOrSummary: `echo ${i} ${filler}`,
        modeAtDecision: 'rules-only',
        verdict: 'auto_approved',
        decisionSource: 'local-rule',
        riskLevel: 'safe',
        latencyMs: 1,
        reason: 'ok',
      };
      lines.push(JSON.stringify(entry));
    }
    // Insert a corrupted line earlier in the file (outside last 50 lines) so last 50 records are intact
    lines.splice(lines.length - 100, 0, '{corrupted json line');
    writeFileSync(auditFile, lines.join('\n') + '\n', 'utf8');

    const initialSize = statSync(auditFile).size;
    expect(initialSize).toBeGreaterThan(3 * 1024 * 1024);

    // Bounded tail read returns exact latest 50 valid records newest-first
    const beforeRotate = engine.listAudit(50);
    expect(beforeRotate).toHaveLength(50);
    expect(beforeRotate[0].id).toBe('audit-06000');
    expect(beforeRotate[49].id).toBe('audit-05951');

    // Appending one more entry triggers size-bounded rotation (file shrinks well below 3 MB while preserving newest entries)
    const newestEntry: ApprovalAuditEntry = {
      id: 'audit-06001',
      timestamp: new Date(1_700_000_000_000 + 6001 * 1000).toISOString(),
      sessionId: 'sess-audit',
      toolCallId: 'tc-6001',
      cwd: dir,
      toolName: 'run_command',
      commandOrSummary: 'echo latest',
      modeAtDecision: 'rules-only',
      verdict: 'auto_approved',
      decisionSource: 'local-rule',
      riskLevel: 'safe',
      latencyMs: 1,
      reason: 'ok',
    };
    store.append('audit.jsonl', newestEntry);

    const rotatedSize = statSync(auditFile).size;
    expect(rotatedSize).toBeLessThan(initialSize * 0.75);

    const afterRotate = engine.listAudit(50);
    expect(afterRotate).toHaveLength(50);
    expect(afterRotate[0].id).toBe('audit-06001');
    expect(afterRotate[1].id).toBe('audit-06000');

    // Malformed line inside tail window still preserves valid neighbors without throwing
    writeFileSync(
      path.join(dir, 'malformed-tail.jsonl'),
      `${JSON.stringify({ id: 'ok-1' })}\n{broken-json\n${JSON.stringify({ id: 'ok-2' })}\n`,
      'utf8'
    );
    expect(store.readTailLines<{ id: string }>('malformed-tail.jsonl', 10)).toEqual([{ id: 'ok-1' }, { id: 'ok-2' }]);
  });
});

/* ============================================================================
 * 4. B-P2-1: AccountQuota error differentiation (abort/timeout vs not logged in)
 * ========================================================================== */

describe('B-P2-1: AccountQuota error differentiation & ExecutionPolicy Bypass', () => {
  it('uses ExecutionPolicy Bypass (not RemoteSigned) on Windows to avoid MOTW blocking', () => {
    const source = readFileSync('src/main/accounts/account-quota.ts', 'utf8');
    expect(source).not.toContain("'RemoteSigned'");
    expect(source).toContain("'Bypass'");
  });

  it.runIf(process.platform === 'win32')(
    'differentiates mid-flight AbortSignal cancellation from not-logged-in error on Windows',
    async () => {
      const dir = makeTempDir('gravity-v031-quota-abort-');
      const fakeAgy = path.join(dir, 'agy.exe');
      writeFileSync(fakeAgy, 'placeholder');
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 80);

      let caught: Error | undefined;
      try {
        await readAccountQuota(
          { profileId: 'default', name: 'Default', isDefault: true, createdAt: '', lastActivatedAt: '' },
          fakeAgy,
          controller.signal
        );
      } catch (err) {
        caught = err as Error;
      } finally {
        clearTimeout(abortTimer);
      }

      expect(caught).toBeDefined();
      expect(caught!.message).not.toContain('请确认已登录官方 agy');
      expect(caught!.name === 'AbortError' || /取消|中止|abort/i.test(caught!.message)).toBe(true);
    },
    10_000
  );

  it('waitForMacQuotaProbe distinguishes abort, timeout, helper unavailable (exit 3), and not logged in (exit 1)', async () => {
    const makeFakeProc = () => {
      const proc = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
      proc.kill = vi.fn(() => {
        queueMicrotask(() => proc.emit('close', null));
        return true;
      });
      return proc as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
    };

    // 1) Abort
    const abortCtrl = new AbortController();
    const pAbort = makeFakeProc();
    const abortWait = waitForMacQuotaProbe(pAbort, 10, abortCtrl.signal);
    abortCtrl.abort();
    await expect(abortWait).rejects.toThrow(/取消/);

    // 2) Timeout
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pTimeout = makeFakeProc();
      const timeoutWait = waitForMacQuotaProbe(pTimeout, 1);
      const assertion = expect(timeoutWait).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(7_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    // 3) Helper unavailable (exit 3)
    const pHelper = makeFakeProc();
    const helperWait = waitForMacQuotaProbe(pHelper, 10);
    pHelper.emit('close', 3);
    await expect(helperWait).rejects.toBeInstanceOf(AccountQuotaUnavailable);

    // 4) Not logged in (exit 1)
    const pNotLoggedIn = makeFakeProc();
    const loginWait = waitForMacQuotaProbe(pNotLoggedIn, 10);
    pNotLoggedIn.emit('close', 1);
    await expect(loginWait).rejects.toThrow(/登录/);
  });
});

/* ============================================================================
 * 5. B-P2-3: External Translator & Reviewer timeout abort + circuit-breaker recording
 * ========================================================================== */

describe('B-P2-3: External Translator / Reviewer timeout abort & circuit-breaker failure recording', () => {
  it('aborts the underlying signal when TranslationService times out instead of leaving fetch running', async () => {
    const dir = makeTempDir('gravity-v031-trans-timeout-');
    let observedSignal: AbortSignal | undefined;
    let shouldHang = false;

    const core = new CoreService({
      dataDir: dir,
      homeDir: path.join(dir, 'home'),
      externalTranslator: async (_text, _cfg, _fetcher, signal) => {
        if (!shouldHang) {
          return { text: '正在检查配置文件。', latencyMs: 5 };
        }
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
        });
      },
    });
    services.push(core);

    const testRes = await core.testExternalTranslatorConnection({
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5:3b',
      timeoutMs: 120,
    });
    expect(testRes.ok).toBe(true);

    await core.updateTranslationConfig({
      engine: 'external-api',
      externalTranslator: {
        enabled: true,
        provider: 'local-ollama',
        endpoint: 'http://127.0.0.1:11434',
        model: 'qwen2.5:3b',
        timeoutMs: 120,
      },
    });

    shouldHang = true;
    // Trigger thought translation via CoreService's ThoughtTranslator pipeline
    core.thoughts.append('thought-timeout-1', 'Checking the workspace layout for potential errors.');
    core.thoughts.complete('thought-timeout-1');

    // Wait slightly past 120ms timeout
    await new Promise((r) => setTimeout(r, 260));
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(true);
  });

  it('records circuit-breaker failures on max_tokens truncation and refusal responses in translateWithExternalModel', async () => {
    const endpoint = 'http://127.0.0.1:19431';
    const cfg: ExternalTranslatorConfig = {
      enabled: true,
      provider: 'gemini-api-key',
      endpoint,
      model: 'gemini-2.5-flash-lite',
      timeoutMs: 1000,
    };

    const truncatedFetcher: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'MAX_TOKENS',
              content: { parts: [{ text: '截断译文' }] },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    expect(translatorCircuit.remaining(endpoint) > 0).toBe(false);
    for (let i = 0; i < 3; i++) {
      await expect(translateWithExternalModel('Checking files.', cfg, truncatedFetcher)).rejects.toThrow(/截断|maxOutputTokens/);
    }
    // After 3 consecutive truncation failures, the circuit breaker MUST open!
    expect(translatorCircuit.remaining(endpoint) > 0).toBe(true);

    // Same for OpenAI refusal response
    const refusalEndpoint = 'http://127.0.0.1:19432';
    const openaiCfg: ExternalTranslatorConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: refusalEndpoint,
      model: 'gpt-4o-mini',
      timeoutMs: 1000,
    };
    const refusalFetcher: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '', refusal: 'Policy refusal' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    for (let i = 0; i < 3; i++) {
      await expect(translateWithExternalModel('Checking files.', openaiCfg, refusalFetcher)).rejects.toThrow(/拦截|中止|完整/);
    }
    expect(translatorCircuit.remaining(refusalEndpoint) > 0).toBe(true);
  });

  it('wraps readBoundedText body-stream timeout AbortError into a friendly timeout error in both callIndependentModelWithUsage and translateWithExternalModel', async () => {
    const makeSlowBodyFetcher = (): typeof fetch =>
      vi.fn(async (_input, init) => {
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('The operation was aborted', 'AbortError')),
              { once: true }
            );
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      });

    const reviewerCfg: ExternalAiReviewerConfig = {
      enabled: true,
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:19433',
      model: 'qwen2.5-coder:7b',
      timeoutMs: 100,
    };
    await expect(
      callIndependentModelWithUsage(reviewerCfg, 'Review', '{}', makeSlowBodyFetcher())
    ).rejects.toThrow(/超时/);

    const translatorCfg: ExternalTranslatorConfig = {
      enabled: true,
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:19434',
      model: 'qwen2.5:3b',
      timeoutMs: 100,
    };
    await expect(
      translateWithExternalModel('Hello world', translatorCfg, makeSlowBodyFetcher())
    ).rejects.toThrow(/超时/);
  });
});

/* ============================================================================
 * 6. B-P2-4: PluginsManager non-stderr error surfacing, tightened parseMcpList, lowercase skill.md
 * ========================================================================== */

describe('B-P2-4: PluginsManager error surfacing, MCP text parser tightening & lowercase skill.md', () => {
  it('executeOfficialCli surfaces ENOENT and stdout errors when stderr is empty', async () => {
    const dir = makeTempDir('gravity-v031-plugins-cli-');
    const missingBin = path.join(dir, 'definitely-missing-agy-binary');

    let enoentErr: Error | undefined;
    try {
      await executeOfficialCli(missingBin, ['plugin', 'list'], { shell: false, timeout: 5000 });
    } catch (err) {
      enoentErr = err as Error;
    }
    expect(enoentErr).toBeDefined();
    expect(enoentErr!.message).not.toBe('官方管理命令未成功完成');
    expect(enoentErr!.message).toMatch(/ENOENT|not found|无法|不存在/i);

    let stdoutErr: Error | undefined;
    try {
      await executeOfficialCli(
        process.execPath,
        ['-e', 'console.log("Plugin registry unreachable on stdout"); process.exit(1);'],
        { shell: false, timeout: 5000 }
      );
    } catch (err) {
      stdoutErr = err as Error;
    }
    expect(stdoutErr).toBeDefined();
    expect(stdoutErr!.message).toContain('Plugin registry unreachable on stdout');
  });

  it('tightens parseMcpList so plain Key: value informational headers are not misparsed as MCP servers', () => {
    const dir = makeTempDir('gravity-v031-plugins-mcp-');
    const manager = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store')),
      executor: vi.fn<CliExecutor>(async () => ({ stdout: '[]' })),
      homeDir: path.join(dir, 'home'),
    });

    const noisyHeaders = [
      'Note: No MCP servers configured yet',
      'Status: ready',
      'Warning: Deprecated config version',
      'Error: Failed to reach registry',
      'Version: 2.3.1',
      'Config: ~/.gemini/mcp.json',
      'Total: 0',
    ].join('\n');

    expect(manager.parseMcpList(noisyHeaders)).toEqual([]);

    // Valid table rows & valid legacy command/URL lines must still parse cleanly
    const validText = [
      'NAME       TYPE   STATUS   COMMAND/URL',
      'docs-mcp   http   enabled  https://docs.example.com/mcp',
      'fs-tool    stdio  disabled node server.js',
    ].join('\n');
    expect(manager.parseMcpList(validText)).toMatchObject([
      { name: 'docs-mcp', type: 'http', enabled: true, commandOrUrl: 'https://docs.example.com/mcp' },
      { name: 'fs-tool', type: 'stdio', enabled: false, commandOrUrl: 'node server.js' },
    ]);
  });

  it('discovers lowercase skill.md files inside workspace and global skill directories', async () => {
    const dir = makeTempDir('gravity-v031-plugins-skill-');
    const workspace = path.join(dir, 'workspace');
    const lowerSkillPath = path.join(workspace, '.agents', 'skills', 'lower-case-skill', 'skill.md');
    mkdirSync(path.dirname(lowerSkillPath), { recursive: true });
    writeFileSync(
      lowerSkillPath,
      '---\nname: Lowercase Skill\ndescription: Works regardless of filename casing\n---\nInstructions here.\n',
      'utf8'
    );

    const manager = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store')),
      executor: vi.fn<CliExecutor>(async (_bin, args) => ({
        stdout: args[0] === 'plugin' ? JSON.stringify({ plugins: [] }) : JSON.stringify({ mcpServers: {} }),
      })),
      homeDir: path.join(dir, 'home'),
    });

    const snapshot = await manager.getSnapshot(workspace);
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]).toMatchObject({
      name: 'Lowercase Skill',
      description: 'Works regardless of filename casing',
      scope: 'workspace',
      enabled: true,
    });
  });
});

/* ============================================================================
 * 7. B-P2-5: canEnforceCurlLimit survives empty ;; entries in PATH
 * ========================================================================== */

describe('B-P2-5: canEnforceCurlLimit survives empty ;; entries in PATH', () => {
  it.runIf(process.platform === 'win32')(
    'continues scanning PATH across empty ;; segments and finds valid curl.exe >= 8.4',
    () => {
      const root = makeTempDir('gravity-v031-curl-path-');
      const workspace = path.join(root, 'workspace');
      const emptyDir = path.join(root, 'empty-bin');
      const curlBinDir = path.join(root, 'curl-bin');
      const cleanHome = path.join(root, 'clean-home');
      const fakeSystemRoot = path.join(root, 'fake-win');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(emptyDir, { recursive: true });
      mkdirSync(curlBinDir, { recursive: true });
      mkdirSync(cleanHome, { recursive: true });
      mkdirSync(fakeSystemRoot, { recursive: true });

      writeFileSync(path.join(curlBinDir, 'curl.exe'), createSyntheticCurlExe(8, 10));

      vi.stubEnv('CURL_HOME', cleanHome);
      vi.stubEnv('HOME', cleanHome);
      vi.stubEnv('USERPROFILE', cleanHome);
      vi.stubEnv('APPDATA', cleanHome);
      vi.stubEnv('XDG_CONFIG_HOME', cleanHome);
      vi.stubEnv('SystemRoot', fakeSystemRoot);
      vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');

      // Control check: clean PATH finds synthetic curl.exe 8.10
      vi.stubEnv('PATH', curlBinDir);
      expect(
        canEnforceCurlLimit('curl', ['--max-filesize', '1048576', 'https://example.com/a.bin'], workspace, workspace)
      ).toBe(true);

      // With empty ;; segments before curlBinDir, scanning MUST NOT abort early
      vi.stubEnv('PATH', `${emptyDir};;${curlBinDir}`);
      expect(
        canEnforceCurlLimit('curl', ['--max-filesize', '1048576', 'https://example.com/a.bin'], workspace, workspace)
      ).toBe(true);

      // Leading semicolon ;; should also survive cleanly
      vi.stubEnv('PATH', `;${curlBinDir}`);
      expect(
        canEnforceCurlLimit('curl', ['--max-filesize', '1048576', 'https://example.com/a.bin'], workspace, workspace)
      ).toBe(true);
    }
  );
});

/* ============================================================================
 * 8. B-P2-6: processPerSession preference change takes effect on subsequent ACP reconnect
 * ========================================================================== */

describe('B-P2-6: processPerSession update while connected takes effect on subsequent ACP reconnect', () => {
  it('propagates processPerSession toggles made while connected to the next ACP spawn args', async () => {
    const dir = makeTempDir('gravity-v031-pps-');
    const spawnedArgs: string[][] = [];
    const spawnSpy = vi.fn((_binary: string, args: string[]) => {
      spawnedArgs.push([...args]);
      return new FakeSpawnChild();
    });

    const core = new CoreService({
      dataDir: dir,
      homeDir: path.join(dir, 'home'),
      acpOptions: { binaryPath: 'agy', spawn: spawnSpy },
    });
    services.push(core);

    // 1) Initial connect with processPerSession = false
    await core.createSession({ cwd: dir });
    expect(core.client.connected).toBe(true);
    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0]).toEqual(['acp']);

    // 2) Toggle processPerSession -> true WHILE connected
    await core.updatePreferences({ processPerSession: true });

    // Disconnect and reconnect
    await core.client.stop();
    await core.client.start();
    expect(spawnedArgs).toHaveLength(2);
    expect(spawnedArgs[1]).toContain('--process-per-session');

    // 3) Toggle processPerSession -> false WHILE connected
    await core.updatePreferences({ processPerSession: false });
    await core.client.stop();
    await core.client.start();
    expect(spawnedArgs).toHaveLength(3);
    expect(spawnedArgs[2]).not.toContain('--process-per-session');
  });
});
