import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen, shell, systemPreferences } from 'electron';
import { chromeColors } from './chrome-colors';
import { join } from 'node:path';
import { resolveLocalTarget } from '../services/local-media-inspector';
import { CoreService } from '../core-service';
import { registerIpcRouter } from '../ipc-router';
import { macApplicationMenu, macKeyboardZoom, sendMacZoomCommand } from '../macos-menu';
import {
  GRAVITY_ICON_VARIANTS, THEME_PRESETS, clampUiScale, resolveEffectiveGravityIconId,
  type ClientPreferences, type ClientLocale, type GravityIconPreference,
} from '../../shared/theme-i18n-contract';

function resolveWindowAppearance(prefs: ClientPreferences): {
  backgroundColor: string;
  symbolColor: string;
  overlayHeight: number;
} {
  const id = prefs.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'claude-code-dark' : 'claude-code-light') : prefs.theme;
  const theme = (id === 'custom' && prefs.customTheme) || THEME_PRESETS.find(item => item.id === id) || THEME_PRESETS[0];
  return {
    ...chromeColors(theme.tokens.bgApp, theme.tokens.textSecondary, theme.polarity === 'light'),
    overlayHeight: Math.round(44 * clampUiScale(prefs.uiScale)),
  };
}

/** 窗口拦截到的导航统一从这里分流。网页交给系统浏览器处理，本地文件定位到所在目录。 */
function handleSafeLinkNavigation(rawUrl: string): void {
  try {
    const parsed = new URL(rawUrl);
    const proto = parsed.protocol.toLowerCase();
    if (proto === 'https:' || proto === 'http:') {
      void shell.openExternal(parsed.toString());
      return;
    }
    if (proto === 'file:') {
      const local = resolveLocalTarget(rawUrl, {}, {});
      if (local.kind === 'found') shell.showItemInFolder(local.path);
    }
  } catch {
    /* 忽略无效链接 */
  }
}

let window: BrowserWindow | undefined;
let disposeRouter: (() => void) | undefined;
let flushWindowState: (() => void) | undefined;
export function getLiveWindow(): BrowserWindow | undefined {
  return window?.isDestroyed() ? undefined : window;
}

export function detachRouter(): void {
  disposeRouter?.();
  disposeRouter = undefined;
}

export function iconPath(id: GravityIconPreference, prefs?: Pick<ClientPreferences, 'theme' | 'customTheme'>): string {
  const effectiveId = resolveEffectiveGravityIconId(
    id,
    prefs?.theme,
    prefs?.customTheme,
    !nativeTheme.shouldUseDarkColors
  );
  const variant = GRAVITY_ICON_VARIANTS.find(icon => icon.id === effectiveId) ?? GRAVITY_ICON_VARIANTS[0];
  const asset = process.platform === 'darwin' ? variant.assetMacPngRelPath :
    process.platform === 'win32' ? variant.assetIcoRelPath : variant.assetPngRelPath;
  return join(__dirname, '../../..', asset);
}

function macButtonPosition(scale?: number) {
  return { x: Math.round(14 * clampUiScale(scale)), y: Math.round(15 * clampUiScale(scale)) };
}
export async function requestMicrophone(): Promise<boolean> {
  return process.platform !== 'darwin' || systemPreferences.askForMediaAccess('microphone');
}

export function syncWindowChrome(prefs: ClientPreferences): void {
  const target = getLiveWindow();
  if (!target) return;
  const appearance = resolveWindowAppearance(prefs);
  if (process.platform === 'darwin') target.setWindowButtonPosition(macButtonPosition(prefs.uiScale));
  target.setBackgroundColor(appearance.backgroundColor);
  if (process.platform === 'win32') {
    try {
      target.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: appearance.symbolColor,
        height: appearance.overlayHeight,
      });
    } catch {
      /* 某些旧系统环境不支持动态更新覆盖层时忽略 */
    }
  }
}

function updateMacMenu(locale: ClientLocale): void {
  const template = macApplicationMenu(locale, command => sendMacZoomCommand(window, command));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export async function openWindow(service: CoreService, webPreferences: Electron.WebPreferences, developmentUrl: () => URL | undefined, onClose: () => void): Promise<void> {
  const preferences = service.getPreferences();
  const initialAppearance = resolveWindowAppearance(preferences);
  // 优先恢复上次保存的窗口位置、尺寸与最大化状态；若显示器配置变更导致越界，则安全回退到主屏工作区。
  const primaryWork = screen.getPrimaryDisplay().workArea;
  const fallbackWidth = Math.max(960, Math.min(1760, Math.round(primaryWork.width * 0.86)));
  const fallbackHeight = Math.max(640, Math.min(1120, Math.round(primaryWork.height * 0.88)));
  interface SavedWindowState {
    bounds?: { x?: number; y?: number; width?: number; height?: number };
    maximized?: boolean;
  }
  const savedWindowState = service.store.read<SavedWindowState>('window-state.json', {});
  let winWidth = fallbackWidth;
  let winHeight = fallbackHeight;
  let winX: number | undefined;
  let winY: number | undefined;
  const sb = savedWindowState?.bounds;
  if (
    sb &&
    typeof sb.width === 'number' && Number.isFinite(sb.width) &&
    typeof sb.height === 'number' && Number.isFinite(sb.height)
  ) {
    const displays = screen.getAllDisplays();
    const hasCoords = typeof sb.x === 'number' && Number.isFinite(sb.x) && typeof sb.y === 'number' && Number.isFinite(sb.y);
    const matchingDisplay = hasCoords
      ? displays.find((d) => {
          const wa = d.workArea;
          const overlapX = Math.min(sb.x! + sb.width!, wa.x + wa.width) - Math.max(sb.x!, wa.x);
          const overlapY = Math.min(sb.y! + sb.height!, wa.y + wa.height) - Math.max(sb.y!, wa.y);
          return overlapX >= 120 && overlapY >= 80;
        })
      : undefined;
    const targetWork = matchingDisplay?.workArea ?? primaryWork;
    winWidth = Math.max(960, Math.min(targetWork.width, Math.round(sb.width)));
    winHeight = Math.max(640, Math.min(targetWork.height, Math.round(sb.height)));
    if (matchingDisplay && hasCoords) {
      winX = Math.round(Math.min(targetWork.x + targetWork.width - 120, Math.max(targetWork.x, sb.x!)));
      winY = Math.round(Math.min(targetWork.y + targetWork.height - 80, Math.max(targetWork.y, sb.y!)));
    }
  }
  const mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    ...(winX !== undefined && winY !== undefined ? { x: winX, y: winY } : {}),
    minWidth: 960, minHeight: 640, title: 'Gravity', backgroundColor: initialAppearance.backgroundColor, icon: iconPath(preferences.appIcon, preferences),
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
            trafficLightPosition: macButtonPosition(preferences.uiScale),
          }
        : {}),
    webPreferences,
  });
  detachRouter();
  window = mainWindow;
  let windowStateTimer: NodeJS.Timeout | undefined;
  const onNativeThemeUpdated = () => {
    const prefs = service.getPreferences();
    syncWindowChrome(prefs);
    if (prefs.appIcon === 'auto') {
      const path = iconPath('auto', prefs);
      if (process.platform === 'darwin') app.dock?.setIcon(path);
      else mainWindow.setIcon(path);
    }
  };
  const onLocaleChanged = (locale: ClientLocale) => updateMacMenu(locale);
  mainWindow.once('closed', () => {
    nativeTheme.off('updated', onNativeThemeUpdated);
    service.off('locale-changed', onLocaleChanged);
    clearTimeout(windowStateTimer);
    if (window !== mainWindow) return;
    detachRouter();
    flushWindowState = undefined;
    window = undefined;
    onClose();
  });
  if (savedWindowState?.maximized) mainWindow.maximize();
  const saveWindowStateNow = () => {
    clearTimeout(windowStateTimer);
    windowStateTimer = undefined;
    if (mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    service.store.write('window-state.json', { bounds, maximized });
  };
  flushWindowState = saveWindowStateNow;
  const trySaveWindowState = () => {
    try { saveWindowStateNow(); } catch { service.emit('diagnostic', '窗口位置保存失败'); }
  };
  const scheduleSaveWindowState = () => {
    clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(trySaveWindowState, 250);
    windowStateTimer.unref();
  };
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('maximize', scheduleSaveWindowState);
  mainWindow.on('unmaximize', scheduleSaveWindowState);
  mainWindow.on('close', event => {
    if (process.platform === 'win32') { event.preventDefault(); app.quit(); }
    else trySaveWindowState();
  });
  nativeTheme.on('updated', onNativeThemeUpdated);
  const contents = mainWindow.webContents;
  if (process.platform === 'darwin') {
    updateMacMenu(preferences.locale);
    service.on('locale-changed', onLocaleChanged);
    contents.on('before-input-event', (event, input) => {
      const command = macKeyboardZoom(input);
      if (command) {
        // Prevent both Chromium's key event and this key's menu accelerator from handling it again.
        event.preventDefault();
        sendMacZoomCommand(mainWindow, command);
      }
    });
    app.dock?.setIcon(iconPath(preferences.appIcon, preferences));
  } else {
    Menu.setApplicationMenu(null);
  }
  // 缩放倍率由偏好决定。页面每次加载完成后重新写入，避免导航重置 zoomFactor。
  contents.on('did-finish-load', () => contents.setZoomFactor(clampUiScale(service.getPreferences().uiScale)));
  // 同时拦截弹窗和当前页导航，让点击消息中的链接时工作台仍停留在原页面。
  contents.setWindowOpenHandler(({ url }) => {
    handleSafeLinkNavigation(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url && url !== contents.getURL()) {
      handleSafeLinkNavigation(url);
    }
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  const url = developmentUrl();
  const page = join(__dirname, '../../renderer/index.html');
  const trustedUrl = url?.href ?? pathToFileURL(page).href;
  const trustedFrame = (sender: Electron.WebContents | null, details: { isMainFrame: boolean; requestingUrl?: string }) =>
    sender === contents && !contents.isDestroyed() && contents.getURL() === trustedUrl &&
    contents.mainFrame.url === trustedUrl && details.isMainFrame === true && details.requestingUrl === trustedUrl &&
    service.voice.captures.hasLease;
  contents.session.setPermissionRequestHandler((sender, permission, callback, details) => {
    const media = (details as Electron.MediaAccessPermissionRequest).mediaTypes;
    callback(permission === 'media' && trustedFrame(sender, details) && media?.length === 1 && media[0] === 'audio');
  });
  const documentUrl = new URL(trustedUrl);
  const documentOrigin = (origin: string) => documentUrl.protocol === 'file:'
    ? origin === 'file://' || origin === 'file:///' || origin === trustedUrl
    : origin === documentUrl.origin || origin === documentUrl.origin + '/' || origin === trustedUrl;
  contents.session.setPermissionCheckHandler((sender, permission, origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && !details.embeddingOrigin && documentOrigin(origin) &&
    (!details.securityOrigin || documentOrigin(details.securityOrigin)) && trustedFrame(sender, details));
  contents.session.setDisplayMediaRequestHandler?.((_request, callback) => callback({}));
  contents.on('did-start-navigation', details => {
    if (details.isMainFrame) service.voice.revoke('window-closed');
  });
  mainWindow.on('unresponsive', () => {
    const active = service.voice.captures.summaries().activeCapture;
    if (active?.state === 'armed' || active?.state === 'capturing') {
      service.voice.revoke('device-error');
      contents.forcefullyCrashRenderer();
    }
  });
  contents.on('render-process-gone', () => service.voice.revoke('window-closed'));
  const unbind = registerIpcRouter(ipcMain, service, contents, trustedUrl);
  const session = contents.session;
  disposeRouter = () => {
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_sender, _permission, callback) => callback(false));
    unbind();
  };
  if (url) await mainWindow.loadURL(url.toString());
  else await mainWindow.loadFile(page);
}

export function flushDesktopWindow(): void {
  flushWindowState?.();
}
