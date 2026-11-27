import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanArtifactOwner, PlanArtifactSnapshot } from '../../shared/session-contract';
import { isPrivateStatePath, isUnsafeLocalFile, sameLocalPath } from '../workspace/local-path-safety';
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
  accounts?: AccountManager,
  verifyPlan?: (owner: PlanArtifactOwner) => Promise<PlanArtifactSnapshot>
): Promise<OpenLinkOrFileResult> {
  if (!input || typeof input.target !== 'string' || !input.target.trim()) {
    throw new Error('无效的目标链接或路径');
  }
  if (!['browser', 'default-app', 'reveal-in-folder', 'copy', 'copy-image'].includes(input.action)) {
    throw new Error('无效的打开动作');
  }
  let rawTarget = input.target.trim();
  let verifiedPath: string | undefined;
  if (input.planArtifactOwner !== undefined) {
    const owner = input.planArtifactOwner;
    if (!owner || !verifyPlan || (input.sessionId !== undefined && input.sessionId !== owner.sessionId) ||
        !['default-app', 'reveal-in-folder', 'copy'].includes(input.action)) throw new Error('无效的 Plan 产物归属或操作');
    if (rawTarget.length > 4096) throw new Error('无效的本地文件路径');
    let requested = rawTarget;
    try { if (/^file:/i.test(rawTarget)) requested = fileURLToPath(rawTarget); }
    catch { throw new Error('无效的本地文件 URL'); }
    const snapshot = await verifyPlan({ profileId: owner.profileId, sessionId: owner.sessionId });
    if (snapshot.status !== 'ready' || !snapshot.filePath || snapshot.owner.sessionId !== owner.sessionId ||
        snapshot.owner.profileId !== owner.profileId || (owner.revision !== undefined && owner.revision !== snapshot.revision) ||
        (accounts && (accounts.busy || accounts.activeProfileId !== owner.profileId)) ||
        !isAbsolute(requested) || isUnsafeLocalFile(requested) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rawTarget.replace(/%2e/ig, '.')) ||
        !sameLocalPath(snapshot.filePath, requested)) throw new Error('Plan 产物归属、路径或修订已改变');
    verifiedPath = rawTarget = snapshot.filePath;
    input = { ...input, sessionId: owner.sessionId, cwd: undefined };
  }
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
  if ((verifiedPath && (result.kind !== 'found' || !sameLocalPath(verifiedPath, localPath))) ||
      (!verifiedPath && basename(localPath).toLowerCase() === 'implementation_plan.md' && isPrivateStatePath(localPath))) {
    throw new Error('需要核验当前会话的 Plan 产物');
  }
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
