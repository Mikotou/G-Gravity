import type { BrowserWindow, Input, MenuItemConstructorOptions } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { uiScaleCommandForKey, type ClientLocale, type UiScaleCommand } from '../shared/theme-i18n-contract';

/** The application menu stays live in the Dock after its renderer closes. */
export function sendMacZoomCommand(window: BrowserWindow | undefined, command: UiScaleCommand): void {
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  if (!contents.isDestroyed()) contents.send(IPC_CHANNELS.EVENT_UI_SCALE_COMMAND, command);
}

export function macApplicationMenu(locale: ClientLocale, zoom: (command: UiScaleCommand) => void): MenuItemConstructorOptions[] {
  const zh = locale === 'zh-CN';
  return [
    { role: 'appMenu' }, { role: 'editMenu' },
    { label: zh ? '视图' : 'View', submenu: [
      { id: 'gravity-size-actual', label: zh ? '实际大小' : 'Actual Size', accelerator: 'Command+0', click: () => zoom('reset') },
      { id: 'gravity-size-in', label: zh ? '放大' : 'Zoom In', accelerator: 'Command+Plus', click: () => zoom('increase') },
      { id: 'gravity-size-out', label: zh ? '缩小' : 'Zoom Out', accelerator: 'Command+-', click: () => zoom('decrease') },
      { type: 'separator' }, { role: 'togglefullscreen', id: 'gravity-fullscreen', label: zh ? '切换全屏' : 'Toggle Full Screen' },
    ] },
    { role: 'windowMenu' },
  ];
}

export function macKeyboardZoom(input: Pick<Input, 'type' | 'meta' | 'control' | 'alt' | 'key' | 'isComposing'>): UiScaleCommand | undefined {
  if (input.type === 'keyDown' && input.meta && !input.control && !input.alt && !input.isComposing) {
    return uiScaleCommandForKey(input.key);
  }
  return undefined;
}
