// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain, WebContents, IpcMainInvokeEvent } from 'electron';
import { buildAgyEnvironment } from '../src/main/acp/agy-environment';
import { registerIpcRouter } from '../src/main/ipc-router';
import { CoreService } from '../src/main/core-service';
import type { SecretCipher } from '../src/main/services/secret-vault';
import { IPC_CHANNELS, isForbiddenCredentialOrStatePath, type ApproveForMeConfig, type TranslationConfig } from '../src/shared';

const tempDirs: string[] = [];
const activeServices: CoreService[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const svc of activeServices.splice(0)) await svc.dispose().catch(() => {});
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  vi.restoreAllMocks();
});

describe('IPC 来源隔离与生命周期', () => {
  function setup() {
    const handlers = new Map<string, Function>();
    const ipcMain = { handle: (channel: string, callback: Function) => handlers.set(channel, callback), removeHandler: (channel: string) => handlers.delete(channel) } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const service = Object.assign(new EventEmitter(), {
      getBootstrap: vi.fn().mockResolvedValue({ ok: true }),
      inspectLocalTargets: vi.fn().mockResolvedValue({ items: {} }),
      copyText: vi.fn().mockResolvedValue(undefined),
    }) as unknown as CoreService;
    const dispose = registerIpcRouter(ipcMain, service, trusted);
    const event = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    return { handlers, trusted, service, dispose, event };
  }
  it('仅主窗口主 frame 和匹配 URL 能调用；拒绝其他窗口与 iframe', async () => {
    const { handlers, trusted, service, dispose, event } = setup();
    try {
      const callback = handlers.get(IPC_CHANNELS.APP_GET_BOOTSTRAP)!;
      expect(await callback(event)).toEqual({ ok: true });
      expect(() => callback({ ...event, sender: {} })).toThrow('非主窗口');
      expect(() => callback({ ...event, senderFrame: { url: trusted.getURL() } })).toThrow('非主窗口');
      expect(service.getBootstrap).toHaveBeenCalledTimes(1);
    } finally { dispose(); }
  });
  it('v0.3.1 新增通道 APP_INSPECT_LOCAL_TARGETS 与 EVENT_CONNECTION_UPDATED 遵守主 frame IPC 来源隔离', async () => {
    expect(IPC_CHANNELS.APP_INSPECT_LOCAL_TARGETS).toBe('gravity:app:inspect-local-targets');
    expect(IPC_CHANNELS.EVENT_CONNECTION_UPDATED).toBe('gravity:event:connection-updated');
    const { handlers, trusted, service, dispose, event } = setup();
    try {
      // Every registered handler must enforce main-frame origin isolation
      for (const [, handler] of handlers) {
        expect(() => handler({ ...event, sender: {} })).toThrow('非主窗口');
        expect(() => handler({ ...event, senderFrame: { url: trusted.getURL() } })).toThrow('非主窗口');
        expect(() => handler({ ...event, senderFrame: { url: 'https://evil.example/' } })).toThrow('非主窗口');
      }
      const inspectHandler = handlers.get(IPC_CHANNELS.APP_INSPECT_LOCAL_TARGETS);
      if (inspectHandler) {
        const result = await inspectHandler(event, { targets: ['demo.png'] });
        expect(result).toEqual({ items: {} });
        expect(() => inspectHandler({ ...event, sender: {} }, { targets: ['demo.png'] })).toThrow('非主窗口');
        expect(() => inspectHandler({ ...event, senderFrame: { url: trusted.getURL() } }, { targets: ['demo.png'] })).toThrow('非主窗口');
        expect(() => inspectHandler(event, 1, 2, 3, 4)).toThrow('数量');
      }
      if (service.listenerCount('connection-updated') > 0) {
        const status = { connected: false, agyBinaryPath: 'agy', agyVersion: '', activeSessionCount: 0, maxParallelSessions: 4, activeProfileId: 'default', availableModels: [] };
        service.emit('connection-updated', status);
        expect(trusted.send).toHaveBeenCalledWith(IPC_CHANNELS.EVENT_CONNECTION_UPDATED, status);
      }
    } finally {
      dispose();
    }
    expect(handlers.size).toBe(0);
    expect(service.listenerCount('connection-updated')).toBe(0);
  });
  it('参数数量与体积限制，卸载移除全部路由及事件订阅', () => {
    const { handlers, trusted, service, dispose, event } = setup();
    const callback = handlers.get(IPC_CHANNELS.APP_GET_BOOTSTRAP)!;
    expect(() => callback(event, 1, 2, 3, 4)).toThrow('数量');
    expect(() => callback(event, 'x'.repeat(32 * 1024 * 1024))).toThrow('大小');
    service.emit('session-updated', { sessionId: 'a' });
    expect(trusted.send).toHaveBeenCalledWith(IPC_CHANNELS.EVENT_SESSION_UPDATED, { sessionId: 'a' });
    dispose(); expect(handlers.size).toBe(0);
    expect(service.listenerCount('session-updated')).toBe(0);
    service.emit('session-updated', { sessionId: 'b' }); expect(trusted.send).toHaveBeenCalledTimes(1);
  });
  it('v0.3.4 U-01: APP_COPY_TEXT 遵守主 frame 隔离与 <= 4 MB UTF-8 文本预算', async () => {
    expect(IPC_CHANNELS.APP_COPY_TEXT).toBe('gravity:app:copy-text');
    const copied: string[] = [];
    const core = new CoreService({
      dataDir: makeTempDir('gravity-sec-copy-'),
      enableAutoUpdateCheck: false,
      copyTextHandler: (text) => { copied.push(text); },
    });
    activeServices.push(core);

    const handlers = new Map<string, Function>();
    const ipcMain = { handle: (channel: string, callback: Function) => handlers.set(channel, callback), removeHandler: (channel: string) => handlers.delete(channel) } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const dispose = registerIpcRouter(ipcMain, core, trusted);
    const event = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    try {
      const copyHandler = handlers.get(IPC_CHANNELS.APP_COPY_TEXT)!;
      expect(typeof copyHandler).toBe('function');

      // 合法多行纯文本正常写入剪贴板回调
      await copyHandler(event, 'line1\nconst x = 42;\n');
      expect(copied).toEqual(['line1\nconst x = 42;\n']);

      // 非主窗口 / 非主 frame / 恶意来源一律拒绝
      expect(() => copyHandler({ ...event, sender: {} }, 'ok')).toThrow('非主窗口');
      expect(() => copyHandler({ ...event, senderFrame: { url: trusted.getURL() } }, 'ok')).toThrow('非主窗口');
      expect(() => copyHandler({ ...event, senderFrame: { url: 'https://evil.example/' } }, 'ok')).toThrow('非主窗口');

      // 超过 4 MB UTF-8 限制与非字符串输入均被拒绝
      await expect(copyHandler(event, 'a'.repeat(4 * 1024 * 1024 + 1))).rejects.toThrow(/4 MB|大小限制/);
      await expect(copyHandler(event, 12345 as unknown as string)).rejects.toThrow(/无效|4 MB/);
      expect(copied).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

describe('沙箱 preload 真实编译与最小桥接', () => {
  it('运行时仅 require electron，仅暴露 gravityDesktop（不再暴露 agyDesktop），事件返回可用取消订阅函数', async () => {
    const source = readFileSync('src/main/preload.ts', 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const ipc = Object.assign(new EventEmitter(), { invoke: vi.fn().mockResolvedValue({ ok: true }) });
    let bridge: any;
    const exposed = new Map<string, unknown>();
    const contextBridge = { exposeInMainWorld: vi.fn((name, value) => { exposed.set(name, value); bridge = value; }) };
    const requireSpy = vi.fn((name) => { if (name !== 'electron') throw new Error(`沙箱不支持模块：${name}`); return { contextBridge, ipcRenderer: ipc }; });
    vm.runInNewContext(compiled, { exports: {}, require: requireSpy });
    expect([...exposed.keys()]).toEqual(['gravityDesktop']);
    expect(exposed.has('agyDesktop')).toBe(false);
    expect(requireSpy.mock.calls.map((call) => call[0])).toEqual(['electron']);
    expect(Object.isFrozen(bridge)).toBe(true);
    await bridge.getBootstrap(); expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_GET_BOOTSTRAP);
    await bridge.copyText('sample-copy'); expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_COPY_TEXT, 'sample-copy');
    await bridge.submitApprovalDecision({ requestId: 'r', sessionId: 's', decision: 'allow_once' });
    expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.APPROVAL_SUBMIT_DECISION, { requestId: 'r', sessionId: 's', decision: 'allow_once' });
    const listener = vi.fn(); const unsubscribe = bridge.onApprovalRequested(listener);
    ipc.emit(IPC_CHANNELS.EVENT_APPROVAL_REQUESTED, { sender: 'hidden-event' }, { requestId: 'r' });
    expect(listener).toHaveBeenCalledWith({ requestId: 'r' });
    unsubscribe(); ipc.emit(IPC_CHANNELS.EVENT_APPROVAL_REQUESTED, {}, {}); expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge).not.toHaveProperty('ipcRenderer'); expect(bridge).not.toHaveProperty('require');
  });

  it('v0.3.3 100% 全量通道一致守卫：preload.ts 与 ipc-router.ts (+ macos-menu.ts) 与 IPC_CHANNELS 1:1 完全对齐', () => {
    const expectedChannels = new Set<string>(Object.values(IPC_CHANNELS));

    // 1. AST 解析 src/main/preload.ts 中的全部 invoke(...) 与 subscribe(...) 通道字符串，及 exposeInMainWorld 暴露名
    const preloadSource = readFileSync('src/main/preload.ts', 'utf8');
    const preloadAst = ts.createSourceFile('src/main/preload.ts', preloadSource, ts.ScriptTarget.Latest, true);
    const preloadChannels: string[] = [];
    const exposedNames: string[] = [];
    const visitPreload = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && (node.expression.text === 'invoke' || node.expression.text === 'subscribe')) {
          const firstArg = node.arguments[0];
          if (firstArg && ts.isStringLiteralLike(firstArg)) preloadChannels.push(firstArg.text);
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'exposeInMainWorld' &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          exposedNames.push(node.arguments[0].text);
        }
      }
      ts.forEachChild(node, visitPreload);
    };
    visitPreload(preloadAst);

    expect(exposedNames).toEqual(['gravityDesktop']);
    expect(new Set(preloadChannels).size, 'preload.ts 中存在重复 IPC 通道').toBe(preloadChannels.length);

    const preloadSet = new Set(preloadChannels);
    const missingInPreload = [...expectedChannels].filter((ch) => !preloadSet.has(ch)).sort();
    const extraInPreload = [...preloadSet].filter((ch) => !expectedChannels.has(ch)).sort();
    expect({ missingInPreload, extraInPreload }).toEqual({ missingInPreload: [], extraInPreload: [] });

    // 2. AST 解析 src/main/ipc-router.ts 与 src/main/macos-menu.ts 中的全部 IPC_CHANNELS.* 引用
    const routerKeys: string[] = [];
    const invalidKeys: string[] = [];
    const channelRecord = IPC_CHANNELS as Record<string, string>;
    for (const file of ['src/main/ipc-router.ts', 'src/main/macos-menu.ts']) {
      const source = readFileSync(file, 'utf8');
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'IPC_CHANNELS'
        ) {
          const key = node.name.text;
          if (typeof channelRecord[key] === 'string') routerKeys.push(channelRecord[key]);
          else invalidKeys.push(`${file}:${key}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }

    expect(invalidKeys, '存在已删除或拼写错误的 IPC_CHANNELS 键引用').toEqual([]);
    const routerSet = new Set(routerKeys);
    const missingInRouter = [...expectedChannels].filter((ch) => !routerSet.has(ch)).sort();
    const extraInRouter = [...routerSet].filter((ch) => !expectedChannels.has(ch)).sort();
    expect({ missingInRouter, extraInRouter }).toEqual({ missingInRouter: [], extraInRouter: [] });
  });
});

describe('自动静态回归守卫（不替代人工合规审查）', () => {
  function files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
  }
  it('运行源码字符串不包含私有端点 URL 或硬编码官方凭据文件路径', () => {
    const violations: string[] = [];
    for (const file of files('src')) {
      const syntax = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node)) {
          if (/https?:\/\/[^\s]*cloudcode-pa\./i.test(node.text) || /(?:~|[A-Z]:|%APPDATA%)[\\/].*(?:\.gemini|antigravity-cli)[\\/]/i.test(node.text)) violations.push(`${file}:${syntax.getLineAndCharacterOfPosition(node.pos).line + 1}`);
        }
        ts.forEachChild(node, visit);
      }; visit(syntax);
    }
    expect(violations).toEqual([]);
  });
  it('主窗口安全设置与仅本机开发入口保持开启', () => {
    const windowManagerPath = 'src/main/desktop/window-manager.ts';
    const source =
      readFileSync('src/main/index.ts', 'utf8') +
      (existsSync(windowManagerPath) ? '\n' + readFileSync(windowManagerPath, 'utf8') : '');
    expect(source).toMatch(/contextIsolation:\s*true/); expect(source).toMatch(/nodeIntegration:\s*false/);
    expect(source).toMatch(/sandbox:\s*true/); expect(source).toMatch(/webSecurity:\s*true/);
    expect(source).toContain("url.hostname !== '127.0.0.1'");
    expect(readFileSync('vite.config.ts', 'utf8')).toContain('127.0.0.1');
  });
  it('D2-A 严格纯本地 CSP 守卫：index.html 锁定 object-src/base-uri/img-src/connect-src 且禁止 file:/http:/https:', () => {
    const html = readFileSync('index.html', 'utf8');
    const cspMatch = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
    expect(cspMatch, 'index.html 缺少 Content-Security-Policy meta 标签').not.toBeNull();
    const csp = cspMatch![1];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/\b(?:file|http|https):/i);
  });
  it('SEC-02: buildAgyEnvironment 在全平台（Win/macOS/Linux）剥离 NODE_OPTIONS 与 ELECTRON_RUN_AS_NODE', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require=/tmp/injected.js',
      ELECTRON_RUN_AS_NODE: '1',
      GRAVITY_KEEP_SAFE_VAR: 'preserved',
    };
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const sanitized = buildAgyEnvironment('/usr/local/bin/agy', baseEnv, platform, '/Users/tester');
      expect(sanitized.NODE_OPTIONS, `${platform} must strip NODE_OPTIONS`).toBeUndefined();
      expect(sanitized.ELECTRON_RUN_AS_NODE, `${platform} must strip ELECTRON_RUN_AS_NODE`).toBeUndefined();
      expect(sanitized.GRAVITY_KEEP_SAFE_VAR, `${platform} must preserve safe env`).toBe('preserved');
    }
    expect(baseEnv.NODE_OPTIONS).toBe('--require=/tmp/injected.js');
    expect(baseEnv.ELECTRON_RUN_AS_NODE).toBe('1');
  });
  it('D1-B: 0 history-importer.ts 存在性守卫', () => {
    expect(existsSync('src/main/history/history-importer.ts')).toBe(false);
  });
  it('SEC-1: isForbiddenCredentialOrStatePath 拦截 .gemini 与 antigravity 目录下的 .pb 状态文件', () => {
    const blockedPbPaths = [
      'C:\\Users\\dev\\.gemini\\antigravity\\conversations\\state.pb',
      'C:/Users/dev/.gemini/antigravity-cli/cache/session.pb',
      '/Users/dev/.gemini/state.pb',
      '/home/dev/.gemini/nested/dir/auth.PB',
      'C:\\AppData\\antigravity\\brain\\checkpoint.pb',
      '/tmp/profiles/p1/antigravity-cli/internal.pb',
    ];
    for (const target of blockedPbPaths) {
      expect(isForbiddenCredentialOrStatePath(target), `must block ${target}`).toBe(true);
    }
    // Ordinary protobuf artifacts outside .gemini/antigravity remain unaffected
    expect(isForbiddenCredentialOrStatePath('F:/work/project/proto/messages.pb')).toBe(false);
  });

  it('v0.3.4 K1: AST 静态扫描 src/shared/**/*.ts（含 import / import type / 再导出）0 循环依赖', () => {
    const sharedRoot = path.resolve(process.cwd(), 'src', 'shared');
    const sharedFiles = files(sharedRoot).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).sort();
    expect(sharedFiles.length).toBeGreaterThan(5);

    const resolveRel = (fromFile: string, spec: string): string | null => {
      if (!spec.startsWith('.')) return null;
      const base = path.resolve(path.dirname(fromFile), spec);
      for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
        if (existsSync(candidate) && candidate.endsWith('.ts') && !candidate.endsWith('.d.ts')) {
          const rel = path.relative(sharedRoot, candidate);
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
        }
      }
      return null;
    };

    const graph = new Map<string, string[]>();
    for (const file of sharedFiles) {
      const fromKey = path.relative(sharedRoot, file).replace(/\\/g, '/');
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const targets = new Set<string>();
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const target = resolveRel(file, node.moduleSpecifier.text);
          if (target) targets.add(target);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const target = resolveRel(file, node.moduleSpecifier.text);
          if (target) targets.add(target);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
          const target = resolveRel(file, node.arguments[0].text);
          if (target) targets.add(target);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      graph.set(fromKey, [...targets].sort());
    }

    // Tarjan SCC
    let idx = 0;
    const indices = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const cycles: string[][] = [];
    const strongConnect = (v: string) => {
      indices.set(v, idx); lowlink.set(v, idx); idx += 1;
      stack.push(v); onStack.add(v);
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
        do { w = stack.pop()!; onStack.delete(w); scc.push(w); } while (w !== v);
        if (scc.length > 1 || (scc.length === 1 && (graph.get(v) || []).includes(v))) cycles.push(scc.sort());
      }
    };
    for (const node of graph.keys()) if (!indices.has(node)) strongConnect(node);
    expect(cycles.map((c) => c.join(' <-> ')), 'src/shared/**/*.ts 不得存在循环依赖').toEqual([]);
  });

  it('v0.3.4 D4: 外部第三方 API Key 零明文投影（Bootstrap / getter / save / event 均不回传明文 Key）', async () => {
    const dir = makeTempDir('gravity-sec-d4-');
    const revSecret = 'sk-v034-sec-baseline-reviewer-9911';
    const trnSecret = 'sk-v034-sec-baseline-translator-8822';
    const cipher: SecretCipher = {
      isAvailable: () => true,
      encrypt: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
      decrypt: (buf) => {
        const s = buf.toString('utf8');
        if (!s.startsWith('ENC:')) throw new Error('bad cipher');
        return s.slice(4);
      },
    };
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
    activeServices.push(core);

    const approvalEvents: ApproveForMeConfig[] = [];
    const translationEvents: TranslationConfig[] = [];
    core.on('approval-config-updated', (cfg: ApproveForMeConfig) => approvalEvents.push(cfg));
    core.on('translation-config-updated', (cfg: TranslationConfig) => translationEvents.push(cfg));

    const revTest = await core.testExternalReviewerConnection({
      enabled: true,
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: revSecret,
      timeoutMs: 3000,
    });
    expect(revTest.ok).toBe(true);
    const savedApproval = await core.updateApprovalConfig({
      mode: 'hybrid',
      externalReviewer: {
        enabled: true,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: revSecret,
        timeoutMs: 3000,
      },
    });

    const trnTest = await core.testExternalTranslatorConnection({
      enabled: true,
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: trnSecret,
      timeoutMs: 3000,
    });
    expect(trnTest.ok).toBe(true);
    const savedTranslation = await core.updateTranslationConfig({
      engine: 'external-api',
      externalTranslator: {
        enabled: true,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: trnSecret,
        timeoutMs: 3000,
      },
    });

    const gotTranslation = await core.getTranslationConfig();
    const bootstrap = await core.getBootstrap();

    // 1. 返回值与 getter 严禁包含明文 API Key，且须投影 hasApiKey: true
    expect(savedApproval.externalReviewer.apiKey).toBeUndefined();
    expect(savedApproval.externalReviewer.hasApiKey).toBe(true);
    expect(savedTranslation.externalTranslator.apiKey).toBeUndefined();
    expect(savedTranslation.externalTranslator.hasApiKey).toBe(true);
    expect(gotTranslation.externalTranslator.apiKey).toBeUndefined();
    expect(gotTranslation.externalTranslator.hasApiKey).toBe(true);

    // 2. Bootstrap 与事件推送均严禁包含明文 Key
    expect(bootstrap.approvalConfig.externalReviewer.apiKey).toBeUndefined();
    expect(bootstrap.approvalConfig.externalReviewer.hasApiKey).toBe(true);
    expect(bootstrap.translationConfig.externalTranslator.apiKey).toBeUndefined();
    expect(bootstrap.translationConfig.externalTranslator.hasApiKey).toBe(true);
    expect(approvalEvents.at(-1)?.externalReviewer.apiKey).toBeUndefined();
    expect(approvalEvents.at(-1)?.externalReviewer.hasApiKey).toBe(true);
    expect(translationEvents.at(-1)?.externalTranslator.apiKey).toBeUndefined();
    expect(translationEvents.at(-1)?.externalTranslator.hasApiKey).toBe(true);

    const serializedSurfaces = JSON.stringify({
      savedApproval, savedTranslation, gotTranslation, bootstrap, approvalEvents, translationEvents,
    });
    expect(serializedSurfaces).not.toContain(revSecret);
    expect(serializedSurfaces).not.toContain(trnSecret);

    // 3. 磁盘明文 JSON 中零明文 Key
    expect(readFileSync(path.join(dir, 'approval-config.json'), 'utf8')).not.toContain(revSecret);
    expect(readFileSync(path.join(dir, 'translation-config.json'), 'utf8')).not.toContain(trnSecret);
  });
});
