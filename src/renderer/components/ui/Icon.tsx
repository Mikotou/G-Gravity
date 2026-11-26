import React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/**
 * 统一矢量图标规范（v0.3.4 五维重塑 · 图标维度）
 *
 * - 尺寸仅允许 4 档枚举：`xs = 12` / `sm = 14` / `md = 16` / `lg = 18`，杜绝 10/11/13/15/17px 混用造成的光学错位；
 * - 固定 `absoluteStrokeWidth`，不同尺寸下线宽一致（1.75px），在 Windows 100%–200% DPI 下保持清晰；
 * - 默认 `aria-hidden="true"` 纯装饰；传入 `label` 时改为 `role="img"` + `aria-label`，
 *   但纯图标按钮应把 `aria-label` 写在按钮上，而不是图标上。
 */
export type IconSize = 'xs' | 'sm' | 'md' | 'lg';

export const ICON_SIZE_PX: Readonly<Record<IconSize, number>> = Object.freeze({
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
});

export const ICON_STROKE_WIDTH = 1.75;

export interface IconProps extends Omit<LucideProps, 'size' | 'ref' | 'absoluteStrokeWidth'> {
  icon: LucideIcon;
  size?: IconSize;
  /** 仅当图标本身承载语义（无相邻文字/按钮标签）时提供 */
  label?: string;
}

export function Icon({ icon: Glyph, size = 'md', label, strokeWidth, ...rest }: IconProps): React.ReactElement {
  const a11y = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);
  return (
    <Glyph
      size={ICON_SIZE_PX[size]}
      strokeWidth={strokeWidth ?? ICON_STROKE_WIDTH}
      absoluteStrokeWidth
      focusable="false"
      {...a11y}
      {...rest}
    />
  );
}
