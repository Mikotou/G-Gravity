/**
 * 平台化键盘判断（纯函数，无副作用）。
 *
 * - macOS 的主修饰键是 ⌘（metaKey）。Ctrl 在 macOS 文本框里是 Emacs 风格的光标移动键
 *   （Ctrl+B 左移、Ctrl+N 下一行、Ctrl+A 行首等），工作台快捷键不能抢占这些按键。
 * - Windows / Linux 的主修饰键是 Ctrl。Win / Super 键由系统处理，同样不作为应用快捷键。
 */
export interface ModifierState {
  ctrlKey: boolean;
  metaKey: boolean;
}

/** 当前平台的主修饰键是否按下（且未混入另一个修饰键）：macOS 为 ⌘，其他平台为 Ctrl。 */
export function isPrimaryModifier(e: ModifierState, mac: boolean): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * 输入法是否正在组词。macOS 的拼音 / 日文输入法在确认或取消候选时，
 * Chromium 会派发 `isComposing === true` 或 `keyCode === 229` 的 keydown（例如回车上屏、Esc 取消候选）。
 */
export function isImeComposing(e: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }): boolean {
  return Boolean(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229);
}
