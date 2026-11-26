import { getDesktopBridge } from '../services/desktop-bridge';

/**
 * U-01：统一纯文本复制入口。
 *
 * Electron 生产页位于 `file://` 且主进程禁用了全部 Chromium 权限，渲染层 `navigator.clipboard.writeText`
 * 会被静默拒绝。因此优先走主进程受控 IPC `copyText`（`clipboard.writeText`，≤ 4 MB、仅主 frame），
 * 仅当桥接不可用或调用失败时回退浏览器 Clipboard API（`vite dev` / 测试夹具）。
 *
 * 成功返回 `true`；两条路径都失败时返回 `false`，调用方据此决定是否展示失败提示。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const bridge = getDesktopBridge();
    if (typeof bridge.copyText === 'function') {
      await bridge.copyText(text);
      return true;
    }
  } catch {
    // 桥接缺失或主进程拒绝：继续尝试浏览器剪贴板
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 浏览器剪贴板同样不可用
  }
  return false;
}
