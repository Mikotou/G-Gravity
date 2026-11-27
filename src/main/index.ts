import { app, BrowserWindow, clipboard, dialog, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateUserDataDirectory } from './storage/data-directory';
import { CoreService } from './core-service';
import { registerAppWindowLifecycle } from './macos-lifecycle';
import { clampUiScale } from '../shared/theme-i18n-contract';
import { getLiveWindow, iconPath, syncWindowChrome, openWindow, flushDesktopWindow, detachRouter, requestMicrophone } from './desktop/window-manager';
import { clipboardImage } from './desktop/clipboard-image';
import { canInstallUpdateDirectly, installDownloadedUpdate } from './updater/platform-installer';
import { launchLogin, stopLoginProcesses } from './accounts/login-launcher';
let service: CoreService | undefined;
let openingWindow: Promise<void> | undefined;
let lifecycle: ReturnType<typeof registerAppWindowLifecycle>;
function ensureService(): CoreService {
  if (service) return service;
  let macKeychainOk: boolean | undefined;
  // 把剪贴板、文件对话框等桌面能力注入业务层，测试可以替换这些回调而不用创建窗口。
  service = new CoreService({
    dataDir: app.getPath('userData'), appRoot: app.getAppPath?.(), requestMicrophone,
    acpOptions: { binaryPath: process.env.AGY_BINARY_PATH, loginLauncher: (binary, args = ['acp', '--login']) => {
      if (lifecycle.isQuitting()) throw new Error('客户端正在退出。');
      return launchLogin(binary, args, service?.getPreferences().locale);
    } },
    appVersion: app.getVersion(),
    enableAutoUpdateCheck: app.isPackaged,
    secretCipher: {
      isAvailable: (opts?: { passive?: boolean }) => {
        if (opts?.passive && process.platform === 'darwin' && macKeychainOk === undefined) return true;
        try { const ok = safeStorage.isEncryptionAvailable(); if (process.platform === 'darwin') macKeychainOk = ok; return ok; }
        catch { if (process.platform === 'darwin') macKeychainOk = false; return false; }
      },
      encrypt: (plaintext: string) => { const b = safeStorage.encryptString(plaintext); if (process.platform === 'darwin') macKeychainOk = true; return b; },
      decrypt: (ciphertext: Buffer) => { const s = safeStorage.decryptString(ciphertext); if (process.platform === 'darwin') macKeychainOk = true; return s; },
    },
    updaterOptions: {
      canInstallDirectly: canInstallUpdateDirectly(),
      installHandler: installDownloadedUpdate,
    },
    windowChrome: process.platform === 'win32' ? 'win-overlay' : process.platform === 'darwin' ? 'mac-inset' : 'standard',
    setIcon: id => {
      const targetPath = iconPath(id, service?.getPreferences());
      if (process.platform === 'darwin') app.dock?.setIcon(targetPath);
      else getLiveWindow()?.setIcon(targetPath);
    },
    setZoom: factor => {
      const clamped = clampUiScale(factor);
      getLiveWindow()?.webContents.setZoomFactor(clamped);
      if (service) syncWindowChrome({ ...service.getPreferences(), uiScale: clamped });
    },
    onThemeChanged: prefs => {
      syncWindowChrome(prefs);
      if (prefs.appIcon === 'auto') {
        const targetPath = iconPath('auto', prefs);
        if (process.platform === 'darwin') app.dock?.setIcon(targetPath);
        else getLiveWindow()?.setIcon(targetPath);
      }
    },
    copyTextHandler: text => {
      clipboard.writeText(text);
    },
    openTargetHandler: async (resolvedTarget, mode, isDir) => {
      if (mode === 'copy') {
        clipboard.writeText(resolvedTarget);
      } else if (mode === 'copy-image') {
        clipboard.writeImage(await clipboardImage(resolvedTarget, getLiveWindow()));
      } else if (mode === 'browser') {
        const url = new URL(resolvedTarget);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许打开 HTTP 或 HTTPS 网页');
        await shell.openExternal(url.href);
      } else if (mode === 'reveal-in-folder') {
        // Launch Services can execute a directory as an application bundle. Select it in Finder.
        if (!isDir || process.platform === 'darwin' || await shell.openPath(resolvedTarget).catch(() => 'failed')) shell.showItemInFolder(resolvedTarget);
      } else {
        const errMsg = await shell.openPath(resolvedTarget);
        if (errMsg) shell.showItemInFolder(resolvedTarget);
      }
    },
    selectDirectoryHandler: async (defaultPath) => {
      const owner = getLiveWindow() ?? BrowserWindow.getFocusedWindow() ?? undefined;
      const options: Electron.OpenDialogOptions = {
        defaultPath: defaultPath && existsSync(defaultPath) ? defaultPath : undefined,
        properties: ['openDirectory', 'createDirectory'],
      };
      const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    },
  });
  return service;
}
function createWindow(): Promise<void> {
  if (openingWindow) return openingWindow;
  if (lifecycle.isQuitting() || getLiveWindow()) return Promise.resolve();
  const starting = !service;
  const opening = app.whenReady().then(() => {
    if (!lifecycle.isQuitting()) return openWindow(ensureService(), {
      preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    }, () => {
      if (!process.env.AGY_RENDERER_URL) return;
      const url = new URL(process.env.AGY_RENDERER_URL);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('开发页面必须位于本机 127.0.0.1');
      return url;
    }, () => { openingWindow = undefined; });
  }).catch(error => {
    // A user can close (and reopen) the window while its first navigation is pending.
    if (openingWindow !== opening || lifecycle.isQuitting()) return;
    console.error('无法打开客户端窗口：', error instanceof Error ? error.message : '未知错误');
    getLiveWindow()?.destroy();
    if (starting && !lifecycle.isQuitting()) app.quit();
  }).finally(() => {
    if (openingWindow === opening) openingWindow = undefined;
  });
  openingWindow = opening;
  return opening;
}

async function cleanupBeforeQuit(): Promise<void> {
  flushDesktopWindow();
  if (service) await service.dispose(stopLoginProcesses);
  else await stopLoginProcesses();
  detachRouter();
}

app.setName('Gravity');
const override = app.commandLine.getSwitchValue('user-data-dir');
const userDataDir = validateUserDataDirectory(override || resolve(app.getPath('appData'), 'Gravity'));
app.setPath('userData', userDataDir);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (process.platform === 'win32') app.setAppUserModelId('com.gravity.desktop');
  lifecycle = registerAppWindowLifecycle({
    platform: process.platform, app, hasOpenWindow: () => Boolean(getLiveWindow()),
    getWindow: getLiveWindow, createWindow, cleanupBeforeQuit,
    cleanupFailed: error => {
      if (!getLiveWindow()) void createWindow();
      void dialog.showMessageBox({ type: 'error', message: '退出尚未完成', detail: String(error),
        buttons: ['重试保存并退出', '稍后重试'], cancelId: 1 }).then(({ response }) => { if (response === 0) app.quit(); });
    },
  });
  void createWindow();
  process.once('SIGINT', () => app.quit());
  process.once('SIGTERM', () => app.quit());
}
