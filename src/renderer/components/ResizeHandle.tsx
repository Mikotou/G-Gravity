import React, { useEffect, useRef, useState } from 'react';

/**
 * 通用拖拽分隔条：鼠标拖动实时预览、释放时提交一次；双击恢复默认；
 * 键盘方向键微调（Shift 加大步长），Home / End 跳到边界。
 *
 * - `axis="x"`：横向拖动（调整宽度或左右比例），`axis="y"`：纵向拖动（调整高度）。
 * - `direction`：指针沿正方向（右 / 下）移动时数值的变化方向，1 表示变大，-1 表示变小。
 * - `unitPx`：数值每变化 1 对应的像素。像素宽度为 1；比例值传入容器尺寸。
 */
export interface ResizeHandleProps {
  value: number;
  min: number;
  max: number | (() => number);
  defaultValue: number;
  direction?: 1 | -1;
  axis?: 'x' | 'y';
  unitPx?: number | (() => number);
  step?: number;
  label: string;
  className?: string;
  testId?: string;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function ResizeHandle({
  value,
  min,
  max,
  defaultValue,
  direction = 1,
  axis = 'x',
  unitPx = 1,
  step,
  label,
  className = '',
  testId,
  onPreview,
  onCommit,
}: ResizeHandleProps): React.ReactElement {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(value);
  latest.current = value;
  const resolveMax = () => Math.max(min, typeof max === 'function' ? max() : max);
  const unit = () => Math.max(1, typeof unitPx === 'function' ? unitPx() : unitPx);
  const keyStep = step ?? (unit() === 1 ? 16 : 0.02);
  // 拖拽进行中组件被卸载（例如收起侧栏）时，移除全局监听与 body 光标锁，避免界面永久卡在调整状态。
  const activeDragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    activeDragCleanup.current?.();
    activeDragCleanup.current = null;
  }, []);

  function startDrag(e: React.MouseEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startValue = value;
    const px = unit();
    const ceiling = resolveMax();
    let current = startValue;
    setDragging(true);
    document.body.classList.add('gv-resizing', axis === 'x' ? 'gv-resizing-x' : 'gv-resizing-y');
    function onMove(ev: MouseEvent): void {
      const delta = ((axis === 'x' ? ev.clientX : ev.clientY) - start) / px;
      current = clamp(startValue + direction * delta, min, ceiling);
      onPreview(current);
    }
    function detach(): void {
      document.body.classList.remove('gv-resizing', 'gv-resizing-x', 'gv-resizing-y');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      activeDragCleanup.current = null;
    }
    // 拖拽中窗口失焦（Alt+Tab、系统弹窗）收不到 mouseup：以当前预览值提交并释放全局拖拽锁。
    function onUp(): void {
      setDragging(false);
      detach();
      onCommit(current);
    }
    activeDragCleanup.current?.();
    activeDragCleanup.current = detach;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    const big = e.shiftKey ? 4 : 1;
    const dec = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const inc = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    const ceiling = resolveMax();
    let next: number | null = null;
    if (e.key === dec) next = latest.current - direction * keyStep * big;
    else if (e.key === inc) next = latest.current + direction * keyStep * big;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = ceiling;
    else if (e.key === 'Enter') next = defaultValue;
    if (next === null) return;
    e.preventDefault();
    next = clamp(next, min, ceiling);
    onPreview(next);
    onCommit(next);
  }

  const currentMax = resolveMax();
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={Math.round(min * 100) / 100}
      aria-valuemax={Math.round(currentMax * 100) / 100}
      aria-valuenow={Math.round(value * 100) / 100}
      title={label}
      className={`resize-handle axis-${axis} ${dragging ? 'is-dragging' : ''} ${className}`.trim()}
      onMouseDown={startDrag}
      onDoubleClick={() => {
        onPreview(defaultValue);
        onCommit(defaultValue);
      }}
      onKeyDown={onKeyDown}
      data-testid={testId}
    />
  );
}
