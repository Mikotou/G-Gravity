import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import type { ClientLocale } from '@shared';
import { UI_DICTIONARIES, type UiDictionary } from './locales';

type ShortcutLabel = (key: string, style?: 'keycap') => string;
const controlShortcut: ShortcutLabel = (key, style) => `Ctrl${style === 'keycap' ? ' ' : '+'}${key}`;
const commandShortcut: ShortcutLabel = key => `⌘${key}`;

/** 不含主修饰键的组合键（Shift / Alt / Enter / Tab / Esc）。macOS 输出原生符号 ⇧ ⌥ ↩ ⇥，其他平台保持原有文字。 */
export type KeyName = 'shift' | 'alt' | 'enter' | 'tab' | 'esc';
type KeysLabel = (parts: KeyName[], style?: 'keycap') => string;
const PC_KEY_NAMES: Record<KeyName, string> = { shift: 'Shift', alt: 'Alt', enter: 'Enter', tab: 'Tab', esc: 'Esc' };
const MAC_KEY_NAMES: Record<KeyName, string> = { shift: '⇧', alt: '⌥', enter: '↩', tab: '⇥', esc: 'Esc' };
const pcKeys: KeysLabel = (parts, style) => parts.map(p => PC_KEY_NAMES[p]).join(style === 'keycap' ? ' ' : '+');
const macKeys: KeysLabel = parts => parts.map(p => MAC_KEY_NAMES[p]).join('');

/** 将词典中固定的 Enter / Shift+Enter / Shift+Tab 键名换成 macOS 符号；仅作用于下列已知的按键提示字段。 */
function macKeyText(text: string): string {
  return text
    .replace(/Shift\+Enter/g, macKeys(['shift', 'enter']))
    .replace(/Shift\+Tab/g, macKeys(['shift', 'tab']))
    .replace(/\bEnter\b/g, macKeys(['enter']));
}

function shortcutDictionary(dict: UiDictionary, shortcut: ShortcutLabel, mac = false): UiDictionary {
  const withShortcuts: UiDictionary = {
    ...dict,
    sidebarToggleShow: `${dict.sidebarToggleShow} (${shortcut('B')})`,
    sidebarToggleHide: `${dict.sidebarToggleHide} (${shortcut('B')})`,
    inspectorToggleShow: `${dict.inspectorToggleShow} (${shortcut('J')})`,
    inspectorToggleHide: `${dict.inspectorToggleHide} (${shortcut('J')})`,
  };
  if (!mac) return withShortcuts;
  return {
    ...withShortcuts,
    sendMessageBtn: macKeyText(dict.sendMessageBtn),
    modeCycleHint: macKeyText(dict.modeCycleHint),
    composerHint: macKeyText(dict.composerHint),
    ui: {
      ...dict.ui,
      welcomeQuickPlaceholder: macKeyText(dict.ui.welcomeQuickPlaceholder),
      welcomeQuickHint: macKeyText(dict.ui.welcomeQuickHint),
    },
  };
}

export interface I18nContextValue {
  locale: ClientLocale;
  dict: UiDictionary;
  setLocale: (next: ClientLocale) => void;
  shortcut: ShortcutLabel;
  /** 平台化的 Shift / Alt / Enter / Tab 组合键文案，例如 keys(['shift', 'tab'])：Windows 为 Shift+Tab，macOS 为 ⇧⇥。 */
  keys: KeysLabel;
  /** 是否运行在 macOS（mac-inset 窗口）。用于 ⌘ / Ctrl 修饰键判断与「访达 / 文件夹」等平台文案。 */
  mac: boolean;
}

// 未包裹 Provider 的独立组件使用简体中文默认值，单独渲染预览或测试时也有完整词典。
const I18nContext = createContext<I18nContextValue>({
  locale: 'zh-CN',
  dict: shortcutDictionary(UI_DICTIONARIES['zh-CN'], controlShortcut),
  setLocale: () => {},
  shortcut: controlShortcut,
  keys: pcKeys,
  mac: false,
});

export interface I18nProviderProps {
  locale: ClientLocale;
  onChangeLocale: (next: ClientLocale) => void;
  macShortcuts?: boolean;
  children: React.ReactNode;
}

export function I18nProvider({
  locale,
  onChangeLocale,
  macShortcuts = false,
  children,
}: I18nProviderProps): React.ReactElement {
  const onChangeLocaleRef = useRef(onChangeLocale);
  onChangeLocaleRef.current = onChangeLocale;
  const setLocale = useCallback((next: ClientLocale) => {
    onChangeLocaleRef.current(next);
  }, []);

  // 在同一次更新中派生 locale 和词典，保证两者对应。稳定化 setLocale 引用，避免上层流式刷新触发全树 Context 级联重渲染。
  const value = useMemo<I18nContextValue>(() => {
    const safeLocale: ClientLocale = locale === 'en-US' ? 'en-US' : 'zh-CN';
    const shortcut = macShortcuts ? commandShortcut : controlShortcut;
    return {
      locale: safeLocale,
      dict: shortcutDictionary(UI_DICTIONARIES[safeLocale], shortcut, macShortcuts),
      setLocale,
      shortcut,
      keys: macShortcuts ? macKeys : pcKeys,
      mac: macShortcuts,
    };
  }, [locale, setLocale, macShortcuts]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
