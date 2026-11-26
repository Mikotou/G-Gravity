import React, { useEffect, useRef, useState } from 'react';
import { isImeComposing } from '../../lib/platform-keys';

type NativeInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'>;

export interface DraftNumberInputProps extends NativeInputProps {
  value: number;
  min: number;
  max: number;
  /** 清空或输入无效后失焦时回落的数值（默认回到当前值）。 */
  fallback?: number;
  integer?: boolean;
  /** 输入中只要解析为有限数字就实时上报原始值（不钳制）；失焦 / Enter 时上报钳制后的最终值。 */
  onValueChange: (value: number) => void;
}

/**
 * 以字符串草稿承载编辑中的数字：退格清空时不会立即回弹成 `0`，
 * 失焦或按 Enter 时再解析并钳制到 `[min, max]`，空值回落到 `fallback`。
 */
export function DraftNumberInput({
  value,
  min,
  max,
  fallback,
  integer = false,
  onValueChange,
  onBlur,
  onKeyDown,
  ...rest
}: DraftNumberInputProps): React.ReactElement {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(String(value));
  }, [value]);

  function commit(): void {
    editing.current = false;
    const parsed = text.trim() === '' ? NaN : Number(text);
    const base = Number.isFinite(parsed) ? parsed : fallback ?? value;
    const rounded = integer ? Math.round(base) : base;
    const next = Math.min(max, Math.max(min, rounded));
    setText(String(next));
    onValueChange(next);
  }

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      inputMode={rest.inputMode ?? (integer ? 'numeric' : 'decimal')}
      value={text}
      onChange={(e) => {
        editing.current = true;
        const nextText = e.target.value;
        setText(nextText);
        const n = nextText.trim() === '' ? NaN : Number(nextText);
        if (Number.isFinite(n)) onValueChange(Math.max(0, n));
      }}
      onBlur={(e) => {
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !isImeComposing(e)) {
          e.preventDefault();
          commit();
        }
        onKeyDown?.(e);
      }}
    />
  );
}
