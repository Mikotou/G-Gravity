// @vitest-environment node
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

interface QuitEvent {
  defaultPrevented: boolean;
  preventDefault(): void;
}

interface RouterBinding {
  service: MockCoreService;
  webContents: MockWebContents;
  disposed: boolean;
  disposeSpy: ReturnType<typeof vi.fn<() => void>>;
}

class MockWebContents extends EventEmitter {
  private readonly owner: MockBrowserWindow;
  setZoomFactor = vi.fn();
  send = vi.fn();
  setWindowOpenHandler = vi.fn();
  getURL = vi.fn(() => 'file:///mock/dist/renderer/index.html');
  session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };

  constructor(owner: MockBrowserWindow) {
    super();
    this.owner = owner;
  }

  isDestroyed(): boolean {
    return this.owner.isDestroyed();
  }
}

class MockBrowserWindow extends EventEmitter {
  static openWindows: MockBrowserWindow[] = [];
  static createdWindows: MockBrowserWindow[] = [];
  static onAllClosed: (() => void) | undefined;

  static getAllWindows = vi.fn(() => [...MockBrowserWindow.openWindows]);
  static getFocusedWindow = vi.fn(() => MockBrowserWindow.openWindows[0] ?? null);

  readonly id: number;
  readonly webContents: MockWebContents;
  private destroyed = false;
  private minimized = false;
  private maximized = false;

  restore = vi.fn(() => { this.minimized = false; });
  focus = vi.fn();
  show = vi.fn();
  maximize = vi.fn(() => { this.maximized = true; });
  setBackgroundColor = vi.fn();
  setTitleBarOverlay = vi.fn();
  setIcon = vi.fn();
  getBounds = vi.fn(() => ({ x: 100, y: 100, width: 1200, height: 800 }));
  getNormalBounds = vi.fn(() => ({ x: 100, y: 100, width: 1200, height: 800 }));
  loadURL = vi.fn(async () => { this.webContents.emit('did-finish-load'); });
  loadFile = vi.fn(async () => { this.webContents.emit('did-finish-load'); });

  constructor(_options?: Record<string, unknown>) {
    super();
    this.id = MockBrowserWindow.createdWindows.length + 1;
    this.webContents = new MockWebContents(this);
    MockBrowserWindow.createdWindows.push(this);
    MockBrowserWindow.openWindows.push(this);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  setMinimizedForTest(value: boolean): void {
    this.minimized = value;
  }

  close = vi.fn(() => {
    if (this.destroyed) return;
    const closeEvent: QuitEvent = {
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    this.emit('close', closeEvent);
    if (closeEvent.defaultPrevented) return;
    this.destroyed = true;
    const idx = MockBrowserWindow.openWindows.indexOf(this);
    if (idx >= 0) MockBrowserWindow.openWindows.splice(idx, 1);
    this.emit('closed');
    if (MockBrowserWindow.openWindows.length === 0) {
      MockBrowserWindow.onAllClosed?.();
    }
  });
}

class MockCoreService extends EventEmitter {
  static instances: MockCoreService[] = [];

  readonly store = {
    read: vi.fn((_name: string, fallback: unknown) => fallback),
    write: vi.fn(),
  };

  readonly getPreferences = vi.fn(() => ({
    locale: 'zh-CN' as const,
    theme: 'claude-code-dark' as const,
    uiScale: 1,
    appIcon: 'gravity-claude-dark' as const,
  }));

  readonly dispose = vi.fn(async () => {});

  constructor(_options?: Record<string, unknown>) {
    super();
    MockCoreService.instances.push(this);
  }
}

async function flushAsync(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

interface MainProcessHarness {
  app: EventEmitter & { quit: ReturnType<typeof vi.fn<() => void>> };
  nativeTheme: EventEmitter & { shouldUseDarkColors: boolean };
  BrowserWindow: typeof MockBrowserWindow;
  coreServices: MockCoreService[];
  routerBindings: RouterBinding[];
  getQuitCompletedCount: () => number;
  cleanup: () => void;
}

const activeCleanups: Array<() => void> = [];

async function bootMainProcess(platform: 'darwin' | 'win32' | 'linux'): Promise<MainProcessHarness> {
  vi.resetModules();
  vi.stubEnv('AGY_RENDERER_URL', '');
  // Validate the startup directory with the host filesystem before simulating window lifecycle.
  const useLifecyclePlatform = () => Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });

  MockBrowserWindow.openWindows = [];
  MockBrowserWindow.createdWindows = [];
  MockBrowserWindow.getAllWindows.mockClear();
  MockBrowserWindow.getFocusedWindow.mockClear();
  MockCoreService.instances = [];

  const routerBindings: RouterBinding[] = [];
  let quitCompletedCount = 0;

  const appEmitter = new EventEmitter();
  const quit = vi.fn(() => {
    const event: QuitEvent = {
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    appEmitter.emit('before-quit', event);
    if (!event.defaultPrevented) {
      quitCompletedCount += 1;
      appEmitter.emit('will-quit', event);
      appEmitter.emit('quit', event, 0);
    }
  });

  const exit = vi.fn((code = 0) => {
    quitCompletedCount += 1;
    appEmitter.emit('quit', {}, code);
  });

  const app = Object.assign(appEmitter, {
    setName: vi.fn(),
    setPath: vi.fn(useLifecyclePlatform),
    setAppUserModelId: vi.fn(),
    getPath: vi.fn((name: string) => platform === 'win32' ? `C:\\gravity-lifecycle-test\\${name}` : `/tmp/gravity-lifecycle-test/${name}`),
    getVersion: vi.fn(() => '0.2.4'),
    isPackaged: false,
    commandLine: { getSwitchValue: vi.fn(() => '') },
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    dock: { setIcon: vi.fn(), show: vi.fn() },
    quit,
    exit,
  });

  MockBrowserWindow.onAllClosed = () => {
    app.emit('window-all-closed');
  };

  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true });

  vi.doMock('electron', () => ({
    app,
    BrowserWindow: MockBrowserWindow,
    clipboard: { writeText: vi.fn(), writeImage: vi.fn() },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => ({ template })),
      setApplicationMenu: vi.fn(),
    },
    nativeImage: {
      createFromDataURL: vi.fn(() => ({ isEmpty: () => true })),
      createFromPath: vi.fn(() => ({ isEmpty: () => true })),
    },
    nativeTheme,
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
    screen: {
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
      getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
    },
    shell: {
      openExternal: vi.fn(async () => {}),
      openPath: vi.fn(async () => ''),
      showItemInFolder: vi.fn(),
    },
  }));

  vi.doMock('../src/main/core-service', () => ({
    CoreService: MockCoreService,
  }));

  vi.doMock('../src/main/ipc-router', () => ({
    registerIpcRouter: vi.fn((_ipcMain: unknown, svc: MockCoreService, contents: MockWebContents) => {
      const binding: RouterBinding = {
        service: svc,
        webContents: contents,
        disposed: false,
        disposeSpy: vi.fn(() => { binding.disposed = true; }),
      };
      routerBindings.push(binding);
      return binding.disposeSpy;
    }),
  }));

  const sigintBefore = new Set(process.listeners('SIGINT'));
  const sigtermBefore = new Set(process.listeners('SIGTERM'));

  await import('../src/main/index');
  await flushAsync(12);

  const cleanup = () => {
    MockBrowserWindow.onAllClosed = undefined;
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintBefore.has(listener)) process.off('SIGINT', listener);
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigtermBefore.has(listener)) process.off('SIGTERM', listener);
    }
  };
  activeCleanups.push(cleanup);

  return {
    app,
    nativeTheme,
    BrowserWindow: MockBrowserWindow,
    coreServices: MockCoreService.instances,
    routerBindings,
    getQuitCompletedCount: () => quitCompletedCount,
    cleanup,
  };
}

afterEach(() => {
  for (const cleanup of activeCleanups.splice(0)) cleanup();
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.unstubAllEnvs();
  vi.doUnmock('electron');
  vi.doUnmock('../src/main/core-service');
  vi.doUnmock('../src/main/ipc-router');
  vi.restoreAllMocks();
});

describe('Issue #3.3 (Decision D1) — macOS Dock 常驻与 activate 重建生命周期', () => {
  it('macOS (darwin) 关闭最后一个窗口时不退出进程、卸载 IPC 路由、保持 CoreService 存活且无监听器泄漏', async () => {
    const harness = await bootMainProcess('darwin');
    expect(harness.BrowserWindow.getAllWindows()).toHaveLength(1);
    expect(harness.coreServices).toHaveLength(1);
    expect(harness.routerBindings).toHaveLength(1);

    const firstWindow = harness.BrowserWindow.getAllWindows()[0];
    const service = harness.coreServices[0];

    firstWindow.close();
    await flushAsync();

    expect(harness.BrowserWindow.getAllWindows()).toHaveLength(0);
    expect(harness.app.quit).not.toHaveBeenCalled();
    expect(harness.getQuitCompletedCount()).toBe(0);
    expect(service.dispose).not.toHaveBeenCalled();
    expect(harness.routerBindings[0].disposeSpy).toHaveBeenCalled();
    expect(harness.routerBindings[0].disposed).toBe(true);
    expect(harness.nativeTheme.listenerCount('updated')).toBe(0);
    expect(service.listenerCount('locale-changed')).toBe(0);
  });

  it('macOS (darwin) 触发 activate 时在 0 窗口下重建窗口且不重复创建 CoreService，已有窗口时不重复开窗', async () => {
    const harness = await bootMainProcess('darwin');
    const firstWindow = harness.BrowserWindow.getAllWindows()[0];
    const originalService = harness.coreServices[0];

    firstWindow.close();
    await flushAsync();
    expect(harness.BrowserWindow.getAllWindows()).toHaveLength(0);

    // Simulate clicking the Dock icon when no windows are open.
    harness.app.emit('activate', {}, false);
    await flushAsync(12);

    expect(harness.BrowserWindow.getAllWindows()).toHaveLength(1);
    const reopenedWindow = harness.BrowserWindow.getAllWindows()[0];
    expect(reopenedWindow).not.toBe(firstWindow);
    expect(harness.coreServices).toHaveLength(1);
    expect(harness.coreServices[0]).toBe(originalService);
    expect(harness.routerBindings).toHaveLength(2);
    expect(harness.routerBindings[1].service).toBe(originalService);
    expect(harness.routerBindings[1].webContents).toBe(reopenedWindow.webContents);
    expect(harness.routerBindings[1].disposed).toBe(false);

    // Simulate clicking the Dock icon while a window already exists: must not create a duplicate window or CoreService.
    harness.app.emit('activate', {}, true);
    await flushAsync();

    expect(harness.BrowserWindow.getAllWindows()).toHaveLength(1);
    expect(harness.coreServices).toHaveLength(1);
    expect(harness.routerBindings).toHaveLength(2);
  });

  it('macOS (darwin) 显式 app.quit() 在有窗与 0 窗驻留状态下均正常释放 IPC 与 CoreService 并干净退出', async () => {
    // Scenario A: Quit while reopened window is active.
    const withWindow = await bootMainProcess('darwin');
    withWindow.BrowserWindow.getAllWindows()[0].close();
    await flushAsync();
    withWindow.app.emit('activate', {}, false);
    await flushAsync(12);
    expect(withWindow.routerBindings).toHaveLength(2);

    withWindow.app.quit();
    await flushAsync();

    expect(withWindow.routerBindings[1].disposed).toBe(true);
    expect(withWindow.coreServices[0].dispose).toHaveBeenCalledTimes(1);
    expect(withWindow.getQuitCompletedCount()).toBe(1);

    // Clean up Scenario A before booting Scenario B.
    withWindow.cleanup();

    // Scenario B: Quit from 0-window Dock-resident state (close window first, then Dock Quit / Cmd+Q).
    const dockResident = await bootMainProcess('darwin');
    dockResident.BrowserWindow.getAllWindows()[0].close();
    await flushAsync();
    expect(dockResident.BrowserWindow.getAllWindows()).toHaveLength(0);
    expect(dockResident.app.quit).not.toHaveBeenCalled();

    dockResident.app.quit();
    await flushAsync();

    expect(dockResident.routerBindings[0].disposed).toBe(true);
    expect(dockResident.coreServices[0].dispose).toHaveBeenCalledTimes(1);
    expect(dockResident.getQuitCompletedCount()).toBe(1);
  });

  it.each(['win32', 'linux'] as const)('%s 平台关闭最后一个窗口仍立即调用 app.quit() 并清理 CoreService', async platform => {
    const harness = await bootMainProcess(platform);
    expect(harness.BrowserWindow.getAllWindows()).toHaveLength(1);

    harness.BrowserWindow.getAllWindows()[0].close();
    await flushAsync();

    expect(harness.app.quit).toHaveBeenCalled();
    expect(harness.coreServices[0].dispose).toHaveBeenCalledTimes(1);
    expect(harness.getQuitCompletedCount()).toBe(1);
  });

  it('AST 结构守卫：src/main/index.ts（及可选 macos-lifecycle.ts）强制执行平台条件退出、activate 监听与安全沙箱标志', () => {
    const indexPath = path.resolve(__dirname, '../src/main/index.ts');
    const lifecyclePath = path.resolve(__dirname, '../src/main/macos-lifecycle.ts');
    const indexSource = readFileSync(indexPath, 'utf8');
    const inspectedFiles = [
      { filePath: indexPath, source: indexSource },
      ...(existsSync(lifecyclePath) ? [{ filePath: lifecyclePath, source: readFileSync(lifecyclePath, 'utf8') }] : []),
    ];

    let hasWindowAllClosed = false;
    let hasUnconditionalQuitOnAllClosed = false;
    let hasDarwinGuardNearAllClosed = false;
    let hasActivateRegistration = false;
    let hasBeforeQuitDispose = false;

    for (const { filePath, source } of inspectedFiles) {
      const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const firstArg = node.arguments[0];
          const secondArg = node.arguments[1];
          if ((method === 'on' || method === 'once') && firstArg && ts.isStringLiteral(firstArg)) {
            if (firstArg.text === 'window-all-closed' && secondArg) {
              hasWindowAllClosed = true;
              const handlerText = secondArg.getText(sf);
              if (/^\(\s*\)\s*=>\s*app\.quit\(\s*\)$/.test(handlerText.trim())) {
                hasUnconditionalQuitOnAllClosed = true;
              }
              if (/darwin|shouldQuitOnWindowAllClosed|platform/i.test(handlerText)) {
                hasDarwinGuardNearAllClosed = true;
              }
            }
            if (firstArg.text === 'activate') {
              hasActivateRegistration = true;
            }
            if (firstArg.text === 'before-quit' && secondArg) {
              const handlerText = secondArg.getText(sf);
              if (/dispose\s*\(/.test(handlerText) && /quit\s*\(/.test(handlerText)) {
                hasBeforeQuitDispose = true;
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    const hasLifecycleHelperDarwinGuard =
      existsSync(lifecyclePath) && /darwin/i.test(readFileSync(lifecyclePath, 'utf8'));
    const combinedSource = inspectedFiles.map(f => f.source).join('\n');

    expect(hasWindowAllClosed).toBe(true);
    expect(hasUnconditionalQuitOnAllClosed).toBe(false);
    expect(hasDarwinGuardNearAllClosed || hasLifecycleHelperDarwinGuard).toBe(true);
    expect(hasActivateRegistration).toBe(true);
    expect(hasBeforeQuitDispose || (/before-quit/.test(combinedSource) && /dispose\s*\(/.test(combinedSource))).toBe(true);

    // Electron BrowserWindow security sandbox redline must remain intact in src/main/index.ts.
    expect(indexSource).toMatch(/contextIsolation:\s*true/);
    expect(indexSource).toMatch(/nodeIntegration:\s*false/);
    expect(indexSource).toMatch(/sandbox:\s*true/);
    expect(indexSource).toMatch(/webSecurity:\s*true/);
  });
});
