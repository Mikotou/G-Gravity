import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell } from 'electron';
import { accessSync, constants, existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CoreService } from './core-service';
import { registerIpcRouter } from './ipc-router';
import type { AppUpdateState } from '../shared/ipc-channels';
import {
  GRAVITY_ICON_VARIANTS,
  THEME_PRESETS,
  clampUiScale,
  type ClientPreferences,
  type GravityIconId,
} from '../shared/theme-i18n-contract';

const execFileAsync = promisify(execFile);

function canWriteDirectory(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveMacAppBundlePath(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  const marker = '.app/Contents/MacOS/';
  const idx = process.execPath.indexOf(marker);
  if (idx < 0) return null;
  const bundlePath = process.execPath.slice(0, idx + 4);
  if (bundlePath.includes('/AppTranslocation/')) return null;
  return bundlePath;
}

function canInstallUpdateDirectly(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
    return Boolean(portableExe && existsSync(portableExe) && canWriteDirectory(dirname(portableExe)));
  }
  if (process.platform === 'darwin') {
    const appBundle = resolveMacAppBundlePath();
    return Boolean(appBundle && existsSync(appBundle) && canWriteDirectory(dirname(appBundle)));
  }
  return false;
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function installDownloadedUpdate(
  filePath: string,
  _state: AppUpdateState
): Promise<{ launched: boolean; message: string }> {
  const updatesDir = dirname(filePath);
  if (process.platform === 'win32') {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
    if (app.isPackaged && portableExe && existsSync(portableExe) && canWriteDirectory(dirname(portableExe))) {
      const scriptPath = join(updatesDir, 'apply-update.ps1');
      const backupPath = `${portableExe}.bak`;
      const psScript = [
        `$ErrorActionPreference = 'Stop'`,
        `$targetPid = ${process.pid}`,
        `$targetExe = ${psSingleQuote(portableExe)}`,
        `$newExe = ${psSingleQuote(filePath)}`,
        `$backupExe = ${psSingleQuote(backupPath)}`,
        `for ($i = 0; $i -lt 100; $i++) {`,
        `  if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }`,
        `  Start-Sleep -Milliseconds 300`,
        `}`,
        `Start-Sleep -Milliseconds 450`,
        `$swapped = $false`,
        `for ($attempt = 0; $attempt -lt 15; $attempt++) {`,
        `  try {`,
        `    if (Test-Path -LiteralPath $backupExe) { Remove-Item -LiteralPath $backupExe -Force -ErrorAction SilentlyContinue }`,
        `    if (Test-Path -LiteralPath $targetExe) { Move-Item -LiteralPath $targetExe -Destination $backupExe -Force }`,
        `    Copy-Item -LiteralPath $newExe -Destination $targetExe -Force`,
        `    $swapped = $true`,
        `    break`,
        `  } catch {`,
        `    if (-not (Test-Path -LiteralPath $targetExe) -and (Test-Path -LiteralPath $backupExe)) {`,
        `      Move-Item -LiteralPath $backupExe -Destination $targetExe -Force -ErrorAction SilentlyContinue`,
        `    }`,
        `    Start-Sleep -Milliseconds 350`,
        `  }`,
        `}`,
        `if ($swapped) {`,
        `  Start-Process -FilePath $targetExe`,
        `  Remove-Item -LiteralPath $backupExe -Force -ErrorAction SilentlyContinue`,
        `  Remove-Item -LiteralPath $newExe -Force -ErrorAction SilentlyContinue`,
        `}`,
      ].join('\r\n');
      await fs.writeFile(scriptPath, `\uFEFF${psScript}`, 'utf8');
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { detached: true, windowsHide: true, shell: false, stdio: 'ignore' }
      );
      child.unref();
      setTimeout(() => app.quit(), 150);
      return { launched: true, message: '正在退出并替换为新版本，随后自动重启 Gravity...' };
    }
    shell.showItemInFolder(filePath);
    return { launched: false, message: '已打开更新文件所在目录，请关闭当前窗口后运行新版 Gravity.exe。' };
  }

  if (process.platform === 'darwin') {
    const lower = filePath.toLowerCase();
    const appBundle = resolveMacAppBundlePath();
    if (lower.endsWith('.zip') && appBundle && existsSync(appBundle) && canWriteDirectory(dirname(appBundle))) {
      const stagingDir = join(updatesDir, `staged-${Date.now()}`);
      await fs.mkdir(stagingDir, { recursive: true });
      await execFileAsync('/usr/bin/ditto', ['-xk', filePath, stagingDir], { timeout: 120_000 });
      const entries = await fs.readdir(stagingDir);
      const appName = entries.find((name) => name.toLowerCase() === 'gravity.app')
        || entries.find((name) => name.toLowerCase().endsWith('.app'));
      if (!appName) {
        throw new Error('更新压缩包中未找到 Gravity.app');
      }
      const stagedApp = join(stagingDir, appName);
      await execFileAsync('/usr/bin/xattr', ['-cr', stagedApp], { timeout: 30_000 }).catch(() => undefined);
      const backupApp = `${appBundle}.bak`;
      const scriptPath = join(updatesDir, 'apply-update.sh');
      const shScript = [
        '#!/bin/sh',
        'set -eu',
        `TARGET_PID=${process.pid}`,
        `TARGET_APP=${posixSingleQuote(appBundle)}`,
        `STAGED_APP=${posixSingleQuote(stagedApp)}`,
        `BACKUP_APP=${posixSingleQuote(backupApp)}`,
        `STAGING_DIR=${posixSingleQuote(stagingDir)}`,
        `ARCHIVE_FILE=${posixSingleQuote(filePath)}`,
        'i=0',
        'while [ "$i" -lt 100 ]; do',
        '  if ! kill -0 "$TARGET_PID" 2>/dev/null; then break; fi',
        '  sleep 0.3',
        '  i=$((i + 1))',
        'done',
        'sleep 0.4',
        'rm -rf "$BACKUP_APP"',
        'mv "$TARGET_APP" "$BACKUP_APP"',
        'if mv "$STAGED_APP" "$TARGET_APP"; then',
        '  rm -rf "$BACKUP_APP" "$STAGING_DIR" "$ARCHIVE_FILE"',
        '  open -a "$TARGET_APP"',
        'else',
        '  mv "$BACKUP_APP" "$TARGET_APP" 2>/dev/null || true',
        '  exit 1',
        'fi',
      ].join('\n');
      await fs.writeFile(scriptPath, shScript, { encoding: 'utf8', mode: 0o700 });
      const child = spawn('/bin/sh', [scriptPath], { detached: true, shell: false, stdio: 'ignore' });
      child.unref();
      setTimeout(() => app.quit(), 150);
      return { launched: true, message: '正在替换 Gravity.app 并自动重启...' };
    }
    if (lower.endsWith('.dmg')) {
      const openErr = await shell.openPath(filePath);
      if (openErr) shell.showItemInFolder(filePath);
      return { launched: false, message: '已打开新版 .dmg 安装镜像，请将 Gravity.app 拖入“应用程序”完成覆盖。' };
    }
    shell.showItemInFolder(filePath);
    return { launched: false, message: '已打开更新包目录，请解压后替换应用程序中的 Gravity.app。' };
  }

  shell.showItemInFolder(filePath);
  return { launched: false, message: '已打开更新包目录，请手动完成版本替换。' };
}

function resolveWindowAppearance(prefs: ClientPreferences): {
  backgroundColor: string;
  symbolColor: string;
  overlayHeight: number;
} {
  let polarity: 'dark' | 'light' = 'dark';
  let backgroundColor = '#171513';
  if (prefs.theme === 'custom' && prefs.customTheme) {
    polarity = prefs.customTheme.polarity;
    backgroundColor = prefs.customTheme.tokens.bgApp || (polarity === 'light' ? '#faf8f5' : '#171513');
  } else if (prefs.theme === 'system') {
    polarity = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    const preset = THEME_PRESETS.find((t) => t.id === (polarity === 'light' ? 'claude-code-light' : 'claude-code-dark'));
    if (preset) backgroundColor = preset.tokens.bgApp;
  } else {
    const preset = THEME_PRESETS.find((t) => t.id === prefs.theme);
    if (preset) {
      polarity = preset.polarity;
      backgroundColor = preset.tokens.bgApp;
    }
  }
  const scale = clampUiScale(prefs.uiScale);
  return {
    backgroundColor,
    symbolColor: polarity === 'light' ? '#3d352e' : '#c9c0b5',
    overlayHeight: Math.max(32, Math.min(72, Math.round(44 * scale))),
  };
}

/** 窗口拦截到的导航统一从这里分流。网页和邮件交给系统处理，本地文件定位到所在目录。 */
function handleSafeLinkNavigation(rawUrl: string): void {
  try {
    const parsed = new URL(rawUrl);
    const proto = parsed.protocol.toLowerCase();
    if (proto === 'https:' || proto === 'http:' || proto === 'mailto:') {
      void shell.openExternal(parsed.toString());
      return;
    }
    if (proto === 'file:') {
      const cleanFileUrl = new URL(rawUrl);
      cleanFileUrl.hash = '';
      cleanFileUrl.search = '';
      const localPath = fileURLToPath(cleanFileUrl);
      if (existsSync(localPath)) {
        // 左键导航拦截：在资源管理器中安全定位本地文件
        shell.showItemInFolder(localPath);
      }
    }
  } catch {
    /* 忽略无效链接 */
  }
}

let window: BrowserWindow | undefined;
let service: CoreService | undefined;
let loginProcess: ChildProcess | undefined;
let disposeRouter: (() => void) | undefined;
let quitting = false;

/** 启动可见的官方登录程序。Promise 跟随进程退出，调用方据此解除登录互斥并刷新账号状态。 */
async function launchLogin(binary: string, args = ['acp', '--login']): Promise<void> {
  if (loginProcess) throw new Error('官方登录窗口已打开');
  await new Promise<void>((resolve, reject) => {
    // 登录按钮明确打开可见的官方终端；参数为固定字面量，路径使用 PowerShell 单引号转义。
    const quotedArgs = args.map(arg => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`).join(' ');
    const command = `$p = Start-Process -FilePath '${binary.replace(/'/g, "''")}' -ArgumentList '${quotedArgs.replace(/'/g, "''")}' -WindowStyle Normal -PassThru; $p.WaitForExit(); exit $p.ExitCode`;
    const posixShellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const macLoginCmd = [binary, ...args].map(posixShellQuote).join(' ');
    const appleScript = `tell application "Terminal"\nactivate\nset w to do script "${macLoginCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nrepeat while busy of w\ndelay 0.5\nend repeat\nend tell`;
    loginProcess = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, shell: false, stdio: 'ignore' })
      : process.platform === 'darwin'
        ? spawn('osascript', ['-e', appleScript], { shell: false, stdio: 'ignore' })
        : spawn(binary, args, { stdio: 'inherit', shell: false });
    loginProcess.once('error', () => { loginProcess = undefined; reject(new Error('无法打开官方登录终端')); });
    loginProcess.once('close', code => { loginProcess = undefined; code === 0 ? resolve() : reject(new Error('官方登录取消或未成功完成')); });
  });
}

async function createWindow(): Promise<void> {
  const iconPath = (id: GravityIconId) => {
    const variant = GRAVITY_ICON_VARIANTS.find(icon => icon.id === id); if (!variant) throw new Error('无效的 Gravity 图标');
    return join(__dirname, '../..', process.platform === 'win32' ? variant.assetIcoRelPath : variant.assetPngRelPath);
  };
  const windowChrome = process.platform === 'win32' ? 'win-overlay' : process.platform === 'darwin' ? 'mac-inset' : 'standard';
  const syncWindowChrome = (prefs?: ClientPreferences) => {
    if (!window || window.isDestroyed() || !prefs) return;
    const appearance = resolveWindowAppearance(prefs);
    window.setBackgroundColor(appearance.backgroundColor);
    if (process.platform === 'win32') {
      try {
        window.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: appearance.symbolColor,
          height: appearance.overlayHeight,
        });
      } catch {
        /* 某些旧系统环境不支持动态更新覆盖层时忽略 */
      }
    }
  };
  // 把剪贴板、文件对话框等桌面能力注入业务层，测试可以替换这些回调而不用创建窗口。
  service = new CoreService({
    dataDir: app.getPath('userData'),
    acpOptions: { binaryPath: process.env.AGY_BINARY_PATH, loginLauncher: launchLogin },
    appVersion: app.getVersion(),
    enableAutoUpdateCheck: app.isPackaged,
    updaterOptions: {
      canInstallDirectly: canInstallUpdateDirectly(),
      installHandler: installDownloadedUpdate,
    },
    windowChrome,
    setIcon: id => {
      if (process.platform === 'darwin') app.dock?.setIcon(iconPath(id));
      else window?.setIcon(iconPath(id));
    },
    setZoom: factor => {
      const clamped = clampUiScale(factor);
      window?.webContents.setZoomFactor(clamped);
      if (service) syncWindowChrome({ ...service.getPreferences(), uiScale: clamped });
    },
    onThemeChanged: prefs => { syncWindowChrome(prefs); },
    openTargetHandler: async (resolvedTarget, mode, isDir) => {
      if (mode === 'copy') {
        clipboard.writeText(resolvedTarget);
      } else if (mode === 'copy-image') {
        const img = resolvedTarget.startsWith('data:image/')
          ? nativeImage.createFromDataURL(resolvedTarget)
          : nativeImage.createFromPath(resolvedTarget);
        if (img.isEmpty()) throw new Error('无法读取图片数据以复制到剪贴板');
        clipboard.writeImage(img);
      } else if (mode === 'browser') {
        await shell.openExternal(resolvedTarget);
      } else if (mode === 'reveal-in-folder') {
        if (isDir) await shell.openPath(resolvedTarget);
        else shell.showItemInFolder(resolvedTarget);
      } else {
        const errMsg = await shell.openPath(resolvedTarget);
        if (errMsg) shell.showItemInFolder(resolvedTarget);
      }
    },
    selectDirectoryHandler: async (defaultPath) => {
      const owner = window ?? BrowserWindow.getFocusedWindow() ?? undefined;
      const options: Electron.OpenDialogOptions = {
        defaultPath: defaultPath && existsSync(defaultPath) ? defaultPath : undefined,
        properties: ['openDirectory', 'createDirectory'],
      };
      const res = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    },
  });
  const preferences = service.getPreferences();
  const initialAppearance = resolveWindowAppearance(preferences);
  // 首次窗口尺寸按主显示器可用区域取比例，在 2K/4K 屏上不会显得过小，在小屏上也不会超出屏幕。
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(960, Math.min(1760, Math.round(work.width * 0.86)));
  const height = Math.max(640, Math.min(1120, Math.round(work.height * 0.88)));
  window = new BrowserWindow({
    width, height, minWidth: 960, minHeight: 640, title: 'Gravity', backgroundColor: initialAppearance.backgroundColor, icon: iconPath(preferences.appIcon),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: initialAppearance.symbolColor,
            height: initialAppearance.overlayHeight,
          },
        }
      : process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 14, y: 15 },
          }
        : {}),
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  const onNativeThemeUpdated = () => { if (service) syncWindowChrome(service.getPreferences()); };
  nativeTheme.on('updated', onNativeThemeUpdated);
  window.once('closed', () => { nativeTheme.removeListener('updated', onNativeThemeUpdated); });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    app.dock?.setIcon(iconPath(preferences.appIcon));
  } else {
    Menu.setApplicationMenu(null);
  }
  // 缩放倍率由偏好决定。页面每次加载完成后重新写入，避免导航重置 zoomFactor。
  window.webContents.on('did-finish-load', () => { window?.webContents.setZoomFactor(clampUiScale(service?.getPreferences().uiScale)); });
  // 同时拦截弹窗和当前页导航，让点击消息中的链接时工作台仍停留在原页面。
  window.webContents.setWindowOpenHandler(({ url }) => {
    handleSafeLinkNavigation(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url && url !== window?.webContents.getURL()) {
      handleSafeLinkNavigation(url);
    }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  disposeRouter = registerIpcRouter(ipcMain, service, window.webContents);
  const developmentUrl = process.env.AGY_RENDERER_URL;
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('开发页面必须位于本机 127.0.0.1');
    await window.loadURL(url.toString());
  } else await window.loadFile(join(__dirname, '../renderer/index.html'));
  window.on('closed', () => { window = undefined; });
}

app.setName('Gravity');
const userDataDir = app.commandLine.getSwitchValue('user-data-dir') || join(app.getPath('appData'), 'Gravity');
app.setPath('userData', userDataDir);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (process.platform === 'win32') app.setAppUserModelId('com.gravity.desktop');
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(createWindow).catch(error => { console.error('客户端启动失败：', error instanceof Error ? error.message : '未知错误'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  process.once('SIGINT', () => app.quit());
  process.once('SIGTERM', () => app.quit());
  // 先注销窗口路由，再等待服务收尾。第二次 quit 由 quitting 标记放行，防止递归触发清理。
  app.on('before-quit', event => {
    if (quitting) return; event.preventDefault(); quitting = true; disposeRouter?.();
    if (loginProcess?.pid && process.platform === 'win32') { const child = spawn('taskkill.exe', ['/PID', String(loginProcess.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }); child.on('error', () => loginProcess?.kill()); }
    else loginProcess?.kill();
    void (service?.dispose() || Promise.resolve()).catch(() => console.error('关闭时保存客户端账本失败，ACP 已执行清理')).finally(() => app.quit());
  });
}
