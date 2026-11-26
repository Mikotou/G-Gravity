import { statSync } from 'node:fs';
import { isExecutableTarget, resolveLocalTarget, type LocalTargetContext } from './local-media-inspector';
import type { CoreServiceOptions } from '../core-contracts';
import type { AccountManager } from '../accounts/account-manager';
import type { OpenLinkOrFileInput, OpenLinkOrFileResult } from '../../shared/ipc-channels';
export function localTargetContext(homeDir?: string, accounts?: AccountManager): LocalTargetContext {
  const profile = accounts?.getState().profiles.find(p => p.profileId === accounts.activeProfileId);
  return { homeDir, appDataRoot: profile?.isolatedAppDataDir };
}

/** 将消息里的链接或路径解析为系统操作。相对文件依会话目录定位，解析后的本地路径再经过敏感路径检查。 */
export async function openExternalTarget(
  input: OpenLinkOrFileInput,
  options: Pick<CoreServiceOptions, 'openTargetHandler' | 'homeDir'>,
  accounts?: AccountManager
): Promise<OpenLinkOrFileResult> {
  if (!input || typeof input.target !== 'string' || !input.target.trim()) {
    throw new Error('无效的目标链接或路径');
  }
  if (!['browser', 'default-app', 'reveal-in-folder', 'copy', 'copy-image'].includes(input.action)) {
    throw new Error('无效的打开动作');
  }
  const rawTarget = input.target.trim();
  const isDataImage = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(rawTarget);
  if (input.action === 'copy-image' && isDataImage) {
    if (rawTarget.length > 28 * 1024 * 1024) throw new Error('图片数据超过剪贴板大小限制');
    await options.openTargetHandler?.(rawTarget, 'copy-image');
    return { opened: true, modeUsed: 'copy-image', resolvedTarget: 'data:image' };
  }
  if (rawTarget.length > 4096) {
    throw new Error('无效的目标链接或路径');
  }
  if (/^(?:https?|mailto):/i.test(rawTarget)) {
    if (input.action === 'copy-image') {
      throw new Error('远程图片请先转换为本机图片数据后再复制');
    }
    const parsed = new URL(rawTarget);
    const mode: OpenLinkOrFileResult['modeUsed'] = input.action === 'copy' ? 'copy' : 'browser';
    if (mode === 'browser' && parsed.protocol === 'mailto:') throw new Error('仅允许打开 HTTP 或 HTTPS 网页');
    await options.openTargetHandler?.(parsed.toString(), mode);
    return { opened: true, modeUsed: mode, resolvedTarget: parsed.toString() };
  }

  const result = resolveLocalTarget(rawTarget, input, localTargetContext(options.homeDir, accounts));
  if (result.kind === 'forbidden') throw new Error('拒绝打开敏感凭据或私有状态文件');
  if (result.kind === 'missing' && (!result.path || input.action !== 'copy')) {
    throw new Error('本地文件或目录不存在，或相对路径缺少工作区');
  }
  const localPath = result.path!;
  if (input.action === 'copy') {
    await options.openTargetHandler?.(localPath, 'copy');
    return { opened: true, modeUsed: 'copy', resolvedTarget: localPath };
  }
  const stat = statSync(localPath);
  const isDir = stat.isDirectory();
  if (input.action === 'copy-image' && isDir) throw new Error('无法将目录作为图片复制');
  if (!isDir && !stat.isFile()) throw new Error('不支持的本地文件类型');
  const executable = result.kind === 'found' && isExecutableTarget(localPath, result.candidatePath, stat);
  const modeUsed = input.action === 'browser' || input.action === 'default-app'
    ? isDir || executable ? 'reveal-in-folder' : 'default-app'
    : input.action;

  await options.openTargetHandler?.(localPath, modeUsed, isDir);
  return { opened: true, modeUsed, resolvedTarget: localPath };
}
