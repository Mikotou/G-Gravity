import React, { createContext, useContext, useMemo } from 'react';
import type { ClientLocale } from '@shared';
import { UI_DICTIONARIES, type UiDictionary } from './locales';

export interface I18nContextValue {
  locale: ClientLocale;
  dict: UiDictionary;
  setLocale: (next: ClientLocale) => void;
}

// 未包裹 Provider 的独立组件使用简体中文默认值，单独渲染预览或测试时也有完整词典。
const I18nContext = createContext<I18nContextValue>({
  locale: 'zh-CN',
  dict: UI_DICTIONARIES['zh-CN'],
  setLocale: () => {},
});

export interface I18nProviderProps {
  locale: ClientLocale;
  onChangeLocale: (next: ClientLocale) => void;
  children: React.ReactNode;
}

export function I18nProvider({
  locale,
  onChangeLocale,
  children,
}: I18nProviderProps): React.ReactElement {
  // 在同一次更新中派生 locale 和词典，保证两者对应。切换语言交给上层回调，偏好保存在统一入口。
  const value = useMemo<I18nContextValue>(() => {
    const safeLocale: ClientLocale = locale === 'en-US' ? 'en-US' : 'zh-CN';
    return {
      locale: safeLocale,
      dict: UI_DICTIONARIES[safeLocale],
      setLocale: onChangeLocale,
    };
  }, [locale, onChangeLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
