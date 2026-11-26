// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CoreService, type CoreServiceOptions } from '../src/main/core-service';
import { DEFAULT_TRANSLATION_CONFIG, type ClientPreferences, type TranslationConfig } from '../src/shared';

let directory: string;
let core: CoreService;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'gravity-settings-')); });
afterEach(async () => {
  await core.dispose();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function start(options: Partial<CoreServiceOptions> = {}) {
  core = new CoreService({ dataDir: directory, homeDir: join(directory, 'home'), ...options });
}
function failNextWrite(target: string) {
  const original = core.store.write.bind(core.store);
  const fault = vi.spyOn(core.store, 'write').mockImplementation((name, value) => {
    if (name === target) { fault.mockRestore(); throw Error('test disk failure'); }
    original(name, value);
  });
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function seedExternalTranslation() {
  const cfg: TranslationConfig = { engine: 'external-api', externalTranslator: {
    ...DEFAULT_TRANSLATION_CONFIG.externalTranslator, provider: 'local-ollama', endpoint: 'http://127.0.0.1:11434',
    model: 'sample', enabled: true, verifiedBy: 'translation-call', lastVerifiedAt: '2026-11-01', connectionStatus: 'connected',
  } };
  writeFileSync(join(directory, 'translation-config.json'), JSON.stringify(cfg));
}

it('an unsuccessful layout write cannot leak into the next unrelated patch', async () => {
  start();
  const initial = await core.saveWorkspaceLayout({ leftSidebarWidth: 300 });
  failNextWrite('layout.json');
  await expect(core.saveWorkspaceLayout({ leftSidebarWidth: 420 })).rejects.toThrow('disk failure');
  const next = await core.saveWorkspaceLayout({ activeInspectorTab: 'plan' });
  expect(next.leftSidebarWidth).toBe(initial.leftSidebarWidth);
  expect(core.store.read('layout.json', {})).toMatchObject({ leftSidebarWidth: 300, activeInspectorTab: 'plan' });
});

it('rolls back a failed preference write including the window effect', async () => {
  let zoom = 1;
  start({ setZoom: value => { zoom = value; } });
  await core.updatePreferences({ uiScale: 1 });
  failNextWrite('preferences.json');
  await expect(core.updatePreferences({ uiScale: 1.25 })).rejects.toThrow('disk failure');
  expect(core.getPreferences().uiScale).toBe(1);
  expect(zoom).toBe(1);
  expect((await core.updatePreferences({ locale: 'en-US' })).uiScale).toBe(1);
  expect(core.store.read('preferences.json', {})).toMatchObject({ locale: 'en-US', uiScale: 1 });
});

it('retains both independent patches when a window icon update is pending', async () => {
  const started = barrier(), done = barrier();
  start({ setIcon: async () => { started.release(); await done.promise; } });
  const slow = core.updatePreferences({ appIcon: 'gravity-ubuntu' });
  await started.promise;
  const fast = core.updatePreferences({ locale: 'en-US' });
  done.release();
  await Promise.all([slow, fast]);
  expect(core.getPreferences()).toMatchObject({ locale: 'en-US', appIcon: 'gravity-ubuntu' });
  expect(core.store.read('preferences.json', {})).toMatchObject({ locale: 'en-US', appIcon: 'gravity-ubuntu' });
});

it('a translator engine changed during an icon update stays current in both settings files', async () => {
  const started = barrier(), done = barrier();
  seedExternalTranslation();
  start({ setIcon: async () => { started.release(); await done.promise; } });
  const icon = core.updatePreferences({ appIcon: 'gravity-ubuntu' });
  await started.promise;
  await core.updateTranslationConfig({ engine: 'local' });
  done.release();
  await icon;
  expect(core.getPreferences().translationEngine).toBe('local');
  expect(core.store.read('preferences.json', {})).toMatchObject({ translationEngine: 'local' });
  expect(core.store.read('translation-config.json', {})).toMatchObject({ engine: 'local' });
});

it('invalidates waiting and queued writes from a previous profile, then permits the new profile to save', async () => {
  const started = barrier(), done = barrier();
  start({ setIcon: async id => { if (id === 'gravity-ubuntu') { started.release(); await done.promise; } } });
  vi.spyOn(core.client, 'start').mockResolvedValue({ protocolVersion: 1, agentInfo: { name: 'fixture', version: '1' }, agentCapabilities: {} });
  const accounts = await core.createAccountProfile({ name: 'test-profile' });
  const profile = accounts.profiles.find(item => !item.isDefault)!.profileId;
  const pending = core.updatePreferences({ appIcon: 'gravity-ubuntu' });
  await started.promise;
  const queued = core.updatePreferences({ locale: 'en-US' });
  await core.switchAccountProfile(profile);
  done.release();
  await expect(pending).rejects.toThrow(/账号|Profile/);
  await expect(queued).rejects.toThrow(/账号|Profile/);
  expect(core.getPreferences()).toMatchObject({ activeProfileId: profile, appIcon: 'auto', locale: 'zh-CN' });
  await core.updatePreferences({ locale: 'en-US' });
  expect(core.store.read('preferences.json', {})).toMatchObject({ activeProfileId: profile, locale: 'en-US' });
});

it('retries a window theme callback that failed after making a partial change', async () => {
  let first = true;
  let chrome: ClientPreferences['theme'] = 'claude-code-dark';
  const change = vi.fn((prefs: ClientPreferences) => {
    chrome = prefs.theme;
    if (first && chrome === 'claude-code-light') { first = false; throw Error('test window failure'); }
  });
  start({ onThemeChanged: change });
  const initial = await core.updatePreferences({});
  await expect(core.updatePreferences({ theme: 'claude-code-light' })).rejects.toThrow('window failure');
  expect(core.getPreferences().theme).toBe(initial.theme);
  expect(chrome).toBe(initial.theme);
  await core.updatePreferences({ theme: 'claude-code-light' });
  expect(change.mock.calls.filter(([prefs]) => prefs.theme === 'claude-code-light')).toHaveLength(2);
  expect(chrome).toBe('claude-code-light');
});

it.each(['preferences', 'translation'])('keeps both saved translation mirrors when the %s file cannot be committed', async file => {
  seedExternalTranslation(); start();
  expect((await core.getTranslationConfig()).engine).toBe('external-api');
  if (file === 'preferences') {
    failNextWrite('preferences.json');
    await expect(core.updateTranslationConfig({ engine: 'local' })).rejects.toThrow('disk failure');
  } else {
    failNextWrite('translation-config.json');
    await expect(core.updatePreferences({ translationEngine: 'local', locale: 'en-US' })).rejects.toThrow('disk failure');
  }
  expect(await core.getTranslationConfig()).toMatchObject({ engine: 'external-api' });
  expect(core.getPreferences()).toMatchObject({ translationEngine: 'external-api', locale: 'zh-CN' });
  expect(core.store.read('preferences.json', {})).toMatchObject({ translationEngine: 'external-api', locale: 'zh-CN' });
  expect(core.store.read('translation-config.json', {})).toMatchObject({ engine: 'external-api' });
});
