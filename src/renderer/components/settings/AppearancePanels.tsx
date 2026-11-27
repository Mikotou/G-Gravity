import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, Monitor, Upload } from 'lucide-react';
import {
  GRAVITY_ICON_VARIANTS,
  isValidCssColorToken,
  THEME_PRESETS,
  THEME_TOKEN_KEYS,
  type ClientPreferences,
  type CustomThemeConfig,
  type GravityIconPreference,
  type GravityIconVariant,
  type ThemePaletteTokens,
  type ThemePolarity,
  type ThemePreference,
  type ThemePreset,
} from '@shared';
import { usePrefsFeedback } from './usePrefsFeedback';
import { useI18n } from '../../i18n/I18nContext';
import { formatActionError } from '../../i18n/locales';
import { DARK_THEME_PRESETS, LIGHT_THEME_PRESETS, resolveGravityIconVariant } from '../../styles/theme';
import { Icon } from '../ui/Icon';

/** 原生取色器需要六位十六进制值。这里展开短写、去除透明度或转换常见 RGB，仅用于取色器的显示。 */
function toPickerHex(value: string): string {
  const v = (value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7);
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
  if (rgb) {
    const hex = (n: string) => Math.min(255, Math.max(0, Number(n))).toString(16).padStart(2, '0');
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
  }
  return '#888888';
}

function ThemePreview({ tokens }: { tokens: ThemePaletteTokens }): React.ReactElement {
  return (
    <div className="theme-preview" style={{ border: `1px solid ${tokens.borderSubtle}` }}>
      <div className="theme-preview-side" style={{ background: tokens.bgSidebar }}>
        <i style={{ background: tokens.textSecondary, width: '80%' }} />
        <i style={{ background: tokens.accentPrimary, width: '60%', opacity: 1 }} />
        <i style={{ background: tokens.textMuted, width: '70%' }} />
        <i style={{ background: tokens.textMuted, width: '50%' }} />
      </div>
      <div className="theme-preview-main" style={{ background: tokens.bgApp }}>
        <i style={{ background: tokens.textPrimary, width: '70%' }} />
        <i style={{ background: tokens.textSecondary, width: '90%', opacity: 0.7 }} />
        <i style={{ background: tokens.diffAddedText, width: '45%', opacity: 0.8 }} />
        <div className="theme-preview-input" style={{ background: tokens.bgSurface, border: `1px solid ${tokens.borderStrong}` }}>
          <b style={{ background: tokens.accentPrimary }} />
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  preset,
  selected,
  onSelect,
}: {
  preset: ThemePreset;
  selected: boolean;
  onSelect: (id: ThemePreference) => void;
}): React.ReactElement {
  const { locale } = useI18n();
  return (
    <button
      type="button"
      className={`theme-card ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(preset.id)}
      title={locale === 'zh-CN' ? preset.descriptionZh : preset.descriptionEn}
      data-testid={`theme-card-${preset.id}`}
    >
      <ThemePreview tokens={preset.tokens} />
      <span className="theme-card-name">
        <span className="truncate">{locale === 'zh-CN' ? preset.nameZh : preset.nameEn}</span>
        {selected && <Icon icon={Check} size="sm" />}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ 外观 */

export function ThemesPanel({
  preferences,
  onUpdatePreferences,
}: {
  preferences: ClientPreferences;
  onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>;
}): React.ReactElement {
  const { dict } = useI18n();
  const { save, feedback } = usePrefsFeedback(onUpdatePreferences);
  const select = (id: ThemePreference) => void save({ theme: id });
  return (
    <div className="settings-section">
      {feedback}
      <div className="settings-group">
        <button
          type="button"
          className="setting-row"
          style={{ textAlign: 'left', minHeight: 44 }}
          onClick={() => select('system')}
          title={dict.themeSystemDesc}
          data-testid="theme-system-option"
        >
          <span className="list-icon" style={{ width: 28, height: 28 }}>
            <Icon icon={Monitor} size="md" />
          </span>
          <span className="setting-label">{dict.themeSystemOption}</span>
          <span className="spacer" />
          {preferences.theme === 'system' && <Icon icon={Check} size="md" color="var(--accent-text, var(--accent-primary))" />}
        </button>
      </div>

      {preferences.customTheme && (
        <>
          <h3 className="settings-group-title">{dict.ui.copy.savedCustomPalette}</h3>
          <section className="theme-grid" data-testid="theme-group-custom">
            <button
              type="button"
              className={`theme-card ${preferences.theme === 'custom' ? 'is-selected' : ''}`}
              onClick={() => select('custom')}
              title={preferences.customTheme.name}
              data-testid="theme-card-custom"
            >
              <ThemePreview tokens={preferences.customTheme.tokens} />
              <span className="theme-card-name">
                <span className="truncate">{preferences.customTheme.name}</span>
                {preferences.theme === 'custom' && <Icon icon={Check} size="sm" />}
              </span>
            </button>
          </section>
        </>
      )}

      <h3 className="settings-group-title">{dict.themeDarkGroup}</h3>
      <section className="theme-grid" data-testid="theme-group-dark">
        {DARK_THEME_PRESETS.map((p) => (
          <ThemeCard key={p.id} preset={p} selected={preferences.theme === p.id} onSelect={select} />
        ))}
      </section>

      <h3 className="settings-group-title">{dict.themeLightGroup}</h3>
      <section className="theme-grid" data-testid="theme-group-light">
        {LIGHT_THEME_PRESETS.map((p) => (
          <ThemeCard key={p.id} preset={p} selected={preferences.theme === p.id} onSelect={select} />
        ))}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ 自定义配色 */

const TOKEN_GROUPS: ReadonlyArray<{ key: keyof ReturnType<typeof useI18n>['dict']['tokenGroups']; tokens: (keyof ThemePaletteTokens)[] }> = [
  { key: 'surfaces', tokens: ['bgApp', 'bgSidebar', 'bgSurface', 'bgElevated', 'bgCode', 'borderSubtle', 'borderStrong'] },
  { key: 'text', tokens: ['textPrimary', 'textSecondary', 'textMuted'] },
  { key: 'accent', tokens: ['accentPrimary', 'accentSoft'] },
  { key: 'status', tokens: ['statusSuccess', 'statusWarning', 'statusDanger'] },
  { key: 'diff', tokens: ['diffAddedBg', 'diffAddedText', 'diffRemovedBg', 'diffRemovedText'] },
  { key: 'syntax', tokens: ['syntaxKeyword', 'syntaxString', 'syntaxFunction', 'syntaxComment'] },
];

export function TokensPanel({
  preferences,
  onUpdatePreferences,
  onImportCustomTheme,
  onExportCustomTheme,
}: {
  preferences: ClientPreferences;
  onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>;
  onImportCustomTheme: (jsonText: string) => Promise<void>;
  onExportCustomTheme: () => Promise<string>;
}): React.ReactElement {
  const { locale, dict } = useI18n();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  // 已有自定义主题时沿用其草稿，否则复制基础预设，使逐项编辑不会直接改动预设颜色表。
  const base = THEME_PRESETS.find((p) => p.id === preferences.theme) ?? THEME_PRESETS[0];
  const [draft, setDraft] = useState<CustomThemeConfig>(
    preferences.customTheme ?? { name: 'My Gravity Theme', polarity: base.polarity, baseThemeId: base.id, tokens: { ...base.tokens } }
  );
  const dirtyRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saveTimerRef = useRef<number | null>(null);
  const onUpdateRef = useRef(onUpdatePreferences);
  onUpdateRef.current = onUpdatePreferences;

  useEffect(() => {
    if (preferences.customTheme && !dirtyRef.current) setDraft(preferences.customTheme);
  }, [preferences.customTheme]);

  // 自动防抖保存合法配色改动，并在关闭设置页时兜底落盘，避免用户调完颜色直接按 Esc 导致丢失。
  const scheduleAutoSave = (nextDraft: CustomThemeConfig) => {
    dirtyRef.current = true;
    setSavedToast(false);
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    const allValid = THEME_TOKEN_KEYS.every((key) => isValidCssColorToken(nextDraft.tokens[key]));
    if (!allValid) return;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      dirtyRef.current = false;
      void onUpdateRef.current({ theme: 'custom', customTheme: nextDraft })
        .then(() => setSavedToast(true))
        .catch((err) => {
          // 保存失败时保留脏标记，关闭面板时还会再尝试一次，并明确提示用户。
          dirtyRef.current = true;
          setError(dict.ui.v031.themeSaveFailed(formatActionError(err, dict)));
        });
    }, 450);
  };

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (dirtyRef.current) {
        const latest = draftRef.current;
        if (THEME_TOKEN_KEYS.every((key) => isValidCssColorToken(latest.tokens[key]))) {
          dirtyRef.current = false;
          void onUpdateRef.current({ theme: 'custom', customTheme: latest }).catch(() => {});
        }
      }
    };
  }, []);

  // 保证 23 个 Token 都被分组展示
  const grouped = new Set(TOKEN_GROUPS.flatMap((g) => g.tokens));
  const leftovers = THEME_TOKEN_KEYS.filter((k) => !grouped.has(k));

  // 副作用（防抖保存）放在 setState 更新函数之外：StrictMode 会双调用更新函数。基于 draftRef 取最新草稿以支持连续修改。
  function updateDraft(updater: (prev: CustomThemeConfig) => CustomThemeConfig): void {
    const next = updater(draftRef.current);
    draftRef.current = next;
    setDraft(next);
    scheduleAutoSave(next);
  }

  function setToken(key: keyof ThemePaletteTokens, value: string): void {
    updateDraft((prev) => ({ ...prev, tokens: { ...prev.tokens, [key]: value } }));
  }

  /** 整套颜色先在表单校验，通过后一次提交，并将偏好切到自定义主题。界面的错误可指出具体色键。 */
  async function apply(): Promise<void> {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setError(null);
    try {
      for (const key of THEME_TOKEN_KEYS) {
        if (!isValidCssColorToken(draft.tokens[key])) throw new Error(dict.ui.colorTokenInvalid(key));
      }
      dirtyRef.current = false;
      await onUpdatePreferences({ theme: 'custom', customTheme: draft });
      setSavedToast(true);
    } catch (err) {
      // 应用失败时恢复脏标记，关闭面板时仍会兜底保存这份草稿。
      dirtyRef.current = true;
      setError(formatActionError(err, dict));
    }
  }

  async function importFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    // 导入会整体替换自定义主题：先撤销尚未落盘的取色草稿，避免防抖保存或关闭面板时把旧草稿写回覆盖新主题。
    const pendingTimer = saveTimerRef.current;
    const wasDirty = dirtyRef.current;
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      saveTimerRef.current = null;
    }
    dirtyRef.current = false;
    try {
      await onImportCustomTheme(await file.text());
      setSavedToast(true);
    } catch (err) {
      dirtyRef.current = wasDirty;
      setError(formatActionError(err, dict));
    // 无论导入成功与否都清空文件输入值，同一份 JSON 修正后可以再次选择并触发 change。
    } finally {
      e.target.value = '';
    }
  }

  async function exportJson(): Promise<void> {
    setError(null);
    try {
      // 导出的 JSON 来自当前已保存的主题，临时对象 URL 只用于本次浏览器下载。
      const json = await onExportCustomTheme();
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gravity-theme.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(formatActionError(err, dict));
    }
  }

  const renderRow = (key: keyof ThemePaletteTokens) => (
    <div key={key} className="token-row" title={key}>
      <span className="color-swatch" style={{ background: draft.tokens[key] }}>
        <input
          type="color"
          value={toPickerHex(draft.tokens[key])}
          onChange={(e) => setToken(key, e.target.value)}
          data-testid={`color-picker-${key}`}
          aria-label={dict.tokenLabels[key]}
        />
      </span>
      <span className="token-label truncate">{dict.tokenLabels[key]}</span>
      <input
        className="input input-mono token-input"
        value={draft.tokens[key]}
        onChange={(e) => setToken(key, e.target.value)}
        aria-label={key}
      />
    </div>
  );

  return (
    <div className="settings-section" data-testid="custom-tokens-editor">
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-text">
            <span className="setting-label">{dict.customThemeNameLabel}</span>
          </span>
          <input
            className="input"
            style={{ width: 220 }}
            value={draft.name}
            onChange={(e) => updateDraft((prev) => ({ ...prev, name: e.target.value }))}
            aria-label={dict.customThemeNameLabel}
          />
        </div>
        <div className="setting-row">
          <span className="setting-text">
            <span className="setting-label">{dict.customThemePolarityLabel}</span>
          </span>
          <div className="segmented" role="radiogroup" aria-label={dict.customThemePolarityLabel}>
            {(['dark', 'light'] as ThemePolarity[]).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={draft.polarity === p}
                className={`segmented-btn ${draft.polarity === p ? 'is-active' : ''}`}
                onClick={() => updateDraft((prev) => ({ ...prev, polarity: p }))}
              >
                {p === 'dark' ? dict.themeDarkGroup : dict.themeLightGroup}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-text">
            <span className="setting-label">{dict.startFromPresetLabel}</span>
          </span>
          <select
            className="input"
            style={{ width: 220 }}
            value=""
            aria-label={dict.startFromPresetLabel}
            onChange={(e) => {
              const preset = THEME_PRESETS.find((p) => p.id === e.target.value);
              if (preset) updateDraft((prev) => ({ ...prev, polarity: preset.polarity, baseThemeId: preset.id, tokens: { ...preset.tokens } }));
            }}
          >
            <option value="">…</option>
            {THEME_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {locale === 'zh-CN' ? p.nameZh : p.nameEn}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ThemePreview tokens={draft.tokens} />

      {TOKEN_GROUPS.map((group) => (
        <React.Fragment key={group.key}>
          <h3 className="settings-group-title">{dict.tokenGroups[group.key]}</h3>
          <div className="settings-group token-group">{group.tokens.map(renderRow)}</div>
        </React.Fragment>
      ))}
      {leftovers.length > 0 && <div className="settings-group token-group">{leftovers.map(renderRow)}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => void importFile(e)}
          data-testid="import-theme-file-input"
        />
        <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="import-theme-json-btn">
          <Icon icon={Upload} size="sm" />
          <span>{dict.importThemeJsonBtn}</span>
        </button>
        <button type="button" className="btn" onClick={() => void exportJson()} data-testid="export-theme-json-btn">
          <Icon icon={Download} size="sm" />
          <span>{dict.exportThemeJsonBtn}</span>
        </button>
        <span className="spacer" />
        {savedToast && (
          <span className="muted" style={{ alignSelf: 'center', fontSize: 12, color: 'var(--success-text, var(--status-success))' }}>
            {dict.savedHint}
          </span>
        )}
        <button type="button" className="btn btn-primary" onClick={() => void apply()} data-testid="apply-custom-theme-btn">
          {dict.applyCustomThemeBtn}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 图标 */

export function IconsPanel({
  preferences,
  onSetAppIcon,
}: {
  preferences: ClientPreferences;
  onSetAppIcon: (iconId: GravityIconPreference) => Promise<void>;
}): React.ReactElement {
  const { locale, dict } = useI18n();
  const v034 = dict.ui.v034;
  const { save, feedback } = usePrefsFeedback(async (patch) => {
    if (patch.appIcon) await onSetAppIcon(patch.appIcon);
  });
  const nameOf = (v: GravityIconVariant): string => (locale === 'zh-CN' ? v.nameZh : v.nameEn);
  // D2：'auto' 跟随当前主题（含 system 明暗与自定义主题基准预设）解析出的推荐图标。
  const autoVariant = resolveGravityIconVariant('auto', preferences.theme, preferences.customTheme);
  const isAuto = preferences.appIcon === 'auto';
  return (
    <div className="settings-section">
      {feedback}
      <div className="icon-grid" role="radiogroup" aria-label={dict.settingsNav.icons} data-testid="app-icons-grid">
        <button
          type="button"
          role="radio"
          aria-checked={isAuto}
          className={`icon-card icon-card-auto ${isAuto ? 'is-selected' : ''}`}
          onClick={() => void save({ appIcon: 'auto' })}
          data-testid="icon-variant-auto"
        >
          <img src={autoVariant.publicSvgUrl} alt="" />
          <span title={v034.iconAutoName}>{v034.iconAutoName}</span>
          <small className="icon-card-sub">{v034.iconAutoDesc(nameOf(autoVariant))}</small>
        </button>
        {GRAVITY_ICON_VARIANTS.map((v) => {
          const selected = preferences.appIcon === v.id;
          return (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`icon-card ${selected ? 'is-selected' : ''}`}
              onClick={() => void save({ appIcon: v.id })}
              data-testid={`icon-variant-${v.id}`}
            >
              <img src={v.publicSvgUrl} alt="" />
              <span title={nameOf(v)}>{nameOf(v)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
