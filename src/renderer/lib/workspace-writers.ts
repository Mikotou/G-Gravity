import { createContext, useContext } from 'react';
import type { ClientPreferences, WorkspaceLayoutState } from '@shared';
import { getDesktopBridge } from '../services/desktop-bridge';

/**
 * 深层组件写入偏好与布局时统一经由 App 的串行队列（`preferenceWrites` / `patchLayout`），
 * 避免绕过 App 状态后被下一次整体布局保存覆盖。脱离 App 单独挂载（测试）时退回直接调用桥接。
 */
export interface WorkspaceWriters {
  updatePreferences(patch: Partial<ClientPreferences>): Promise<unknown>;
  patchLayout(patch: Partial<WorkspaceLayoutState>): Promise<unknown>;
}

const directWriters: WorkspaceWriters = {
  updatePreferences: (patch) => getDesktopBridge().updatePreferences(patch),
  patchLayout: (patch) => getDesktopBridge().saveWorkspaceLayout(patch),
};

export const WorkspaceWritersContext = createContext<WorkspaceWriters | null>(null);

export function useWorkspaceWriters(): WorkspaceWriters {
  return useContext(WorkspaceWritersContext) ?? directWriters;
}
