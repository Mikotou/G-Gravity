import { createContext, useContext, useEffect } from 'react';

/** F-10：设置页各分区上报「存在未保存草稿」。SettingsView 汇总后对 Esc / ✕ / Ctrl+, 关闭做二次确认。 */
export type SettingsDirtyReporter = (key: string, dirty: boolean) => void;

export const SettingsDirtyContext = createContext<SettingsDirtyReporter>(() => {});

export function useSettingsDirty(key: string, dirty: boolean): void {
  const report = useContext(SettingsDirtyContext);
  useEffect(() => {
    report(key, dirty);
    return () => report(key, false);
  }, [key, dirty, report]);
}
