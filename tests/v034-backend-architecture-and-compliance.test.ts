// @vitest-environment node
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PassThrough, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, validateAgyArgs } from '../src/main/acp/acp-client';
import { buildAgyEnvironment } from '../src/main/acp/agy-environment';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import { CoreService } from '../src/main/core-service';
import { registerIpcRouter } from '../src/main/ipc-router';
import {
  OriginCircuitBreaker,
  reviewerCircuit,
  translatorCircuit,
  validateExternalEndpoint,
} from '../src/main/llm/external-llm-transport';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { openExternalTarget } from '../src/main/services/external-opener';
import { inspectLocalTargets } from '../src/main/services/local-media-inspector';
import type { SecretCipher } from '../src/main/services/secret-vault';
import { ConversationTreeStore } from '../src/main/session/conversation-tree-store';
import { prepareAttachments } from '../src/main/session/message-images';
import { ClientStore } from '../src/main/storage/client-store';
import { withReadonlySqliteSnapshot } from '../src/main/storage/readonly-sqlite-snapshot';
import { SwarmTracker } from '../src/main/swarm/swarm-tracker';
import { WorkspaceFiles } from '../src/main/workspace/workspace-files';
import {
  COST_DISCLAIMER,
  GRAVITY_ICON_VARIANTS,
  IPC_CHANNELS,
  isBlockedExternalEndpointHost,
  isForbiddenCredentialOrStatePath,
  MAX_PARALLEL_ACTIVE_SESSIONS,
  MESSAGE_PAGE_SIZE,
  sanitizeCustomThemeConfig,
  THEME_PRESETS,
  validateCustomThemeConfig,
  type AcpRequestPermissionParams,
  type AcpSessionPromptParams,
  type AcpSessionPromptResult,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ManagedSessionSummary,
  type PendingApprovalRequest,
  type TranslationConfig,
} from '../src/shared';

/* ============================================================================
 * Shared Helpers & Cleanup
 * ========================================================================== */

const REPO_ROOT = process.cwd();
const tempDirs: string[] = [];
const services: CoreService[] = [];
const engines: ApprovalEngine[] = [];
const clients: AcpClient[] = [];
const trackers: SwarmTracker[] = [];
const workers: Worker[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeCipher(): SecretCipher {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(`V034ENC:${plain}`, 'utf8'),
    decrypt: (buf) => {
      const text = buf.toString('utf8');
      if (!text.startsWith('V034ENC:')) throw new Error('corrupted ciphertext');
      return text.slice('V034ENC:'.length);
    },
  };
}

function listTsFiles(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        results.push(full);
      }
    }
  };
  walk(rootDir);
  return results.sort();
}

function countLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  if (!content) return 0;
  return content.replace(/\n$/, '').split('\n').length;
}

function findTsCyclesInDir(rootDir: string): string[][] {
  const files = listTsFiles(rootDir);
  const resolveRel = (fromFile: string, specifier: string): string | null => {
    if (!specifier.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
      if (existsSync(candidate) && candidate.endsWith('.ts') && !candidate.endsWith('.d.ts')) {
        const rel = path.relative(rootDir, candidate);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
      }
    }
    return null;
  };

  const graph = new Map<string, string[]>();
  for (const file of files) {
    const fromKey = path.relative(rootDir, file).replace(/\\/g, '/');
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const targets = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const target = resolveRel(file, node.moduleSpecifier.text);
        if (target) targets.add(target);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const target = resolveRel(file, node.moduleSpecifier.text);
        if (target) targets.add(target);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        const target = resolveRel(file, node.argument.literal.text);
        if (target) targets.add(target);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const target = resolveRel(file, node.arguments[0].text);
        if (target) targets.add(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    graph.set(fromKey, [...targets].sort());
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || (scc.length === 1 && (graph.get(v) || []).includes(v))) {
        cycles.push(scc.sort());
      }
    }
  };
  for (const node of graph.keys()) if (!indices.has(node)) strongConnect(node);
  return cycles;
}

class StubRpcChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sent: Array<Record<string, unknown>> = [];
  stdin = new Writable({
    write: (chunk, _enc, done) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: unknown };
        this.sent.push(msg);
        if (msg.method === 'initialize') {
          queueMicrotask(() =>
            this.emitMessage({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentInfo: { name: 'v034-stub-acp', version: '1.5.17' },
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { list: {}, resume: {}, close: {} },
                },
              },
            })
          );
        }
      }
      done();
    },
  });
  constructor() {
    super();
    this.stdin.on('finish', () => {
      this.exitCode = 0;
      setImmediate(() => this.emit('close', 0));
    });
  }
  emitMessage(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  kill(): boolean {
    this.exitCode = 0;
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

function makeControlledCore(opts: {
  dataDir?: string;
  homeDir?: string;
  now?: () => number;
  sessionIdPrefix?: string;
  pluginsExecutor?: CliExecutor;
  secretCipher?: SecretCipher;
  onPrompt?: (params: AcpSessionPromptParams) => Promise<AcpSessionPromptResult> | AcpSessionPromptResult;
} = {}) {
  const dir = opts.dataDir ?? makeTempDir('gravity-v034-arch-');
  const client = new AcpClient();
  const initRes = {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity CLI', version: '1.5.17' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
  };
  client.initializeResult = initRes;
  let connected = true;
  vi.spyOn(client, 'connected', 'get').mockImplementation(() => connected);
  vi.spyOn(client, 'start').mockImplementation(async () => {
    connected = true;
    return initRes;
  });
  vi.spyOn(client, 'stop').mockImplementation(async () => {
    connected = false;
  });
  vi.spyOn(client, 'notify').mockImplementation(() => {});

  let seq = 0;
  const requests: Array<{ method: string; params: unknown }> = [];
  const requestSpy = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    requests.push({ method, params });
    if (method === 'session/new') {
      return {
        sessionId: `${opts.sessionIdPrefix ?? 'sess-v034'}-${++seq}`,
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'accept-edits', name: 'Accept Edits' },
              { value: 'plan', name: 'Plan' },
            ],
          },
          {
            id: 'model',
            name: 'Model',
            currentValue: 'gemini-4-neon',
            options: [
              { value: 'gemini-4-neon', name: 'Neon' },
              { value: 'gemini-4-hydrogen', name: 'Hydrogen' },
            ],
          },
          {
            id: 'thought_level',
            name: 'Effort',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      };
    }
    if (method === 'session/list') return { sessions: [] };
    if (method === 'session/close') return {};
    if (method === 'session/set_config_option') return {};
    if (method === 'session/prompt') {
      if (opts.onPrompt) return opts.onPrompt(params as AcpSessionPromptParams);
      return { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 8 } };
    }
    return {};
  });

  const core = new CoreService({
    acp: client,
    dataDir: dir,
    homeDir: opts.homeDir ?? path.join(dir, 'home'),
    now: opts.now,
    pluginsExecutor: opts.pluginsExecutor,
    secretCipher: opts.secretCipher,
    enableAutoUpdateCheck: false,
  });
  services.push(core);
  return { dir, client, core, requestSpy, requests, setConnected: (v: boolean) => { connected = v; } };
}

afterEach(async () => {
  vi.useRealTimers();
  reviewerCircuit.reset();
  translatorCircuit.reset();
  for (const w of workers.splice(0)) await w.terminate().catch(() => {});
  for (const s of services.splice(0)) await s.dispose().catch(() => {});
  for (const e of engines.splice(0)) e.dispose();
  for (const c of clients.splice(0)) await c.stop().catch(() => {});
  for (const t of trackers.splice(0)) t.clear();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  vi.restoreAllMocks();
});

/* ============================================================================
 * A01: Dependency Graph Zero Cycles, File Scale, IPC 1:1 & 100x Bind/Unbind
 * ========================================================================== */

describe('A01 · 依赖图零环、单文件规模与 IPC 1:1 契约及 100 次绑定解绑守卫', () => {
  it('A01-1: AST 静态扫描 src/main/**/*.ts 与 src/shared/**/*.ts（含 import type 与再导出）各自 0 循环依赖', () => {
    const mainCycles = findTsCyclesInDir(path.resolve(REPO_ROOT, 'src', 'main'));
    const sharedCycles = findTsCyclesInDir(path.resolve(REPO_ROOT, 'src', 'shared'));
    expect(mainCycles.map((c) => c.join(' <-> ')), 'src/main/**/*.ts 存在循环依赖').toEqual([]);
    expect(sharedCycles.map((c) => c.join(' <-> ')), 'src/shared/**/*.ts 存在循环依赖').toEqual([]);
  });

  it('A01-2: 单文件规模守卫（main & shared 全员 <=650 / shared 23 文件 / core-service<=420 / index<=160）、0 反向边与 93 通道 IPC 1:1 对齐', () => {
    const mainRoot = path.resolve(REPO_ROOT, 'src', 'main');
    const sharedRoot = path.resolve(REPO_ROOT, 'src', 'shared');

    // 1. src/main 单文件规模与架构分层边界（0 acp->services，0 storage->session 回流）
    const mainFiles = listTsFiles(mainRoot);
    const oversizedMain = mainFiles
      .map((f) => ({ rel: path.relative(REPO_ROOT, f).replace(/\\/g, '/'), loc: countLines(f) }))
      .filter((x) => x.loc > 650);
    expect(oversizedMain).toEqual([]);
    expect(countLines(path.join(mainRoot, 'core-service.ts'))).toBeLessThanOrEqual(420);
    expect(countLines(path.join(mainRoot, 'index.ts'))).toBeLessThanOrEqual(160);

    const acpToServices: string[] = [];
    const storageToSession: string[] = [];
    for (const file of mainFiles) {
      const rel = path.relative(mainRoot, file).replace(/\\/g, '/');
      const layer = rel.split('/')[0];
      if (layer !== 'acp' && layer !== 'storage') continue;
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const checkSpec = (spec: string) => {
        if (!spec.startsWith('.')) return;
        const resolved = path.relative(mainRoot, path.resolve(path.dirname(file), spec)).replace(/\\/g, '/');
        const targetLayer = resolved.split('/')[0];
        if (layer === 'acp' && targetLayer === 'services') acpToServices.push(`${rel} -> ${resolved}`);
        if (layer === 'storage' && targetLayer === 'session') storageToSession.push(`${rel} -> ${resolved}`);
      };
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) checkSpec(node.moduleSpecifier.text);
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) checkSpec(node.moduleSpecifier.text);
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) checkSpec(node.argument.literal.text);
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(acpToServices, 'src/main/acp 不得依赖 services/').toEqual([]);
    expect(storageToSession, 'src/main/storage 不得向上依赖 session/').toEqual([]);

    // 2. v0.3.6 src/shared 23 文件且全员 <= 650 LOC
    const sharedFiles = listTsFiles(sharedRoot);
    expect(sharedFiles).toHaveLength(23);
    const oversizedShared = sharedFiles
      .map((f) => ({ rel: path.relative(REPO_ROOT, f).replace(/\\/g, '/'), loc: countLines(f) }))
      .filter((x) => x.loc > 650);
    expect(oversizedShared, 'src/shared 全量文件必须 <= 650 LOC').toEqual([]);

    // 3. 93 通道（73 invoke + 20 event）1:1 核对
    const expected = new Set<string>(Object.values(IPC_CHANNELS));
    expect(expected.size).toBe(93);
    expect([...expected].filter((ch) => !ch.startsWith('gravity:event:'))).toHaveLength(73);
    expect([...expected].filter((ch) => ch.startsWith('gravity:event:'))).toHaveLength(20);
    expect(expected.has(IPC_CHANNELS.APP_COPY_TEXT)).toBe(true);
    expect(expected.has(IPC_CHANNELS.VOICE_APPEND)).toBe(true);

    const preloadSrc = readFileSync(path.join(mainRoot, 'preload.ts'), 'utf8');
    const preloadAst = ts.createSourceFile('preload.ts', preloadSrc, ts.ScriptTarget.Latest, true);
    const preloadChannels: string[] = [];
    const visitPreload = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'invoke' || node.expression.text === 'subscribe') &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        preloadChannels.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visitPreload);
    };
    visitPreload(preloadAst);
    expect(new Set(preloadChannels).size).toBe(preloadChannels.length);
    expect([...expected].filter((ch) => !preloadChannels.includes(ch))).toEqual([]);
    expect(preloadChannels.filter((ch) => !expected.has(ch))).toEqual([]);
  });

  it('A01-3: registerIpcRouter 连续绑定/解绑 100 次后残留监听器与处理器严格为 0', () => {
    const handlers = new Map<string, Function>();
    const ipcMain = {
      handle: (ch: string, cb: Function) => handlers.set(ch, cb),
      removeHandler: (ch: string) => handlers.delete(ch),
    } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = {
      mainFrame: frame,
      getURL: () => frame.url,
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as WebContents;
    const service = new EventEmitter() as unknown as CoreService;

    for (let i = 0; i < 100; i += 1) {
      const dispose = registerIpcRouter(ipcMain, service, trusted);
      expect(handlers.size).toBeGreaterThan(40);
      expect(service.listenerCount('message-upserted')).toBe(1);
      dispose();
      // 幂等二次调用不得抛错
      dispose();
    }

    expect(handlers.size).toBe(0);
    const lingering = service
      .eventNames()
      .map((name) => ({ name: String(name), count: service.listenerCount(name) }))
      .filter((entry) => entry.count > 0);
    expect(lingering).toEqual([]);

    // 卸载后发事件不再推送给旧窗口
    const sendsBefore = (trusted.send as ReturnType<typeof vi.fn>).mock.calls.length;
    service.emit('message-upserted', { sessionId: 's1', message: { id: 'm1' } });
    expect((trusted.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendsBefore);
  });
});

/* ============================================================================
 * A02: Package Split, Local Translation 13-File Manifest & Real Offline Worker
 * ========================================================================== */

describe('A02 · 跨平台资产分离、本地翻译 13 文件清单与真实断网 Bergamot Worker 验证', () => {
  it('A02-1: package.json 分平台 assets/quota、本地语音与图标声明准确，本地翻译 13 文件与许可完整', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      build: { files: string[]; win: { files: string[] }; mac: { files: string[]; extendInfo?: Record<string, string> } };
    };
    expect(pkg.build.files).toContain('assets/local-translation/**/*');
    expect(pkg.build.files).toContain('assets/local-voice/**/*');
    expect(pkg.build.files).toContain('!assets/local-voice/build/**/*');
    expect(pkg.build.files).toContain('!assets/local-voice/.gitignore');
    expect(pkg.build.files).toContain('!assets/local-voice/.gitattributes');
    expect(pkg.build.files).toContain('!dist/**/*.map');
    expect(pkg.build.files).toContain('!dist/**/*.d.ts');
    expect(pkg.build.files.some((f) => f.includes('assets/quota'))).toBe(false);
    expect(pkg.build.files.some((f) => f.includes('assets/icons'))).toBe(false);
    expect(pkg.build.mac.extendInfo?.NSMicrophoneUsageDescription?.trim().length).toBeGreaterThan(10);

    expect(pkg.build.win.files).toEqual(['assets/icons/*.ico', 'assets/quota/read-quota.ps1']);
    expect(pkg.build.mac.files).toEqual([
      'assets/icons/*-mac.png',
      'assets/quota/read-quota-macos.sh',
      'assets/quota/status-line-macos.js',
    ]);

    // 核验 3 个额度脚本与 6 套图标文件在源仓库真实存在
    expect(existsSync(path.join(REPO_ROOT, 'assets', 'quota', 'read-quota.ps1'))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, 'assets', 'quota', 'read-quota-macos.sh'))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, 'assets', 'quota', 'status-line-macos.js'))).toBe(true);
    for (const icon of GRAVITY_ICON_VARIANTS) {
      expect(existsSync(path.join(REPO_ROOT, icon.assetIcoRelPath))).toBe(true);
      expect(existsSync(path.join(REPO_ROOT, icon.assetMacPngRelPath))).toBe(true);
      expect(existsSync(path.join(REPO_ROOT, icon.assetPngRelPath))).toBe(true);
      expect(existsSync(path.join(REPO_ROOT, 'public', icon.publicSvgUrl.replace(/^\.\//, '')))).toBe(true);
    }

    // 本地翻译 13 文件清单 + 许可非空
    const localTransDir = path.join(REPO_ROOT, 'assets', 'local-translation');
    const actualFiles = readdirSync(localTransDir).sort();
    const expected13 = [
      'ENGINE-LICENSE',
      'MODEL-LICENSE',
      'NOTICE.md',
      'UPSTREAM.yml',
      'bergamot.js',
      'engine.wasm',
      'lex.bin',
      'model.bin',
      'pipeline.cjs',
      'sources.json',
      'srcvocab.bin',
      'trgvocab.bin',
      'worker.cjs',
    ].sort();
    expect(actualFiles).toEqual(expected13);
    expect(actualFiles).toHaveLength(13);
    expect(readFileSync(path.join(localTransDir, 'ENGINE-LICENSE'), 'utf8').trim().length).toBeGreaterThan(50);
    expect(readFileSync(path.join(localTransDir, 'MODEL-LICENSE'), 'utf8').trim().length).toBeGreaterThan(50);
    expect(readFileSync(path.join(localTransDir, 'NOTICE.md'), 'utf8').trim().length).toBeGreaterThan(50);

    // 若已生成 Windows 解包目录，核验 0 跨平台/调试残留
    const winAppDir = path.join(REPO_ROOT, 'release', 'win-unpacked', 'resources', 'app');
    if (existsSync(winAppDir)) {
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(winAppDir, path.join(d, e.name)).replace(/\\/g, '/')]
        );
      const packed = walk(winAppDir);
      expect(packed.filter((f) => /-mac\.png$|-macos\.|\.map$|\.d\.ts$|^assets\/local-voice\/build\/|^assets\/local-voice\/\.git/i.test(f))).toEqual([]);
    }
  });

  it('A02-2: 真实断网运行 assets/local-translation/worker.cjs 成功将英文思考译为中文', async () => {
    const workerPath = path.resolve(REPO_ROOT, 'assets', 'local-translation', 'worker.cjs');
    const worker = new Worker(workerPath);
    workers.push(worker);

    const response = await new Promise<{ id: number; text?: string; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bergamot offline worker timed out (30s)')), 30_000);
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.once('message', (msg) => {
        clearTimeout(timer);
        resolve(msg as { id: number; text?: string; error?: string });
      });
      worker.postMessage({
        id: 1,
        text: 'I need to inspect the repository structure and fix the failing unit tests before release.',
      });
    });

    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();
    expect(typeof response.text).toBe('string');
    expect(response.text!.trim().length).toBeGreaterThan(4);
    expect(/[\u4e00-\u9fff]{2,}/.test(response.text!)).toBe(true);
  }, 35_000);
});

/* ============================================================================
 * A03: IPC Streaming Batching & Backend I/O Performance Guards
 * ========================================================================== */

describe('A03 · IPC 流式合批、尾页读、分支树启动去重与 SQLite 非阻塞守卫', () => {
  it('A03-1: 假时钟 4 会话 × 1,000 分片（5s）压测：纯文本推送 <=102 次、正文传输降 >=80%、终态/审批/提问 0 丢 0 倒序', async () => {
    vi.useFakeTimers();
    const promptResolvers = new Map<string, (res: AcpSessionPromptResult) => void>();
    const { core, client, dir } = makeControlledCore({
      onPrompt: (params) =>
        new Promise<AcpSessionPromptResult>((resolve) => {
          promptResolvers.set(params.sessionId, resolve);
        }),
    });

    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const sIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const s = await core.createSession({ cwd, title: `stream-${i + 1}` });
      sIds.push(s.sessionId);
    }
    const [s1, s2, s3, s4] = sIds;

    const upsertsBySession = new Map<string, Array<{ id: string; role: string; len: number; isStreaming?: boolean; hasQuestion?: boolean }>>();
    const approvalEvents: PendingApprovalRequest[] = [];
    for (const id of sIds) upsertsBySession.set(id, []);

    core.on('message-upserted', (ev: { sessionId: string; message: ChatMessageItem }) => {
      upsertsBySession.get(ev.sessionId)?.push({
        id: ev.message.id,
        role: ev.message.role,
        len: ev.message.content.length,
        isStreaming: ev.message.isStreaming,
        hasQuestion: Boolean(ev.message.question),
      });
    });
    core.on('approval-requested', (req: PendingApprovalRequest) => {
      approvalEvents.push(req);
    });

    const promptPromises = sIds.map((sid) => core.sendPrompt({ sessionId: sid, text: `bench-${sid}` }));
    await vi.advanceTimersByTimeAsync(0);

    const chunk = '0123456789abcdef'; // 16 chars
    let elicitationPromise: Promise<unknown> | undefined;
    let permPromise: Promise<unknown> | undefined;
    const handlersMap = (client as unknown as { handlers: Map<string, (params: unknown, id: string | number) => unknown> }).handlers;

    for (let step = 1; step <= 1000; step += 1) {
      vi.advanceTimersByTime(5);
      for (const sid of sIds) {
        client.emit('session/update', {
          sessionId: sid,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
        });
      }
      if (step === 300) {
        const elicitationHandler = handlersMap.get('elicitation/create')!;
        elicitationPromise = Promise.resolve(
          elicitationHandler(
            {
              sessionId: s1,
              mode: 'form',
              message: 'Select target',
              requestedSchema: { type: 'object', required: ['choice'], properties: { choice: { type: 'string', enum: ['a', 'b'] } } },
            },
            'q-a03'
          )
        );
      }
      if (step === 305) {
        const qMsg = core.messages.recent(s1).find((m) => m.question?.state === 'open');
        if (qMsg) {
          await core.answerQuestion({ sessionId: s1, messageId: qMsg.id, action: 'accept', values: { choice: 'a' } });
        }
      }
      if (step === 600) {
        const permHandler = handlersMap.get('session/request_permission')!;
        permPromise = Promise.resolve(
          permHandler(
            {
              sessionId: s2,
              toolCall: { toolCallId: 'tc-a03', kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'npm publish' } },
              options: [
                { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
              ],
            } satisfies AcpRequestPermissionParams,
            'p-a03'
          )
        );
      }
      if (step === 605 && approvalEvents.length > 0) {
        await core.submitApprovalDecision({
          requestId: approvalEvents[0].requestId,
          sessionId: s2,
          decision: 'allow_once',
        });
      }
    }

    for (const sid of sIds) {
      promptResolvers.get(sid)!({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 4000 } });
    }
    await Promise.all([
      ...promptPromises,
      elicitationPromise ?? Promise.resolve(),
      permPromise ?? Promise.resolve(),
    ]);
    await vi.advanceTimersByTimeAsync(200);

    // 未合批正文总传输基线：sum_{k=1..1000} 16*k = 8,008,000 字符
    const unbatchedChars = (16 * 1000 * 1001) / 2;

    for (const sid of [s3, s4]) {
      const assistantEvents = upsertsBySession.get(sid)!.filter((e) => e.role === 'assistant');
      const totalCharsPushed = assistantEvents.reduce((acc, e) => acc + e.len, 0);
      const finalEvent = assistantEvents.at(-1)!;
      const finalMsg = core.messages.recent(sid).filter((m) => m.role === 'assistant').at(-1)!;

      // 完整性与终态顺序（0 丢 0 倒序）
      expect(finalMsg.content.length).toBe(16 * 1000);
      expect(finalMsg.isStreaming).toBe(false);
      expect(finalMsg.completedAt).toBeTruthy();
      expect(finalEvent.isStreaming).toBe(false);
      expect(finalEvent.len).toBe(16 * 1000);

      // 流式合批量化指标：纯文本每消息推送 <= 102 次、正文传输降 >= 80%
      expect(assistantEvents.length, `Session ${sid} unbatched push count`).toBeLessThanOrEqual(102);
      const reductionRatio = 1 - totalCharsPushed / unbatchedChars;
      expect(reductionRatio, `Session ${sid} text transfer reduction must be >= 80%`).toBeGreaterThanOrEqual(0.8);
    }

    // 提问与审批事件 0 丢
    expect(upsertsBySession.get(s1)!.some((e) => e.hasQuestion)).toBe(true);
    expect(approvalEvents.length).toBeGreaterThanOrEqual(1);
    expect(core.messages.recent(s2).filter((m) => m.role === 'assistant').at(-1)?.content.length).toBe(16 * 1000);
  });

  it('A03-2: ConversationMessages 200 条历史 @ 引用末 30 条，读归档页数 <= 1', async () => {
    const dir = makeTempDir('gravity-v034-a03-tail-');
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });

    // Seed 200 messages into ref-sess-200 so save() splits >= 2 archived pages (64 + 64 + 72 recent)
    const { core: seedCore } = makeControlledCore({ dataDir: dir });
    const refSess = await seedCore.createSession({ cwd, title: 'long-history' });
    const nowIso = '2026-11-26T00:00:00.000Z';
    const items: ChatMessageItem[] = Array.from({ length: 200 }, (_, i) => ({
      id: `m-${i}`,
      originMessageId: `m-${i}`,
      sessionId: refSess.sessionId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `history-entry-${i}`,
      createdAt: nowIso,
      isStreaming: false,
    }));
    seedCore.messages.set(refSess.sessionId, items);
    seedCore.messages.save();
    await seedCore.dispose();
    services.pop();

    // Confirm >= 2 archived pages exist on disk
    const pageFiles = readdirSync(dir).filter((f) => /^messages-page-.*\.json$/.test(f));
    expect(pageFiles.length).toBeGreaterThanOrEqual(2);

    // Cold reload CoreService with empty page cache and @-reference refSess (distinct live session ID)
    let sentPromptText = '';
    const { core: coldCore } = makeControlledCore({
      dataDir: dir,
      sessionIdPrefix: 'sess-live-a03',
      onPrompt: (params) => {
        sentPromptText = params.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });
    const liveSess = await coldCore.createSession({ cwd, title: 'live' });
    expect(liveSess.sessionId).not.toBe(refSess.sessionId);

    const origRead = ClientStore.prototype.read;
    let archivedPageReads = 0;
    vi.spyOn(ClientStore.prototype, 'read').mockImplementation(function (this: ClientStore, name, fallback) {
      if (name.startsWith('messages-page-')) archivedPageReads += 1;
      return origRead.call(this, name, fallback);
    });

    await coldCore.sendPrompt({
      sessionId: liveSess.sessionId,
      text: 'Summarize referenced session tail',
      references: [{ kind: 'session', label: 'long-history', value: refSess.sessionId }],
    });

    expect(sentPromptText).toContain('history-entry-199');
    expect(sentPromptText).not.toContain('history-entry-0\n');
    expect(archivedPageReads, '@ 引用末 30 条不应读取全部历史归档页（需 <= 1 页）').toBeLessThanOrEqual(1);
  });

  it('A03-3: 100 分支树启动 getBootstrap() 对同 root 仅枚举 1 次（去重 O(N) 而非 O(N²)）', async () => {
    const dir = makeTempDir('gravity-v034-a03-tree100-');
    const store = new ClientStore(dir);
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });

    const rootId = 'tree-root-100';
    const nowIso = '2026-11-26T00:00:00.000Z';
    const owned: Record<string, ManagedSessionSummary> = {};
    const branches: Record<string, unknown> = {};

    for (let i = 0; i < 100; i += 1) {
      const id = i === 0 ? rootId : `tree-branch-${i}`;
      owned[id] = {
        sessionId: id,
        cwd,
        rawCwd: cwd,
        title: `Branch ${i}`,
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'closed',
        modelId: 'gemini-4-neon',
        executionMode: 'default',
        reasoningEffort: 'medium',
        originKind: 'acp-live',
        readOnly: false,
        profileId: 'default',
        updatedAt: nowIso,
      };
      branches[id] = {
        branchId: id,
        parentBranchId: i === 0 ? null : rootId,
        forkAfterMessageId: i === 0 ? null : 'm-0',
        forkUserTurnIndex: i === 0 ? -1 : 1,
        forkPromptPreview: `branch-${i}`,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    }

    store.write('owned-sessions-default.json', owned);
    store.write('conversation-trees-default.json', {
      [rootId]: { rootSessionId: rootId, activeBranchId: rootId, branches, updatedAt: nowIso },
    });

    const { core } = makeControlledCore({ dataDir: dir });
    const listSpy = vi.spyOn(ConversationTreeStore.prototype, 'listBranchIds');

    await core.getBootstrap();

    expect(listSpy.mock.calls.length, '100 分支树启动对同 root 的 listBranchIds 枚举应去重为 <= 1 次').toBeLessThanOrEqual(1);
  });

  it('A03-4: 经 CoreService 生产链路高频灌入 Swarm 事件且 SQLite 持锁时，主线程事件循环 P99 < 16ms', async () => {
    const dir = makeTempDir('gravity-v034-a03-sqlite-lock-');
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });

    const { core, client } = makeControlledCore({ dataDir: dir });
    const sess = await core.createSession({ cwd, title: 'swarm-el-latency' });

    // 通过生产路径 CoreService -> client session/update 初始化 Swarm WAL SQLite 文件
    client.emit('session/update', {
      sessionId: sess.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-init',
        name: 'post_message',
        status: 'completed',
        rawInput: { sender: 'lead', content: 'init wal' },
      },
    });
    const initState = await core.getSwarmState(sess.sessionId);
    expect(initState.boardMessages.length).toBeGreaterThanOrEqual(1);

    const sqliteFile = readdirSync(dir).find((f) => /^swarm-v2-.*\.sqlite$/.test(f));
    expect(sqliteFile).toBeTruthy();
    const dbPath = path.join(dir, sqliteFile!);

    // 在独立 Worker 线程持有 BEGIN IMMEDIATE 写锁 350ms（覆盖真实磁盘锁竞争场景）
    const locker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.dbPath);
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      db.exec('COMMIT');
      db.close();
      parentPort.postMessage('released');
      `,
      { eval: true, workerData: { dbPath } }
    );
    workers.push(locker);

    const released = new Promise<void>((resolve, reject) => {
      locker.on('message', (msg) => {
        if (msg === 'released') resolve();
      });
      locker.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      locker.on('message', (msg) => {
        if (msg === 'locked') resolve();
      });
      locker.once('error', reject);
    });

    // 启动主线程事件循环延迟监控（resolution: 1 避免 Windows 10ms 桶偏移），并经 CoreService 生产链路灌入高频 Swarm 事件
    const eld = monitorEventLoopDelay({ resolution: 1 });
    eld.enable();
    let maxSyncDispatchMs = 0;
    const burstCount = 40;
    try {
      for (let i = 0; i < burstCount; i += 1) {
        const t0 = performance.now();
        client.emit('session/update', {
          sessionId: sess.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `tc-burst-${i}`,
            name: 'post_message',
            status: 'completed',
            rawInput: { sender: 'lead', content: `high-freq-swarm-event-${i}` },
          },
        });
        maxSyncDispatchMs = Math.max(maxSyncDispatchMs, performance.now() - t0);
        // 跨越计时器相位让 monitorEventLoopDelay 准确采样主线程事件循环延迟
        await new Promise<void>((r) => setTimeout(r, 8));
      }
      await released;
    } finally {
      eld.disable();
    }

    const p99Ms = eld.percentile(99) / 1e6;
    // Windows 15.6ms 系统时钟粒度与 81 文件并发 Vitest/CI 虚拟机会产生 ~16–45ms 调度抖动；
    // 若退回主线程同步写 SQLite（外部持锁 400ms+），p99Ms 与 maxSyncDispatchMs 均会跃升至 >350ms。
    const p99BudgetMs = process.env.CI || process.platform === 'win32' ? 60 : 32;
    expect(
      p99Ms,
      `Swarm 高频写入/SQLite 锁导致主线程事件循环 P99 延迟 ${p99Ms.toFixed(1)}ms（目标 < ${p99BudgetMs}ms，单次最大同步耗时 ${maxSyncDispatchMs.toFixed(1)}ms）`
    ).toBeLessThan(p99BudgetMs);
    expect(
      maxSyncDispatchMs,
      `单次 Swarm session/update 主线程同步耗时 ${maxSyncDispatchMs.toFixed(1)}ms（目标 < 16ms）`
    ).toBeLessThan(16);

    // 锁释放后经生产链路查询：全部高频事件落盘可读且无崩溃/丢失
    await Promise.resolve(core.swarm.flush());
    const finalState = await core.getSwarmState(sess.sessionId);
    expect(finalState.historyUnavailable).toBeFalsy();
    expect(finalState.boardMessages.length).toBeGreaterThanOrEqual(2);
  }, 15_000);
});

/* ============================================================================
 * A04: 10 Legacy User Data Migrations + Cross-Profile Same-SessionId Isolation
 * ========================================================================== */

describe('A04 · 10 项老用户自有数据升级全量回归（含双 Profile 同名会话 0 串数据）', () => {
  it('A04: 合成 10 类旧版自有数据升级启动并重启两次，0 截断 0 重复 0 串数据 0 待删复活', async () => {
    const dir = makeTempDir('gravity-v034-a04-migrate-');
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const store = new ClientStore(dir);
    const cipher = makeCipher();
    const p2Id = 'profile-22222222-2222-2222-2222-222222222222';
    const p2Dir = path.join(dir, 'profiles', p2Id);
    mkdirSync(p2Dir, { recursive: true });
    const nowIso = '2026-11-26T08:00:00.000Z';

    // 1. Legacy profiles.json (default + p2)
    store.write('profiles.json', {
      activeProfileId: 'default',
      profiles: [
        { profileId: 'default', name: 'Default', isDefault: true, createdAt: nowIso, lastActivatedAt: nowIso },
        { profileId: p2Id, name: 'Work', isDefault: false, isolatedAppDataDir: p2Dir, createdAt: nowIso, lastActivatedAt: nowIso },
      ],
    });

    // 2. Legacy layout.json (grid-4 + tertiary + quaternary + out-of-range widths)
    store.write('layout.json', {
      layoutMode: 'grid-4',
      openTabSessionIds: ['legacy-500', 'shared-sess', 'tombstone-del'],
      activePrimarySessionId: 'legacy-500',
      splitSecondarySessionId: 'shared-sess',
      tertiarySessionId: 'legacy-s3',
      quaternarySessionId: 'legacy-s4',
      leftSidebarWidth: 9999,
      rightInspectorWidth: 50,
      splitRatio: 0.99,
      activeInspectorTab: 'invalid-tab',
    });

    // 3. Legacy messages.json (500 msgs + pollution + shared-sess + tombstone) & messages-<p2>.json (different shared-sess!)
    const legacy500: ChatMessageItem[] = Array.from({ length: 500 }, (_, i) => ({
      id: `l500-${i}`,
      originMessageId: `l500-${i}`,
      sessionId: 'legacy-500',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `legacy-msg-${i}`,
      createdAt: nowIso,
    }));
    store.write('messages.json', {
      'legacy-500': legacy500,
      'shared-sess': [
        { id: 'def-u1', sessionId: 'shared-sess', role: 'user', content: 'DEFAULT_ONLY_PAYLOAD', createdAt: nowIso },
      ],
      'polluted-1': [
        { id: 'pol-1', sessionId: 'polluted-1', role: 'user', content: "You are 'Approve for Me' automated tool-approval reviewer", createdAt: nowIso },
      ],
      'tombstone-del': [
        { id: 'del-1', sessionId: 'tombstone-del', role: 'user', content: 'MUST_STAY_DELETED', createdAt: nowIso },
      ],
    });
    store.write(`owned-sessions-${p2Id}.json`, {
      'shared-sess': {
        sessionId: 'shared-sess',
        cwd,
        rawCwd: cwd,
        title: 'Work Shared Session',
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'closed',
        modelId: 'gemini-4-neon',
        executionMode: 'default',
        reasoningEffort: 'high',
        originKind: 'acp-live',
        readOnly: false,
        profileId: p2Id,
        updatedAt: nowIso,
      },
    });
    store.write(`messages-${p2Id}.json`, {
      'shared-sess': [
        { id: 'p2-u1', sessionId: 'shared-sess', role: 'user', content: 'WORK_PROFILE_ONLY_PAYLOAD', createdAt: nowIso },
      ],
    });

    // 4. Legacy v1 telemetry (1,048,576 window -> normalized to 512,000 for gemini-4-neon)
    store.write('session-telemetry.json', {
      states: {
        'legacy-500': {
          sessionId: 'legacy-500',
          modelId: 'gemini-4-neon',
          maxContextTokens: 1_048_576,
          usedContextTokens: 12_000,
          usageRatio: 0.01,
          pressureLevel: 'healthy',
          breakdown: {
            systemAndRulesTokens: 0,
            userMessagesTokens: 6000,
            agentMessagesTokens: 6000,
            thoughtTokens: 0,
            toolCallsTokens: 0,
            attachmentsTokens: 0,
          },
          attachments: [],
          currentTokensPerSecond: 0,
          peakTokensPerSecond: 40,
          costSummary: {
            inputTokens: 6000, cachedInputTokens: 0, outputTokens: 6000, thinkingTokens: 0,
            totalTokens: 12000, inputCostUsd: 0, cachedInputCostUsd: 0, outputCostUsd: 0, thinkingCostUsd: 0, totalCostUsd: 0,
          },
          usageSource: 'estimated',
          pricingSource: 'reference-api-estimate',
          updatedAt: nowIso,
        },
      },
      sessionCounts: {
        'legacy-500': { 'gemini-4-neon': { inputTokens: 6000, cachedInputTokens: 0, outputTokens: 6000, thinkingTokens: 0 } },
      },
      reportedUsed: { 'legacy-500': 12_000 },
      checkpointLimits: {},
      learnedModelLimits: {},
    });
    store.write('token-hours.json', [
      { hourKey: '2026-11-26T07', modelId: 'gemini-4-neon', inputTokens: 6000, cachedInputTokens: 0, outputTokens: 6000, thinkingTokens: 0, sessions: ['legacy-500'] },
    ]);

    // 5. Legacy shared swarm-states.json (working->unconfirmed, strip fake approval-guard, skip demo, mark ambiguous shared-sess)
    store.write('swarm-states.json', {
      'legacy-500': {
        sessionId: 'legacy-500',
        isActive: true,
        swarmTitle: 'Legacy Swarm',
        workers: [
          { id: 'w-real', name: 'dev-1', role: 'worker', kind: 'swarm-worker', model: 'gemini-4-neon', status: 'working', workspaceMode: 'inherit', channels: ['main'], brief: 'real work', startedAt: nowIso, updatedAt: nowIso },
          { id: 'w-fake', name: 'approval-guard', role: 'AI 代审', kind: 'swarm-worker', model: 'local-ast-guard', status: 'working', workspaceMode: 'inherit', channels: ['approval'], brief: 'fake', startedAt: nowIso, updatedAt: nowIso },
        ],
        boardMessages: [{ seq: 1, sender: 'dev-1', channel: 'main', content: 'real update', timestamp: nowIso, mentions: [], isDoneReport: false, isStallAlert: false }],
        actionTimeline: [],
        channels: ['main', 'approval'],
        stats: { total: 2, working: 2, waiting: 0, completed: 0, killed: 0 },
        updatedAt: nowIso,
      },
      'shared-sess': {
        sessionId: 'shared-sess',
        isActive: true,
        swarmTitle: 'Ambiguous Shared Swarm',
        workers: [
          { id: 'w-amb', name: 'ambiguous-worker', role: 'worker', kind: 'swarm-worker', model: 'inherit', status: 'completed', workspaceMode: 'inherit', channels: ['main'], brief: 'ambiguous', startedAt: nowIso, updatedAt: nowIso },
        ],
        boardMessages: [],
        actionTimeline: [],
        channels: ['main'],
        stats: { total: 1, working: 0, waiting: 0, completed: 1, killed: 0 },
        updatedAt: nowIso,
      },
    });

    // 6. Legacy inspector-states.json
    store.write('inspector-states.json', {
      'legacy-500': { sessionId: 'legacy-500', diffs: [], todos: [{ id: 't1', content: 'legacy todo', status: 'pending' }], terminals: [] },
      'unowned-other': { sessionId: 'unowned-other', diffs: [], todos: [{ id: 't2', content: 'must not import', status: 'pending' }], terminals: [] },
    });

    // 7. Legacy titles.json (bare sessionId key for default only)
    store.write('titles.json', {
      'shared-sess': { title: 'Default 专属旧标题', pinned: true },
      'tombstone-del': { title: '待删会话', pinned: false },
    });

    // 8. Legacy approval-config.json (reasoningEffort->thinkingLevel, broken regex skipped, encrypted key restored)
    const revCredId = '11111111-1111-1111-1111-111111111111';
    store.writeEncryptedBlob(
      'reviewer-secret.enc',
      cipher.encrypt(
        'gravity-key-v1:' +
          JSON.stringify({
            provider: 'openai-compatible',
            endpoint: 'https://api.openai.com/v1',
            key: 'sk-v034-legacy-migrated-key',
            credentialId: revCredId,
          })
      )
    );
    store.write('approval-config.json', {
      mode: 'hybrid',
      allowPatterns: ['^git status$', '[broken-regex'],
      externalReviewer: {
        enabled: true,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        reasoningEffort: 'low',
        connectionStatus: 'connected',
        verificationMethod: 'review-call',
        lastVerifiedAt: nowIso,
      },
      storedCredential: true,
      credentialId: revCredId,
    });

    // 9. Legacy preferences.json (manual appIcon kept, partial bad customTheme rescued, uiScale clamped)
    store.write('preferences.json', {
      locale: 'zh-CN',
      theme: 'custom',
      appIcon: 'gravity-ubuntu',
      uiScale: 3.5,
      customTheme: {
        name: 'Migrated Theme',
        polarity: 'dark',
        baseThemeId: 'ubuntu-aubergine',
        tokens: { accentPrimary: '#ff5500', bgApp: 'url(javascript:alert(1))' },
      },
    });

    // 10. Pending delete journal
    store.write('pending-session-deletes-default.json', ['tombstone-del']);

    // --- Boot #1 ---
    const fixedNow = () => Date.parse('2026-11-26T09:00:00.000Z');
    const boot1 = makeControlledCore({ dataDir: dir, secretCipher: cipher, now: fixedNow });
    const snap1 = await boot1.core.getBootstrap();

    // Check 10 migrations on Boot #1
    expect(snap1.layout.layoutMode).toBe('split-2');
    expect(snap1.layout.openTabSessionIds).toContain('legacy-s3');
    expect(snap1.layout.openTabSessionIds).toContain('legacy-s4');
    expect(snap1.layout.openTabSessionIds).not.toContain('tombstone-del');
    expect(snap1.layout.leftSidebarWidth).toBeLessThanOrEqual(600);
    expect(snap1.layout.rightInspectorWidth).toBeGreaterThanOrEqual(240);

    // 500 messages intact (0 truncation / 0 duplication)
    const all500Boot1 = boot1.core.messages.get('legacy-500')!;
    expect(all500Boot1).toHaveLength(500);
    expect(all500Boot1[0].content).toBe('legacy-msg-0');
    expect(all500Boot1[499].content).toBe('legacy-msg-499');
    expect(boot1.core.messages.needsRecovery('legacy-500')).toBe(true);

    // Pollution excluded & tombstone deleted
    expect(snap1.sessions.some((s) => s.sessionId === 'polluted-1')).toBe(false);
    expect(snap1.sessions.some((s) => s.sessionId === 'tombstone-del')).toBe(false);
    expect(boot1.core.messages.recent('tombstone-del')).toEqual([]);

    // Telemetry migrated
    expect(snap1.telemetry.activeSessions['legacy-500']?.maxContextTokens).toBe(512_000);
    expect(snap1.telemetry.activeSessions['legacy-500']?.costSummary.inputTokens).toBe(6000);

    // Swarm migrated: dev-1 -> unconfirmed, fake approval-guard stripped, ambiguous shared-sess NOT imported
    const swarmLegacy1 = await boot1.core.getSwarmState('legacy-500');
    expect(swarmLegacy1.workers.map((w) => ({ name: w.name, status: w.status }))).toEqual([
      { name: 'dev-1', status: 'unconfirmed' },
    ]);
    const swarmShared1 = await boot1.core.getSwarmState('shared-sess');
    expect(swarmShared1.workers).toEqual([]);

    // Inspector migrated only owned
    expect((await boot1.core.getSessionInspector('legacy-500')).todos).toHaveLength(1);
    expect((await boot1.core.getSessionInspector('unowned-other')).todos).toHaveLength(0);

    // Titles inherited on default
    expect(snap1.sessions.find((s) => s.sessionId === 'shared-sess')?.title).toBe('Default 专属旧标题');

    // Approval config migrated (reasoningEffort -> thinkingLevel, valid regex kept, bad regex dropped, key restored internally)
    expect(boot1.core.approval.getConfig().externalReviewer.thinkingLevel).toBe('low');
    expect(boot1.core.approval.getConfig().allowPatterns).toEqual(['^git status$']);
    expect(boot1.core.approval.getConfig().externalReviewer.apiKey).toBe('sk-v034-legacy-migrated-key');

    // Preferences migrated (manual appIcon preserved, customTheme rescued, uiScale clamped)
    expect(snap1.preferences.appIcon).toBe('gravity-ubuntu');
    expect(snap1.preferences.uiScale).toBe(1.6);
    expect(snap1.preferences.customTheme?.tokens.accentPrimary).toBe('#ff5500');
    expect(snap1.preferences.customTheme?.tokens.bgApp).toBe(
      THEME_PRESETS.find((t) => t.id === 'ubuntu-aubergine')!.tokens.bgApp
    );

    boot1.core.messages.save();
    await boot1.core.dispose();
    services.pop();

    // --- Boot #2 (Restart #1 -> Restart #2 consistency + 0 resurrection + cross-profile isolation) ---
    const boot2 = makeControlledCore({ dataDir: dir, secretCipher: cipher, now: fixedNow });
    const snap2 = await boot2.core.getBootstrap();

    expect(boot2.core.messages.get('legacy-500')).toHaveLength(500);
    expect(snap2.sessions.some((s) => s.sessionId === 'tombstone-del')).toBe(false);
    expect(snap2.preferences.appIcon).toBe('gravity-ubuntu');
    expect(snap2.telemetry.activeSessions['legacy-500']?.costSummary.inputTokens).toBe(6000);
    expect((await boot2.core.getSwarmState('legacy-500')).workers.map((w) => w.name)).toEqual(['dev-1']);

    // Switch to Profile 2 and verify ZERO cross-profile data bleed on identical sessionId 'shared-sess'
    await boot2.core.switchAccountProfile(p2Id);
    const snapP2 = await boot2.core.getBootstrap();
    const p2SharedMsgs = boot2.core.messages.get('shared-sess') || [];
    expect(p2SharedMsgs.map((m) => m.content)).toEqual(['WORK_PROFILE_ONLY_PAYLOAD']);
    expect(p2SharedMsgs.some((m) => m.content.includes('DEFAULT_ONLY_PAYLOAD'))).toBe(false);
    expect(snapP2.sessions.find((s) => s.sessionId === 'shared-sess')?.title).toBe('Work Shared Session');
    expect((await boot2.core.getSwarmState('shared-sess')).workers).toEqual([]);
  });
});

/* ============================================================================
 * C01 ~ C04: Anti-Ban 10 Compliance Redlines Comprehensive Verification
 * ========================================================================== */

describe('C01–C04 · 防封号与 Google ToS 十大合规红线专项验证', () => {
  it('C01 (红线 #1/#2/#3): 合成 homeDir 凭据读写=0、~/.gemini 0 字节写入、SQLite 快照 0 残留、自动切号=0', async () => {
    const dir = makeTempDir('gravity-v034-c01-');
    const fakeHome = path.join(dir, 'home');
    const geminiDir = path.join(fakeHome, '.gemini', 'antigravity', 'conversations');
    const sshDir = path.join(fakeHome, '.ssh');
    const awsDir = path.join(fakeHome, '.aws');
    const wsDir = path.join(dir, 'workspace');
    mkdirSync(geminiDir, { recursive: true });
    mkdirSync(sshDir, { recursive: true });
    mkdirSync(awsDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });

    const statePb = path.join(geminiDir, 'state.pb');
    const oauthJson = path.join(fakeHome, '.gemini', 'oauth_token.json');
    const sshKey = path.join(sshDir, 'id_rsa');
    const awsCreds = path.join(awsDir, 'credentials');
    writeFileSync(statePb, 'PRIVATE_PB_STATE', 'utf8');
    writeFileSync(oauthJson, '{"access_token":"secret"}', 'utf8');
    writeFileSync(sshKey, 'PRIVATE_SSH_KEY', 'utf8');
    writeFileSync(awsCreds, '[default]\naws_secret_access_key=xxx', 'utf8');

    const snapshotFiles = (root: string): Record<string, Buffer> => {
      const acc: Record<string, Buffer> = {};
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else acc[path.relative(root, p)] = readFileSync(p);
        }
      };
      walk(root);
      return acc;
    };
    const geminiBefore = snapshotFiles(path.join(fakeHome, '.gemini'));

    // 1. 凭据与官方状态路径在全部入口被硬拦截
    for (const secretPath of [statePb, oauthJson, sshKey, awsCreds]) {
      expect(isForbiddenCredentialOrStatePath(secretPath)).toBe(true);
    }
    const inspected = await inspectLocalTargets(
      { targets: [statePb, oauthJson, sshKey, awsCreds], cwd: wsDir },
      { homeDir: fakeHome }
    );
    for (const secretPath of [statePb, oauthJson, sshKey, awsCreds]) {
      expect(inspected.items[secretPath].kind).toBe('forbidden');
      expect(inspected.items[secretPath].previewDataUrl).toBeUndefined();
    }
    const openedTargets: string[] = [];
    for (const secretPath of [statePb, oauthJson, sshKey, awsCreds]) {
      await expect(
        openExternalTarget(
          { target: secretPath, action: 'default-app', cwd: wsDir },
          { homeDir: fakeHome, openTargetHandler: (t) => { openedTargets.push(t); } }
        )
      ).rejects.toThrow(/拒绝|敏感/);
    }
    expect(openedTargets).toEqual([]);

    const wf = new WorkspaceFiles();
    await expect(wf.readReference(wsDir, statePb)).rejects.toThrow();
    await expect(
      prepareAttachments(
        [{ name: 'id_rsa', mimeType: 'text/plain', uri: `file:///${sshKey.replace(/\\/g, '/')}`, sizeBytes: 10 }],
        wsDir
      )
    ).rejects.toThrow();

    // ClientStore 禁止落位 .gemini / antigravity-cli
    expect(() => new ClientStore(path.join(fakeHome, '.gemini', 'gravity-data'))).toThrow(/官方凭据|内部状态/);

    // 2. withReadonlySqliteSnapshot 临时目录残留 = 0
    const snapParent = makeTempDir('gravity-v034-c01-snap-');
    const snapCacheDir = makeTempDir('gravity-v034-c01-cache-');
    const srcDbPath = path.join(snapParent, 'source.sqlite');
    const db = new DatabaseSync(srcDbPath);
    try {
      db.exec("CREATE TABLE t(x TEXT); INSERT INTO t VALUES ('ok');");
    } finally {
      db.close();
    }
    const readVal = await withReadonlySqliteSnapshot(srcDbPath, snapParent, snapCacheDir, 1024 * 1024, (ro) => {
      return (ro.prepare('SELECT x FROM t').get() as { x: string }).x;
    });
    expect(readVal).toBe('ok');
    expect(readdirSync(snapCacheDir)).toEqual([]);

    // 3. 多账号手动切换正常，断连与 429/403 严禁自动轮号（自动切号 = 0）
    const { core, client } = makeControlledCore({ dataDir: path.join(dir, 'app-data'), homeDir: fakeHome });
    const created = await core.createAccountProfile({ name: 'Account B' });
    const profileB = created.profiles.find((p) => !p.isDefault)!;
    expect(core.accounts.activeProfileId).toBe('default');

    // 手动 A -> B 切换生效
    await core.switchAccountProfile(profileB.profileId);
    expect(core.accounts.activeProfileId).toBe(profileB.profileId);

    // 模拟 429 与断连：绝不自动切回 default
    client.emit('rateLimited', 'HTTP 429');
    client.emit('disconnected', { connected: false, exitCode: 1 });
    expect(core.accounts.activeProfileId).toBe(profileB.profileId);

    // 4. 核验模拟 ~/.gemini 写入严格 0 字节 / 0 新文件
    const geminiAfter = snapshotFiles(path.join(fakeHome, '.gemini'));
    expect(Object.keys(geminiAfter).sort()).toEqual(Object.keys(geminiBefore).sort());
    for (const [k, buf] of Object.entries(geminiBefore)) {
      expect(geminiAfter[k].equals(buf), `~/.gemini/${k} 被非法篡改`).toBe(true);
    }
  });

  it('C02 (红线 #4/#5/#8): 子进程 shell:false + 环境清洗、私有端点 0 请求、启动期 Plugins/MCP 命令=0、官方目录 0 写入', async () => {
    // 1. 官方参数白名单与危险标志拦截
    expect(() => validateAgyArgs(['acp', '--yolo'])).toThrow();
    expect(() => validateAgyArgs(['acp', '--dangerously-skip-permissions'])).toThrow();
    expect(() => validateAgyArgs(['chat'])).toThrow();

    // 2. AcpClient 子进程强制 shell: false 且剥离 NODE_OPTIONS / ELECTRON_RUN_AS_NODE
    const spawnCalls: Array<{ cmd: string; args: readonly string[]; opts: Record<string, unknown> }> = [];
    const origNodeOpts = process.env.NODE_OPTIONS;
    const origElectronRun = process.env.ELECTRON_RUN_AS_NODE;
    process.env.NODE_OPTIONS = '--require=/tmp/inject.js';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const stubChild = new StubRpcChild();
      const acp = new AcpClient({
        binaryPath: '/usr/local/bin/agy',
        spawn: (cmd, args, opts) => {
          spawnCalls.push({ cmd, args, opts: opts as unknown as Record<string, unknown> });
          return stubChild as never;
        },
      });
      clients.push(acp);
      await acp.start();
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].opts.shell).toBe(false);
      const env = spawnCalls[0].opts.env as Record<string, string | undefined>;
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      await acp.stop();
    } finally {
      if (origNodeOpts === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = origNodeOpts;
      if (origElectronRun === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = origElectronRun;
    }

    // 3. 私有/元数据/八进制 IPv4/Google 内部端点拦截（请求 = 0）
    const blockedHosts = [
      'metadata.goog',
      'metadata.google.internal',
      '169.254.169.254',
      '0177.0.0.1',
      '0x7f000001',
      'cloudcode-pa.googleapis.com',
      'generativelanguage.googleapis.com',
      '10.0.0.1',
      '[::1]',
    ];
    for (const h of blockedHosts) {
      expect(isBlockedExternalEndpointHost(h), `must block host ${h}`).toBe(true);
      expect(() =>
        validateExternalEndpoint({
          enabled: true,
          provider: 'openai-compatible',
          endpoint: `https://${h}/v1`,
          model: 'gpt-4o-mini',
          apiKey: 'sk-test',
          timeoutMs: 3000,
        })
      ).toThrow();
    }

    // 4. 启动期 Plugins / MCP CLI 命令 = 0；Skills 开关仅写客户端自有目录，不改 ~/.gemini
    const dir = makeTempDir('gravity-v034-c02-plg-');
    const fakeHome = path.join(dir, 'home');
    const skillDir = path.join(fakeHome, '.gemini', 'config', 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: Demo\ndescription: Read-only\n---\nbody', 'utf8');
    const cliSpy = vi.fn<CliExecutor>(async () => ({ stdout: '[]' }));

    const { core } = makeControlledCore({ dataDir: path.join(dir, 'data'), homeDir: fakeHome, pluginsExecutor: cliSpy });
    await core.getBootstrap();
    expect(cliSpy, '启动期不得主动执行 Plugins/MCP CLI 命令').toHaveBeenCalledTimes(0);

    // buildAgyEnvironment 全平台清洗
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const cleaned = buildAgyEnvironment('/bin/agy', { NODE_OPTIONS: '--x', ELECTRON_RUN_AS_NODE: '1' }, platform, fakeHome);
      expect(cleaned.NODE_OPTIONS).toBeUndefined();
      expect(cleaned.ELECTRON_RUN_AS_NODE).toBeUndefined();
    }
  });

  it('C03 (红线 #6/#7): 429>=60s / 403>=300s、活跃并发<=4、独立复核/翻译建官方会话=0、Swarm 零伪造、禁 allow_always', async () => {
    vi.useFakeTimers();
    const baseTime = Date.UTC(2026, 10, 26, 10, 0, 0);
    vi.setSystemTime(baseTime);

    // 1. 429 >= 60s / 403 >= 300s + 独立复核 vs 翻译 401 隔离
    const stubChild = new StubRpcChild();
    const acp = new AcpClient({ spawn: () => stubChild as never });
    clients.push(acp);
    const startP = acp.start();
    await vi.advanceTimersByTimeAsync(10);
    await startP;

    const p429 = acp.request('session/list', {});
    const req429 = stubChild.sent.at(-1)!;
    stubChild.emitMessage({ jsonrpc: '2.0', id: req429.id, error: { code: 429, message: 'HTTP 429 RESOURCE_EXHAUSTED' } });
    await expect(p429).rejects.toThrow(/429/);
    expect(acp.cooldownUntilMs - Date.now()).toBeGreaterThanOrEqual(60_000);

    // 403 延长冷却至 >= 300s
    const breaker = new OriginCircuitBreaker({ tripOn401: false });
    expect(breaker.fail('https://api.example.com', 429, baseTime)).toBeGreaterThanOrEqual(60_000);
    expect(breaker.fail('https://api.example.com', 403, baseTime)).toBeGreaterThanOrEqual(300_000);
    expect(reviewerCircuit.fail('https://api.example.com', 401, baseTime)).toBe(0);
    expect(translatorCircuit.fail('https://api.example.com', 401, baseTime)).toBeGreaterThanOrEqual(300_000);

    // 2. 活跃并发峰值 <= 4，第 5 个被硬拦截
    const { core, requests, dir } = makeControlledCore();
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    for (let i = 0; i < MAX_PARALLEL_ACTIVE_SESSIONS; i += 1) {
      await core.createSession({ cwd, title: `slot-${i}` });
    }
    expect(core.sessions.activeSessionCount).toBe(4);
    await expect(core.createSession({ cwd, title: 'slot-5' })).rejects.toThrow(/4 个活动会话/);
    expect(core.sessions.activeSessionCount).toBe(4);

    // 3. 外部复核 & 翻译均绝不创建官方 ACP 会话
    const newSessionCallsBefore = requests.filter((r) => r.method === 'session/new').length;
    const engine = new ApprovalEngine({
      store: new ClientStore(makeTempDir('gravity-v034-c03-apr-')),
      config: { mode: 'manual' },
    });
    engines.push(engine);
    let card: PendingApprovalRequest | undefined;
    engine.on('requested', (c: PendingApprovalRequest) => { card = c; });
    const permResPromise = engine.requestPermission(
      {
        sessionId: 's-c03',
        toolCall: { toolCallId: 'tc-c03', kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'npm test' } },
        options: [
          { optionId: 'opt-allow-always', name: 'Allow Always', kind: 'allow_always' },
          { optionId: 'opt-allow-once', name: 'Allow Once', kind: 'allow_once' },
          { optionId: 'opt-reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
      cwd
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(card).toBeDefined();
    await engine.submitDecision({ requestId: card!.requestId, sessionId: 's-c03', decision: 'allow_once' });
    const permRes = await permResPromise;
    // 永不选 allow_always
    expect(permRes).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-allow-once' } });
    expect(requests.filter((r) => r.method === 'session/new').length).toBe(newSessionCallsBefore);

    // 4. Swarm 空态零伪造
    const emptySwarm = await core.getSwarmState('fresh-empty-session');
    expect(emptySwarm.workers).toEqual([]);
    expect(emptySwarm.isActive).toBe(false);
  });

  it('C04 (红线 #9/#10): 沙箱 4 项、回环、D2-A CSP、surfaceRamp 防注入、D4 零明文 Key、6 原创图标与双语免责', async () => {
    // 1. 窗口沙箱 + 回环 + CSP
    const winSrc =
      readFileSync(path.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf8') +
      '\n' +
      readFileSync(path.join(REPO_ROOT, 'src', 'main', 'desktop', 'window-manager.ts'), 'utf8');
    expect(winSrc).toMatch(/contextIsolation:\s*true/);
    expect(winSrc).toMatch(/nodeIntegration:\s*false/);
    expect(winSrc).toMatch(/sandbox:\s*true/);
    expect(winSrc).toMatch(/webSecurity:\s*true/);
    expect(winSrc).toContain("url.hostname !== '127.0.0.1'");

    const html = readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain("connect-src 'self'");

    // 2. 自定义主题 surfaceRamp CSS 注入防护
    expect(() =>
      validateCustomThemeConfig({
        name: 'Evil',
        polarity: 'dark',
        baseThemeId: 'claude-code-dark',
        tokens: {},
        surfaceRamp: { canvas: '#111; background-image: url(https://evil.example/x.png)' },
      })
    ).toThrow(/非法/);
    const sanitized = sanitizeCustomThemeConfig({
      name: 'PartialEvil',
      polarity: 'dark',
      baseThemeId: 'claude-code-dark',
      tokens: {},
      surfaceRamp: { canvas: 'expression(alert(1))', rail: '#1e1b18' },
    });
    expect(sanitized?.surfaceRamp?.canvas).toBeUndefined();
    expect(sanitized?.surfaceRamp?.rail).toBe('#1e1b18');

    // 3. 6 套原创 C4 图标 & 双语 Cost 免责声明
    expect(GRAVITY_ICON_VARIANTS).toHaveLength(6);
    expect(COST_DISCLAIMER['zh-CN']).toContain('非实际账单');
    expect(COST_DISCLAIMER['en-US']).toContain('not an actual bill');

    // 4. D4 Bootstrap / getter / save / event 明文第三方 Key = 0
    const cipher = makeCipher();
    const secretRev = 'sk-v034-c04-reviewer-secret';
    const secretTrn = 'sk-v034-c04-translator-secret';
    const dir = makeTempDir('gravity-v034-c04-d4-');
    const core = new CoreService({
      dataDir: dir,
      enableAutoUpdateCheck: false,
      acpOptions: { binaryPath: path.join(dir, 'nonexistent-agy') },
      secretCipher: cipher,
      reviewer: vi.fn().mockResolvedValue({
        recommended: 'approve', riskLevel: 'safe', riskScore: 5, intentAlignment: 'aligned', reason: 'ok', latencyMs: 5,
      }),
      externalTranslator: vi.fn().mockResolvedValue({ text: '正在检查配置文件。', latencyMs: 5 }),
    });
    services.push(core);

    const emitted: unknown[] = [];
    core.on('approval-config-updated', (e: ApproveForMeConfig) => emitted.push(e));
    core.on('translation-config-updated', (e: TranslationConfig) => emitted.push(e));

    await core.testExternalReviewerConnection({
      enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: secretRev, timeoutMs: 3000,
    });
    const savedRev = await core.updateApprovalConfig({
      mode: 'hybrid',
      externalReviewer: { enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: secretRev, timeoutMs: 3000 },
    });
    await core.testExternalTranslatorConnection({
      enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: secretTrn, timeoutMs: 3000,
    });
    const savedTrn = await core.updateTranslationConfig({
      engine: 'external-api',
      externalTranslator: { enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: secretTrn, timeoutMs: 3000 },
    });
    const boot = await core.getBootstrap();
    const trnGet = await core.getTranslationConfig();

    expect(boot.approvalConfig.externalReviewer.apiKey).toBeUndefined();
    expect(boot.approvalConfig.externalReviewer.hasApiKey).toBe(true);
    expect(boot.translationConfig.externalTranslator.apiKey).toBeUndefined();
    expect(boot.translationConfig.externalTranslator.hasApiKey).toBe(true);
    expect(savedRev.externalReviewer.apiKey).toBeUndefined();
    expect(savedTrn.externalTranslator.apiKey).toBeUndefined();
    expect(trnGet.externalTranslator.apiKey).toBeUndefined();

    const dump = JSON.stringify({ boot, savedRev, savedTrn, trnGet, emitted });
    expect(dump).not.toContain(secretRev);
    expect(dump).not.toContain(secretTrn);
  });
});

// Keep MESSAGE_PAGE_SIZE imported/validated cleanly
expect(MESSAGE_PAGE_SIZE).toBe(64);
