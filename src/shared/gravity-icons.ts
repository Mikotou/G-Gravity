/**
 * Gravity v0.3.6 — 原创 Gravity C4 Deep Well 多配色应用图标变体目录（纯叶模块，零内部依赖）
 *
 * 100% 原创 C4 Deep Well 深井引力徽标，提供 SVG + PNG + 1024px HIG macOS PNG + .ico。
 * 注意：`resolveEffectiveGravityIconId` 保留在 `theme-i18n-contract.ts` 以保持零循环依赖。
 */

export type GravityIconId =
  | 'gravity-claude-dark'
  | 'gravity-claude-light'
  | 'gravity-ubuntu'
  | 'gravity-macos-dark'
  | 'gravity-macos-light'
  | 'gravity-solarized';

/** 应用图标偏好：'auto' 表示跟随当前生效主题的 recommendedIconId，其余为手动锁定指定原创图标 */
export type GravityIconPreference = GravityIconId | 'auto';

export interface GravityIconVariant {
  id: GravityIconId;
  nameZh: string;
  nameEn: string;
  accentHex: string;
  bgHex: string;
  /** 前端渲染层相对路径（位于 public/icons/） */
  publicSvgUrl: string;
  /** 工程根目录下真实图标资产相对路径（Linux 窗格） */
  assetPngRelPath: string;
  /** macOS Apple HIG 留白规范 1024×1024 Dock 专用 PNG 相对路径 */
  assetMacPngRelPath: string;
  assetIcoRelPath: string;
}

export const GRAVITY_ICON_VARIANTS: readonly GravityIconVariant[] = [
  {
    id: 'gravity-claude-dark',
    nameZh: 'Gravity · Terracotta Dark',
    nameEn: 'Gravity · Terracotta Dark',
    accentHex: '#d97757',
    bgHex: '#1c1917',
    publicSvgUrl: './icons/gravity-claude-dark.svg',
    assetPngRelPath: 'assets/icons/gravity-claude-dark.png',
    assetMacPngRelPath: 'assets/icons/gravity-claude-dark-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-claude-dark.ico',
  },
  {
    id: 'gravity-claude-light',
    nameZh: 'Gravity · Terracotta Light',
    nameEn: 'Gravity · Terracotta Light',
    accentHex: '#c6613f',
    bgHex: '#f8f4ec',
    publicSvgUrl: './icons/gravity-claude-light.svg',
    assetPngRelPath: 'assets/icons/gravity-claude-light.png',
    assetMacPngRelPath: 'assets/icons/gravity-claude-light-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-claude-light.ico',
  },
  {
    id: 'gravity-ubuntu',
    nameZh: 'Gravity · Ubuntu Aubergine',
    nameEn: 'Gravity · Ubuntu Aubergine',
    accentHex: '#e95420',
    bgHex: '#300a24',
    publicSvgUrl: './icons/gravity-ubuntu.svg',
    assetPngRelPath: 'assets/icons/gravity-ubuntu.png',
    assetMacPngRelPath: 'assets/icons/gravity-ubuntu-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-ubuntu.ico',
  },
  {
    id: 'gravity-macos-dark',
    nameZh: 'Gravity · macOS Graphite',
    nameEn: 'Gravity · macOS Graphite',
    accentHex: '#0a84ff',
    bgHex: '#26272b',
    publicSvgUrl: './icons/gravity-macos-dark.svg',
    assetPngRelPath: 'assets/icons/gravity-macos-dark.png',
    assetMacPngRelPath: 'assets/icons/gravity-macos-dark-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-macos-dark.ico',
  },
  {
    id: 'gravity-macos-light',
    nameZh: 'Gravity · macOS Silver',
    nameEn: 'Gravity · macOS Silver',
    accentHex: '#007aff',
    bgHex: '#fafafc',
    publicSvgUrl: './icons/gravity-macos-light.svg',
    assetPngRelPath: 'assets/icons/gravity-macos-light.png',
    assetMacPngRelPath: 'assets/icons/gravity-macos-light-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-macos-light.ico',
  },
  {
    id: 'gravity-solarized',
    nameZh: 'Gravity · Solarized',
    nameEn: 'Gravity · Solarized',
    accentHex: '#2aa198',
    bgHex: '#05323e',
    publicSvgUrl: './icons/gravity-solarized.svg',
    assetPngRelPath: 'assets/icons/gravity-solarized.png',
    assetMacPngRelPath: 'assets/icons/gravity-solarized-mac.png',
    assetIcoRelPath: 'assets/icons/gravity-solarized.ico',
  },
] as const;

export function isGravityIconPreference(value: unknown): value is GravityIconPreference {
  return value === 'auto' || GRAVITY_ICON_VARIANTS.some((icon) => icon.id === value);
}
