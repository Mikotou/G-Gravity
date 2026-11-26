import { isAnyAbsolutePath } from '../workspace/local-path-safety';
import { randomUUID } from 'node:crypto';
import { isExternalTranslatorConnected, type TranslationConfig } from '../../shared/translation-contract';
import {
  clampSplitRatio, isRightInspectorTab, LAYOUT_LIMITS, normalizeProjectCompareKey, normalizeWorkspacePath, type WorkspaceLayoutState,
} from '../../shared/session-contract';
import {
  THEME_PRESETS, UI_SCALE_LIMITS, clampUiScale, isGravityIconPreference, sanitizeCustomThemeConfig,
  validateCustomThemeConfig, type ClientPreferences, type WorkspaceProjectConfig,
} from '../../shared/theme-i18n-contract';
import type { SettingsHost, CoreServiceOptions } from '../core-contracts';
import { publicTranslationConfig, type SecretVault } from './secret-vault';

const DEFAULT_PREFERENCES: ClientPreferences = { locale: 'zh-CN', theme: 'claude-code-dark', appIcon: 'auto', defaultThoughtTrack: 'zh', translationEngine: 'local', processPerSession: false, activeProfileId: 'default', defaultWorkspaceCwd: '', projects: [], autoCheckUpdates: true };
export const DEFAULT_LAYOUT: WorkspaceLayoutState = { openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null, layoutMode: 'single', hideLegacyPollutionSessions: true, leftSidebarCollapsed: false, leftSidebarWidth: 260, rightInspectorCollapsed: false, rightInspectorWidth: 360, activeInspectorTab: 'context', splitRatio: 0.5 };


export class WorkspaceSettings {
  preferences: ClientPreferences;
  translationConfig: TranslationConfig;
  layout: WorkspaceLayoutState;
  private preferenceWrites: Promise<void> = Promise.resolve();
  private preferenceProfileRevision = 0;

  async selectDirectory(defaultPath?: string): Promise<string | null> {
    if (defaultPath !== undefined && (typeof defaultPath !== 'string' || defaultPath.length > 1024 || defaultPath.includes('\0'))) {
      throw new Error('无效的默认目录参数');
    }
    const picked = await this.options.selectDirectoryHandler?.(defaultPath?.trim() || this.preferences.defaultWorkspaceCwd || undefined);
    return picked ? normalizeWorkspacePath(picked) : null;
  }
  async importCustomTheme(jsonText: string) {
    if (typeof jsonText !== 'string' || jsonText.length > 65536) throw new Error('主题 JSON 超过大小限制');
    let parsed: unknown; try { parsed = JSON.parse(jsonText); } catch { throw new Error('主题 JSON 格式无效'); }
    return this.updatePreferences({ customTheme: validateCustomThemeConfig(parsed), theme: 'custom' });
  }
  async exportCustomTheme(): Promise<string> {
    const preset = THEME_PRESETS.find(theme => theme.id === this.preferences.theme) || THEME_PRESETS[0];
    const theme = this.preferences.customTheme || { name: preset.nameEn, polarity: preset.polarity, baseThemeId: preset.id, tokens: preset.tokens };
    return JSON.stringify(validateCustomThemeConfig(theme), null, 2);
  }

  constructor(private app: SettingsHost, private vault: SecretVault,
    private options: Pick<CoreServiceOptions, 'setIcon' | 'setZoom' | 'onThemeChanged' | 'selectDirectoryHandler'>,
    private isDisposed: () => boolean) {
    this.translationConfig = vault.loadTranslationConfig();
    this.preferences = { ...DEFAULT_PREFERENCES, ...this.app.store.read('preferences.json', {}) };
    const syncPreferences = this.preferences.translationEngine !== this.translationConfig.engine;
    if (syncPreferences) {
      this.preferences.translationEngine = this.translationConfig.engine;
    }
    if (!THEME_PRESETS.some(theme => theme.id === this.preferences.theme) && !['custom', 'system'].includes(this.preferences.theme)) this.preferences.theme = DEFAULT_PREFERENCES.theme;
    if (!isGravityIconPreference(this.preferences.appIcon)) this.preferences.appIcon = DEFAULT_PREFERENCES.appIcon;
    if (this.preferences.customTheme) {
      const rescued = sanitizeCustomThemeConfig(this.preferences.customTheme);
      if (rescued) this.preferences.customTheme = rescued;
      else { delete this.preferences.customTheme; if (this.preferences.theme === 'custom') this.preferences.theme = DEFAULT_PREFERENCES.theme; }
    }
    if (this.preferences.theme === 'custom' && !this.preferences.customTheme) this.preferences.theme = DEFAULT_PREFERENCES.theme;
    if (this.preferences.thoughtExpandedByDefault !== undefined && typeof this.preferences.thoughtExpandedByDefault !== 'boolean') {
      delete this.preferences.thoughtExpandedByDefault;
    }
    const stored = this.app.store.read<Partial<Omit<WorkspaceLayoutState, 'layoutMode'>> & {
      layoutMode?: WorkspaceLayoutState['layoutMode'] | 'grid-4'; tertiarySessionId?: string; quaternarySessionId?: string;
    }>('layout.json', {});
    const { tertiarySessionId, quaternarySessionId, layoutMode, ...saved } = stored;
    this.layout = { ...DEFAULT_LAYOUT, ...saved, layoutMode: layoutMode === 'grid-4' || layoutMode === 'split-2' ? 'split-2' : 'single' };
    if (layoutMode === 'grid-4') {
      this.layout.openTabSessionIds = [...new Set([...this.layout.openTabSessionIds, tertiarySessionId, quaternarySessionId].filter((id): id is string => Boolean(id)))];
    }
    if (!isRightInspectorTab(this.layout.activeInspectorTab)) this.layout.activeInspectorTab = DEFAULT_LAYOUT.activeInspectorTab;
    // 启动时修复越界的栏宽与分屏比例，避免一个坏值让之后所有布局保存都被整体拒绝。
    const fitWidth = (value: unknown, key: 'leftSidebarWidth' | 'rightInspectorWidth') => {
      const { min, max } = LAYOUT_LIMITS[key];
      return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_LAYOUT[key];
    };
    this.layout.leftSidebarWidth = fitWidth(this.layout.leftSidebarWidth, 'leftSidebarWidth');
    this.layout.rightInspectorWidth = fitWidth(this.layout.rightInspectorWidth, 'rightInspectorWidth');
    this.layout.splitRatio = clampSplitRatio(this.layout.splitRatio);
    if (this.layout.inspectorFloating !== undefined && typeof this.layout.inspectorFloating !== 'boolean') {
      delete this.layout.inspectorFloating;
    }
    if (this.layout.composerMinHeight !== undefined) {
      const { min, max } = LAYOUT_LIMITS.composerMinHeight;
      if (typeof this.layout.composerMinHeight === 'number' && Number.isFinite(this.layout.composerMinHeight)) {
        this.layout.composerMinHeight = Math.min(max, Math.max(min, Math.round(this.layout.composerMinHeight)));
      } else {
        delete this.layout.composerMinHeight;
      }
    }
    if (this.preferences.uiScale !== undefined) this.preferences.uiScale = clampUiScale(this.preferences.uiScale);
    if (syncPreferences) this.app.store.write('preferences.json', this.preferences);
  }

  profileWillChange(): void { ++this.preferenceProfileRevision; }

  /** The translation config is authoritative on restart. Publish both in-memory settings only after their files commit. */
  saveSettings(next: ClientPreferences, translation?: TranslationConfig, clearKey = false): void {
    const previous = this.preferences;
    if (translation && next.translationEngine !== translation.engine) next = { ...next, translationEngine: translation.engine };
    if (next !== previous) this.app.store.write('preferences.json', next);
    try {
      if (translation) this.vault.persistTranslationConfig(translation, clearKey);
    } catch (error) {
      if (next !== previous) this.app.store.write('preferences.json', previous);
      throw error;
    }
    this.preferences = next;
    if (translation) this.translationConfig = translation;
  }

  async updatePreferences(patch: Partial<ClientPreferences>): Promise<ClientPreferences> {
    this.app.accounts.assertReady();
    const revision = this.preferenceProfileRevision;
    const changes = structuredClone(patch);
    const save = this.preferenceWrites.then(() => this.commitPreferences(changes, revision));
    this.preferenceWrites = save.then(() => {}, () => {});
    return save;
  }

  private assertPreferenceProfile(revision: number): void {
    this.app.accounts.assertReady();
    if (this.isDisposed() || revision !== this.preferenceProfileRevision) throw new Error('账号状态已改变，请重新保存偏好设置');
  }

  private async commitPreferences(patch: Partial<ClientPreferences>, revision: number): Promise<ClientPreferences> {
    this.assertPreferenceProfile(revision);
    const previous = this.preferences;
    const next = { ...previous, ...patch };
    if (patch.translationEngine !== undefined) {
      if (patch.translationEngine !== 'local' && patch.translationEngine !== 'external-api') {
        throw new Error('翻译引擎设置无效');
      }
      if (
        patch.translationEngine === 'external-api' &&
        !isExternalTranslatorConnected(this.translationConfig.externalTranslator)
      ) {
        throw new Error('尚未连接外部翻译模型，无法切换至「外部 API」；请先配置并启用外部翻译 API。');
      }
    } else {
      next.translationEngine = this.translationConfig.engine;
    }
    if (!['zh-CN', 'en-US'].includes(next.locale) || !['zh', 'raw'].includes(next.defaultThoughtTrack) || !(['system', 'custom'].includes(next.theme) || THEME_PRESETS.some(theme => theme.id === next.theme)) || typeof next.processPerSession !== 'boolean' || !isGravityIconPreference(next.appIcon)) throw new Error('偏好设置格式无效');
    // Profile 切换还涉及关闭旧连接和加载新的消息索引，必须走账号管理器的完整切换流程。
    if (next.activeProfileId !== this.app.accounts.activeProfileId) throw new Error('切换 Profile 必须使用专用账号切换入口');
    if (next.customTheme) next.customTheme = validateCustomThemeConfig(next.customTheme);
    if (next.theme === 'custom' && !next.customTheme) throw new Error('请先导入或创建自定义主题');
    if (next.defaultWorkspaceCwd !== undefined) {
      if (typeof next.defaultWorkspaceCwd !== 'string' || next.defaultWorkspaceCwd.length > 1024 || next.defaultWorkspaceCwd.includes('\0')) {
        throw new Error('默认文件夹路径无效');
      }
      next.defaultWorkspaceCwd = next.defaultWorkspaceCwd.trim() ? normalizeWorkspacePath(next.defaultWorkspaceCwd.trim()) : '';
    }
    if (next.projects !== undefined) {
      if (!Array.isArray(next.projects) || next.projects.length > 60) {
        throw new Error('自定义项目数量无效');
      }
      // 先重建并校验项目清单，再整体保存偏好。相同目录只保留第一项，比较使用规范化的小写路径。
      const normalizedProjects: WorkspaceProjectConfig[] = [];
      const seenPaths = new Set<string>();
      for (const rawProj of next.projects) {
        if (!rawProj || typeof rawProj !== 'object') throw new Error('项目配置格式无效');
        const cleanPath = normalizeWorkspacePath(String(rawProj.path || '').trim());
        const cleanName = String(rawProj.name || '').trim().slice(0, 80);
        const isAbs = isAnyAbsolutePath(cleanPath);
        if (!cleanPath || cleanPath.includes('\0') || !isAbs || !cleanName) {
          throw new Error('项目名称不能为空且路径必须为绝对路径');
        }
        const pathKey = normalizeProjectCompareKey(cleanPath);
        if (seenPaths.has(pathKey)) continue;
        seenPaths.add(pathKey);
        normalizedProjects.push({
          id: String(rawProj.id || randomUUID()).slice(0, 64),
          name: cleanName,
          path: cleanPath,
          description: rawProj.description ? String(rawProj.description).trim().slice(0, 240) : undefined,
          defaultMode:
            rawProj.defaultMode && ['default', 'accept-edits', 'plan', 'auto', 'full-access'].includes(rawProj.defaultMode)
              ? rawProj.defaultMode
              : undefined,
          defaultModelId: rawProj.defaultModelId ? String(rawProj.defaultModelId).trim().slice(0, 120) : undefined,
          pinned: Boolean(rawProj.pinned),
        });
      }
      next.projects = normalizedProjects;
    }
    if (next.uiScale !== undefined) {
      if (typeof next.uiScale !== 'number' || !Number.isFinite(next.uiScale) || next.uiScale < UI_SCALE_LIMITS.min || next.uiScale > UI_SCALE_LIMITS.max) throw new Error('界面缩放倍率无效');
      next.uiScale = clampUiScale(next.uiScale);
    }
    if (next.autoCheckUpdates !== undefined && typeof next.autoCheckUpdates !== 'boolean') {
      throw new Error('自动检查更新设置无效');
    }
    if (next.thoughtExpandedByDefault !== undefined && typeof next.thoughtExpandedByDefault !== 'boolean') {
      throw new Error('思考区默认展开设置无效');
    }
    const restoreWindow: Array<() => void | Promise<void>> = [];
    let translation: TranslationConfig | undefined;
    try {
      if (next.appIcon !== previous.appIcon && this.options.setIcon) {
        restoreWindow.push(() => this.options.setIcon!(this.preferences.appIcon));
        await this.options.setIcon(next.appIcon);
        this.assertPreferenceProfile(revision);
      }
      // The translator can change independently while the native icon is being applied.
      next.translationEngine = patch.translationEngine ?? this.translationConfig.engine;
      if (next.translationEngine !== this.translationConfig.engine) {
        if (next.translationEngine === 'external-api' && !isExternalTranslatorConnected(this.translationConfig.externalTranslator)) {
          throw new Error('外部翻译连接已改变，请重新测试当前设置');
        }
        translation = { ...this.translationConfig, engine: next.translationEngine };
      }
      if ((next.uiScale ?? 1) !== (previous.uiScale ?? 1) && this.options.setZoom) {
        restoreWindow.push(() => this.options.setZoom!(this.preferences.uiScale ?? 1));
        this.options.setZoom(next.uiScale ?? 1);
      }
      const themeChanged = next.theme !== previous.theme ||
        (Object.hasOwn(patch, 'customTheme') && JSON.stringify(next.customTheme) !== JSON.stringify(previous.customTheme));
      if (themeChanged && this.options.onThemeChanged) {
        restoreWindow.push(() => this.options.onThemeChanged!(structuredClone(this.preferences)));
        this.options.onThemeChanged(structuredClone(next));
      }
      this.assertPreferenceProfile(revision);
      this.saveSettings(next, translation);
    } catch (error) {
      for (const restore of restoreWindow.reverse()) {
        try { await restore(); } catch { /* A closed native window can be reapplied on the next save or launch. */ }
      }
      throw error;
    }
    if (next.locale !== previous.locale) this.app.emit('locale-changed', next.locale);
    if (translation) this.app.emit('translation-config-updated', publicTranslationConfig(translation));
    if (next.processPerSession !== previous.processPerSession) this.syncAcpArgs();
    return structuredClone(next);
  }

  syncAcpArgs(): void {
    this.app.client.options.processPerSession = this.preferences.processPerSession;
    this.app.accounts.applyArgs();
  }

  saveWorkspaceLayout(patch: Partial<WorkspaceLayoutState>): WorkspaceLayoutState {
    const allowed = new Set([...Object.keys(DEFAULT_LAYOUT), 'composerMinHeight', 'inspectorFloating']);
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !allowed.has(key))) throw new Error('工作台布局无效');
    const next = { ...this.layout, ...patch };
    for (const id of [next.activePrimarySessionId, next.splitSecondarySessionId]) {
      if (id !== null && (typeof id !== 'string' || id.includes('\0'))) throw new Error('工作台会话标识无效');
    }
    if (!Array.isArray(next.openTabSessionIds) || !next.openTabSessionIds.every(id => typeof id === 'string' && !id.includes('\0')) || !['single', 'split-2'].includes(next.layoutMode) || typeof next.hideLegacyPollutionSessions !== 'boolean') throw new Error('工作台布局无效');
    if (typeof next.leftSidebarCollapsed !== 'boolean' || typeof next.rightInspectorCollapsed !== 'boolean' || !Number.isFinite(next.leftSidebarWidth) || next.leftSidebarWidth < LAYOUT_LIMITS.leftSidebarWidth.min || next.leftSidebarWidth > LAYOUT_LIMITS.leftSidebarWidth.max || !Number.isFinite(next.rightInspectorWidth) || next.rightInspectorWidth < LAYOUT_LIMITS.rightInspectorWidth.min || next.rightInspectorWidth > LAYOUT_LIMITS.rightInspectorWidth.max || !isRightInspectorTab(next.activeInspectorTab)) throw new Error('Inspector 布局或栏宽无效');
    if (next.splitRatio !== undefined && (typeof next.splitRatio !== 'number' || !Number.isFinite(next.splitRatio) || next.splitRatio < LAYOUT_LIMITS.splitRatio.min || next.splitRatio > LAYOUT_LIMITS.splitRatio.max)) throw new Error('分屏比例无效');
    if (next.inspectorFloating !== undefined && typeof next.inspectorFloating !== 'boolean') throw new Error('检视器悬浮状态无效');
    if (next.composerMinHeight !== undefined) {
      if (typeof next.composerMinHeight !== 'number' || !Number.isFinite(next.composerMinHeight) || next.composerMinHeight < LAYOUT_LIMITS.composerMinHeight.min || next.composerMinHeight > LAYOUT_LIMITS.composerMinHeight.max) throw new Error('输入框高度无效');
      next.composerMinHeight = Math.round(next.composerMinHeight);
    }
    this.app.store.write('layout.json', next);
    this.layout = next;
    return structuredClone(next);
  }
}
