import type { BrowserWindow } from 'electron';

interface AppWindowLifecycleOptions {
  platform: NodeJS.Platform;
  app: {
    on(event: 'window-all-closed' | 'activate' | 'second-instance', listener: () => void): unknown;
    on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
    quit(): void;
    exit(code: number): void;
  };
  hasOpenWindow(): boolean;
  getWindow(): Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'restore' | 'focus'> | null | undefined;
  createWindow(): void | Promise<void>;
  cleanupBeforeQuit(): void | Promise<void>;
  cleanupFailed?(error: unknown): void;
}

export function registerAppWindowLifecycle({
  platform, app, hasOpenWindow, getWindow, createWindow, cleanupBeforeQuit, cleanupFailed,
}: AppWindowLifecycleOptions) {
  let quitting = false;
  app.on('window-all-closed', () => {
    if (platform !== 'darwin' && !quitting) app.quit();
  });
  app.on('activate', () => {
    if (!quitting && !hasOpenWindow()) void createWindow();
  });
  app.on('second-instance', () => {
    if (quitting) return;
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      void createWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('before-quit', async event => {
    // A second quit must also wait for the first one's pending writes and process cleanup.
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    try { await cleanupBeforeQuit(); }
    catch (error) {
      quitting = false;
      if (cleanupFailed) cleanupFailed(error);
      else console.error('关闭时未能完整清理客户端资源', error);
      return;
    }
    app.exit(0);
  });
  return { isQuitting: () => quitting };
}
