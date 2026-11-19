// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CoreService, DEFAULT_LAYOUT } from '../src/main/core-service';
import { clampSplitRatio, clampUiScale, LAYOUT_LIMITS, UI_SCALE_LIMITS } from '../src/shared';

/** v0.1.5：分屏比例、栏宽修复与界面缩放的主进程契约。不连接 ACP，只校验本地偏好与布局持久化。 */
function setup(saved?: { layout?: object; preferences?: object }) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-v015-'));
  if (saved?.layout) writeFileSync(path.join(dataDir, 'layout.json'), JSON.stringify(saved.layout));
  if (saved?.preferences) writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify(saved.preferences));
  const setZoom = vi.fn();
  const core = new CoreService({ dataDir, setZoom, homeDir: path.join(dataDir, 'home'), historyRoots: [] });
  return { core, setZoom, cleanup: async () => { await core.dispose(); rmSync(dataDir, { recursive: true, force: true }); } };
}

describe('v0.1.5 布局与缩放契约', () => {
  it('共享钳制函数覆盖边界与非法值', () => {
    expect(clampSplitRatio(undefined)).toBe(0.5);
    expect(clampSplitRatio(0.1)).toBe(LAYOUT_LIMITS.splitRatio.min);
    expect(clampSplitRatio(0.9)).toBe(LAYOUT_LIMITS.splitRatio.max);
    expect(clampUiScale('big')).toBe(UI_SCALE_LIMITS.default);
    expect(clampUiScale(1.234)).toBe(1.25);
    expect(clampUiScale(9)).toBe(UI_SCALE_LIMITS.max);
    expect(DEFAULT_LAYOUT.splitRatio).toBe(0.5);
  });

  it('保存分屏比例并拒绝越界值，原布局保持不变', async () => {
    const { core, cleanup } = setup();
    try {
      expect((await core.saveWorkspaceLayout({ splitRatio: 0.62, leftSidebarWidth: 320 }))).toMatchObject({ splitRatio: 0.62, leftSidebarWidth: 320 });
      await expect(core.saveWorkspaceLayout({ splitRatio: 0.95 })).rejects.toThrow('分屏比例无效');
      await expect(core.saveWorkspaceLayout({ leftSidebarWidth: 90 })).rejects.toThrow('栏宽无效');
      expect((await core.saveWorkspaceLayout({})).splitRatio).toBe(0.62);
    } finally { await cleanup(); }
  });

  it('启动时修复越界的栏宽、比例与缩放，后续保存不再被旧坏值阻塞', async () => {
    const { core, cleanup } = setup({
      layout: { leftSidebarWidth: 2000, rightInspectorWidth: 10, splitRatio: 3 },
      preferences: { uiScale: 7 },
    });
    try {
      const layout = await core.saveWorkspaceLayout({ activeInspectorTab: 'plan' });
      expect(layout.leftSidebarWidth).toBe(LAYOUT_LIMITS.leftSidebarWidth.max);
      expect(layout.rightInspectorWidth).toBe(LAYOUT_LIMITS.rightInspectorWidth.min);
      expect(layout.splitRatio).toBe(LAYOUT_LIMITS.splitRatio.max);
      expect(core.getPreferences().uiScale).toBe(UI_SCALE_LIMITS.max);
    } finally { await cleanup(); }
  });

  it('界面缩放经校验后写入偏好，并只在倍率变化时通知窗口', async () => {
    const { core, setZoom, cleanup } = setup();
    try {
      expect((await core.updatePreferences({ uiScale: 1.25 })).uiScale).toBe(1.25);
      expect(setZoom).toHaveBeenCalledExactlyOnceWith(1.25);
      await core.updatePreferences({ locale: 'en-US' });
      expect(setZoom).toHaveBeenCalledTimes(1);
      await expect(core.updatePreferences({ uiScale: 3 })).rejects.toThrow('界面缩放倍率无效');
      await expect(core.updatePreferences({ uiScale: Number.NaN })).rejects.toThrow('界面缩放倍率无效');
      expect(core.getPreferences().uiScale).toBe(1.25);
    } finally { await cleanup(); }
  });
});
