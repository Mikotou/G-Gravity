import { ClipboardList, FilePenLine, Shield, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import type { AgentExecutionMode } from '@shared';

/**
 * U-03：执行模式统一矢量图标（替换 Windows 字体下错位的 `⏵⏵` / `⏸` / `›` 原始 Unicode 字形）。
 * Composer 模式药丸、模式菜单与设置页共用同一张映射，确保同一语义只有一个图形。
 */
export const EXECUTION_MODE_ICONS: Readonly<Record<AgentExecutionMode, LucideIcon>> = Object.freeze({
  default: Shield,
  plan: ClipboardList,
  'accept-edits': FilePenLine,
  'full-access': Zap,
  auto: Sparkles,
});
