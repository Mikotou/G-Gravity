import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRAVITY_ICON_VARIANTS, TECHNICAL_GLOSSARY_KEEP_ENGLISH, THEME_PRESETS } from '../src/shared';
import { applyThemePreference, subscribeSystemThemeChange } from '../src/renderer/styles/theme';
import { UI_DICTIONARIES } from '../src/renderer/i18n/locales';
import { I18nProvider, useI18n } from '../src/renderer/i18n/I18nContext';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('原生主题与双语基础组件', () => {
  it.each(THEME_PRESETS)('六套主题实际写入根节点：$id', (preset) => {
    applyThemePreference(preset.id);
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe(preset.id);
    expect(root.getAttribute('data-polarity')).toBe(preset.polarity);
    expect(root.style.getPropertyValue('--bg-app')).toBe(preset.tokens.bgApp);
    expect(root.style.getPropertyValue('--text-primary')).toBe(preset.tokens.textPrimary);
    expect(root.style.getPropertyValue('--status-danger')).toBe(preset.tokens.statusDanger);
    expect(root.style.colorScheme).toBe(preset.polarity);
  });
  it('跟随系统浅色偏好，注销后不再触发主题监听', () => {
    const listeners = new Set<Function>();
    const media = { matches: true, addEventListener: (_event: string, callback: Function) => listeners.add(callback), removeEventListener: (_event: string, callback: Function) => listeners.delete(callback) };
    vi.stubGlobal('matchMedia', () => media);
    expect(applyThemePreference('system').id).toBe('claude-code-light');
    const callback = vi.fn(); const unsubscribe = subscribeSystemThemeChange(callback);
    for (const listener of listeners) listener(); expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe(); expect(listeners.size).toBe(0);
  });
  it('中英文键完整一致，中文说明/错误不遗漏翻译且专业术语允许保留', () => {
    function flatten(value: unknown, prefix = ''): Record<string, string> {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        typeof child === 'string' ? [[`${prefix}${key}`, child]] : Object.entries(flatten(child, `${prefix}${key}.`))));
    }
    const zh = flatten(UI_DICTIONARIES['zh-CN']); const en = flatten(UI_DICTIONARIES['en-US']);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const properNames = new Set<string>(['English', 'API', 'Model', 'Effort', 'MCP Servers', ...TECHNICAL_GLOSSARY_KEEP_ENGLISH,
      ...THEME_PRESETS.flatMap((preset) => [preset.nameZh, preset.nameEn]), ...GRAVITY_ICON_VARIANTS.map((icon) => icon.nameZh)]);
    // v0.2允许英文专业标签；只对说明、错误、提示等完整文案强制中文。
    const untranslated = Object.entries(zh).filter(([key, label]) => /desc|error|hint|explanation|placeholder|warning|empty|subtitle|reason/i.test(key) && /[A-Za-z]{3}/.test(label) && !/[\u3400-\u9fff]/.test(label) && !properNames.has(label));
    expect(untranslated).toEqual([]);
    expect(Object.values(zh).every((label) => label.trim().length > 0)).toBe(true);
  });
  it('Provider 热切语言后消费者更新，切换回调携带正确 locale', () => {
    function Consumer() {
      const { dict, setLocale } = useI18n();
      return <button onClick={() => setLocale('en-US')}>{dict.newSession}</button>;
    }
    const change = vi.fn();
    const view = render(<I18nProvider locale="zh-CN" onChangeLocale={change}><Consumer /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: UI_DICTIONARIES['zh-CN'].newSession }));
    expect(change).toHaveBeenCalledWith('en-US');
    view.rerender(<I18nProvider locale="en-US" onChangeLocale={change}><Consumer /></I18nProvider>);
    expect(screen.getByRole('button', { name: UI_DICTIONARIES['en-US'].newSession })).toBeTruthy();
  });
});
