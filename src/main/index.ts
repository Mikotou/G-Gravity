import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CoreService } from './core-service';
import { registerIpcRouter } from './ipc-router';
import { GRAVITY_ICON_VARIANTS, clampUiScale, type GravityIconId } from '../shared/theme-i18n-contract';

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
  // 把剪贴板、文件对话框等桌面能力注入业务层，测试可以替换这些回调而不用创建窗口。
  service = new CoreService({
    dataDir: app.getPath('userData'),
    acpOptions: { binaryPath: process.env.AGY_BINARY_PATH, loginLauncher: launchLogin },
    setIcon: id => {
      if (process.platform === 'darwin') app.dock?.setIcon(iconPath(id));
      else window?.setIcon(iconPath(id));
    },
    setZoom: factor => { window?.webContents.setZoomFactor(clampUiScale(factor)); },
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
  // 首次窗口尺寸按主显示器可用区域取比例，在 2K/4K 屏上不会显得过小，在小屏上也不会超出屏幕。
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(960, Math.min(1760, Math.round(work.width * 0.86)));
  const height = Math.max(640, Math.min(1120, Math.round(work.height * 0.88)));
  window = new BrowserWindow({
    width, height, minWidth: 960, minHeight: 640, title: 'Gravity', backgroundColor: '#171513', icon: iconPath(preferences.appIcon),
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
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
