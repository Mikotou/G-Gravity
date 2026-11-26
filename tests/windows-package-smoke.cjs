const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');
const expectedVersion = 'v' + require('../package.json').version;
const standardRoot = path.resolve('release');
const versionedRoot = path.join(standardRoot, expectedVersion);
function matchesExpectedVersion(dir) {
  try { return 'v' + require(path.join(dir, 'win-unpacked/resources/app/package.json')).version === expectedVersion; }
  catch { return false; }
}
const releaseRoot = process.env.GRAVITY_RELEASE_DIR ? path.resolve(process.env.GRAVITY_RELEASE_DIR)
  : matchesExpectedVersion(versionedRoot) ? versionedRoot
  : matchesExpectedVersion(standardRoot) ? standardRoot : versionedRoot;

const recordedId = 'gravity-packaged-ui-fixture';
const longCommand = 'echo ' + 'example-argument '.repeat(30) + 'END_OF_COMMAND';

async function seedRecordedSession(profile, cwd) {
  const date = new Date().toISOString();
  const card = (id, name, target) => ({ toolCallId: id, rawToolName: name, canonicalToolName: name,
    compactTarget: target.slice(0, 240), argsSummary: JSON.stringify({ command: target }), startedAt: date,
    completedAt: date, status: name === 'Bash' ? 'failed' : 'completed', outputPreview: 'PACKAGED_OUTPUT',
    ...(name === 'Bash' ? { exitCode: 1 } : {}) });
  const save = (file, data) => writeFile(path.join(profile, file), JSON.stringify(data), 'utf8');
  await save('preferences.json', { autoCheckUpdates: false });
  const main = path.join(releaseRoot, 'win-unpacked/resources/app/dist/main');
  const { ClientStore } = require(path.join(main, 'storage/client-store.js'));
  const { SessionGrants } = require(path.join(main, 'approval/session-grants.js'));
  const grants = new SessionGrants(new ClientStore(profile), () => 'default');
  const decision = { id: 'qa-prefix', timestamp: date, sessionId: recordedId, cwd, toolName: 'run_command',
    commandOrSummary: 'git status', modeAtDecision: 'manual', verdict: 'user_approved',
    decisionSource: 'user-inline', riskLevel: 'low', latencyMs: 0, reason: '合成授权样例' };
  grants.commit(decision, 'git status');
  grants.commit({ ...decision, id: 'qa-delegation' }, undefined, 'rules-only');
  await copyFile(path.resolve('assets/icons/gravity-claude-dark.png'), path.join(cwd, '本地 示意图.png'));
  await save('owned-sessions-default.json', { [recordedId]: { sessionId: recordedId, cwd, rawCwd: cwd, title: '记录交互测试', updatedAt: date,
    profileId: 'default', modelId: '', executionMode: 'default', reasoningEffort: 'high', status: 'closed', pinned: false, isLegacyApprovalPollution: false } });
  await save('layout.json', { openTabSessionIds: [], activePrimarySessionId: null, activeInspectorTab: 'plan' });
  await save('swarm-states-default.json', { [recordedId]: {
    sessionId: recordedId, swarmTitle: '便携版协作样例', workers: [], actionTimeline: [], updatedAt: date,
    boardMessages: Array.from({ length: 54 }, (_, index) => ({
      seq: index + 1, sender: 'sample-' + index, channel: 'desk', mentions: [], timestamp: date,
      content: '合成协作消息 ' + (index + 1), isDoneReport: false, isStallAlert: false,
    })),
  } });
  await save('messages-default.json', { [recordedId]: [
    { id: 'qa-user', sessionId: recordedId, role: 'user', content: '【逐处标记批注 (Notations)】\n1. 针对原文「示意图」：显示本地图片（第 7 条消息）\n\n请严格结合以上逐处标记位置与批注说明进行修改或解答。', createdAt: date },
    { id: 'qa-agent', sessionId: recordedId, role: 'assistant', createdAt: date, completedAt: date,
      content: '配图见 ![本地图片](<./本地 示意图.png>)。\n\n这是正文的最后一段。',
      thoughts: [{ id: 'qa-thought', originalText: 'The image is ready.', translatedZhText: '图片准备好了。', translationSource: 'local-model', languageDetected: 'en', isStreaming: false }],
      toolCalls: [card('qa-read', 'Read', 'sample.txt'), card('qa-command', 'Bash', longCommand)] },
  ] });
}

const titleFixtureId = 'only-synthetic-title';
const titleFixtureName = '临时会话验收样例';
async function seedTitleFixture(profile, cwd) {
  const now = new Date().toISOString();
  const session = { sessionId: titleFixtureId, cwd, rawCwd: cwd, title: titleFixtureName, updatedAt: now,
    profileId: 'default', modelId: '', executionMode: 'default', reasoningEffort: 'high', status: 'closed',
    pinned: false, isLegacyApprovalPollution: false };
  await writeFile(path.join(profile, 'owned-sessions-default.json'), JSON.stringify({ [titleFixtureId]: session }));
  await writeFile(path.join(profile, 'messages-default.json'), JSON.stringify({ [titleFixtureId]: [
    { id: 'synthetic-text', sessionId: titleFixtureId, role: 'user', content: '安排周五读书会的时间和讨论书单。', createdAt: now },
  ] }));
}

async function checkLiveTitle(page, profile) {
  const rows = await page.evaluate(() => window.gravityDesktop.listSessions());
  assert.deepEqual(rows.map(row => row.sessionId), [titleFixtureId]);
  assert.equal(rows[0].title, titleFixtureName);
  const before = await page.evaluate(() => window.gravityDesktop.getTelemetryDashboard());
  const row = page.getByRole('group', { name: titleFixtureName, exact: true });
  await row.hover();
  // Exactly one click on this synthetic row. This mode never enters the conversation composer.
  await page.getByTestId('organize-session-' + titleFixtureId).click();
  console.log('Official title check: clicked once for the isolated reading-club fixture.');
  const toast = page.locator('.toast.tone-error, .toast.tone-success');
  await toast.waitFor({ timeout: 110000 });
  const outcome = await toast.innerText();
  console.log('Official title action result: ' + outcome);
  assert.equal(await toast.evaluate(el => el.classList.contains('tone-success')), true, outcome);
  const after = await page.evaluate(() => window.gravityDesktop.getTelemetryDashboard());
  assert.deepEqual(after.costByRange, before.costByRange);
  const persisted = JSON.parse(await readFile(path.join(profile, 'titles.json'), 'utf8'))['default:' + titleFixtureId];
  assert.match(persisted.titleOrganizedModel, /hydrogen.*medium/i);
  assert.match(persisted.title, /[｜|]/);
  await page.getByRole('group', { name: persisted.title, exact: true }).waitFor();
  const messages = await page.evaluate(async id => (await window.gravityDesktop.getSessionMessagePage(id)).messages, titleFixtureId);
  assert.deepEqual(messages.map(m => m.id), ['synthetic-text']);
  console.log('Official title check: one synthetic title action. Model = ' + persisted.titleOrganizedModel +
    '. Persisted and visible title = ' + persisted.title + '. Chat ledger unchanged.');
}

async function typeInField(field, text) {
  await field.focus();
  await field.press('Control+a');
  await field.press('Backspace');
  await field.pressSequentially(text);
  assert.equal(await field.inputValue(), text);
}

async function prepareRecoveryFixture(profile) {
  const cli = path.join(profile, 'synthetic-cli');
  const home = path.join(profile, 'synthetic-home');
  const roaming = path.join(home, 'AppData', 'Roaming');
  const local = path.join(home, 'AppData', 'Local');
  const temp = path.join(local, 'Temp');
  await Promise.all([cli, roaming, temp].map(dir => mkdir(dir, { recursive: true })));
  const binary = path.join(cli, 'agy.exe');
  const trace = path.join(cli, 'attempts.jsonl');
  const ts = require('typescript');
  const text = await readFile(path.join(__dirname, 'helpers/mock-acp-server.ts'), 'utf8');
  await writeFile(path.join(cli, 'mock-acp.cjs'), ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText);
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:FIXTURE_SOURCE)) -ReferencedAssemblies System.Web.Extensions -OutputAssembly $env:FIXTURE_EXE -OutputType ConsoleApplication'], {
    windowsHide: true, timeout: 20000, env: { ...process.env, TEMP: temp, TMP: temp, FIXTURE_EXE: binary,
      FIXTURE_SOURCE: path.join(__dirname, 'helpers/desktop-acp-fixture.cs') },
  });
  await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ locale: 'zh-CN', autoCheckUpdates: false }));
  return { binary, trace, env: { GRAVITY_QA_NODE: process.execPath, GRAVITY_QA_ACP_TRACE: trace,
    GRAVITY_QA_PROFILES_DIR: path.join(profile, 'profiles'),
    USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temp, TMP: temp } };
}

async function removeRecoveryProfile(profile) {
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(tmpdir()));
  assert.match(path.basename(profile), /^gravity-package-[\w-]+$/);
  const deadline = Date.now() + 180000;
  let reported = false;
  for (;;) {
    try {
      // A Windows input method can retain files in the isolated home after the desktop exits.
      // Retry the whole tree so each nested directory shares the same deadline.
      await rm(profile, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (!reported) {
        console.log('Waiting for Windows to release the temporary desktop profile (up to 3 minutes).');
        reported = true;
      }
      await delay(Math.min(3000, remaining));
    }
  }
}

async function createDesktopSession(page, cwd, title) {
  await page.getByTestId('empty-pane-0').getByRole('heading').waitFor();
  await page.getByTestId('sidebar-new-session-btn').press('Enter');
  await typeInField(page.getByTestId('new-session-cwd-input'), cwd);
  await typeInField(page.getByTestId('new-session-title-input'), title);
  await page.getByTestId('confirm-create-session-btn').press('Enter');
  const composer = page.locator('[data-testid^="composer-input-"]').first();
  await composer.waitFor();
  const id = (await composer.getAttribute('data-testid')).slice('composer-input-'.length);
  return { composer, id };
}

async function checkRecoveryAndCache(page, cwd, fixture) {
  const sessions = new Map();
  const cache = page.getByTestId('context-cache-hit-rate').locator('strong');
  for (const [scenario, rate] of [['recover', '60.0%'], ['interrupt', '未知'], ['unknown', '未知'], ['zero', '0%']]) {
    const { composer, id } = await createDesktopSession(page, cwd, 'Fixture ' + scenario);
    assert.ok(![...sessions.values()].includes(id));
    sessions.set(scenario, id);
    if (!await cache.isVisible()) await page.getByTestId('inspector-tab-context').click();
    await cache.filter({ hasText: /^未知$/ }).waitFor();
    await typeInField(composer, '[fixture-' + scenario + ']');
    await composer.press('Enter');
    if (scenario === 'interrupt') {
      await page.locator('[data-testid^="stream-interrupted-"]').getByText('已自动续接一次，仍未能完成。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '继续任务', exact: true }).waitFor();
    } else {
      await page.locator('[data-testid^="assistant-body-"]').filter({ hasText: 'QA_COMPLETE_' + scenario }).waitFor();
    }
    await page.waitForFunction(async id => {
      const messages = (await window.gravityDesktop.getSessionMessagePage(id)).messages;
      return messages.at(-1)?.role === 'assistant' && Boolean(messages.at(-1)?.completedAt) && !messages.at(-1)?.isStreaming;
    }, id);
    await cache.filter({ hasText: new RegExp('^' + rate.replace('.', '\\.') + '$') }).waitFor();
    const messages = await page.evaluate(async id => (await window.gravityDesktop.getSessionMessagePage(id)).messages, id);
    assert.deepEqual(messages.filter(m => m.role === 'user').map(m => m.content), ['[fixture-' + scenario + ']']);
    const recoveryCount = scenario === 'recover' || scenario === 'interrupt' ? 1 : 0;
    assert.equal(messages.filter(m => m.role === 'system' && /自动续接/.test(m.content)).length, recoveryCount);
    assert.equal(messages.filter(m => m.autoResumeFailure).length, scenario === 'interrupt' ? 1 : 0);
    await page.getByTestId('tab-close-' + id).press('Enter');
  }
  const lines = (await readFile(fixture.trace, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(lines.length, 6);
  for (const [scenario, id] of sessions) {
    const expected = ['recover', 'interrupt'].includes(scenario) ? [[1, true], [2, false]] : [[1, true]];
    assert.deepEqual(lines.filter(row => row.sessionId === id && row.scenario === scenario)
      .map(row => [row.attempt, row.original]), expected);
  }
  console.log('Packaged desktop verified four synthetic sessions: one continuation on the same session, manual recovery after the second interruption, cache 60.0% / 未知 / 0%.');
}

async function openAccountSettings(page) {
  await page.keyboard.press('Control+,');
  await page.getByTestId('settings-tab-accounts').press('Enter');
  await page.getByTestId('create-profile-input').waitFor();
}

async function checkIsolatedProfileQuota(page, sessionId) {
  const pane = page.getByTestId('session-pane-' + sessionId);
  const weekly = pane.getByTestId('quota-weekly');
  const details = pane.getByTestId('quota-details');
  await weekly.hover();
  await details.getByRole('status').filter({ hasText: /默认.*\/usage/ }).waitFor();
  assert.equal(await details.getByRole('button', { name: '刷新' }).count(), 0);
  assert.equal(await details.getByTestId('quota-bucket').count(), 0);
  await details.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  const [footer, panel, trigger] = await Promise.all([
    pane.locator('.quota-footer').boundingBox(), details.boundingBox(), weekly.boundingBox(),
  ]);
  assert.ok(footer && panel && trigger);
  const gap = Math.round(footer.y - (panel.y + panel.height));
  const x = trigger.x + trigger.width / 2;
  assert.equal(gap, 8);
  await page.mouse.move(x, footer.y + 1);
  for (let distance = 0; distance <= gap + 2; distance++) {
    await page.mouse.move(x, footer.y - distance);
    assert.ok(await details.isVisible(), 'Quota preview closed ' + distance + 'px above the footer');
  }
  await page.getByTestId('app-topbar').hover();
  await details.waitFor({ state: 'detached' });
  await weekly.click();
  await page.getByTestId('app-topbar').hover();
  assert.ok(await details.isVisible(), 'Quota panel lost its click pin on pointer exit');
  await page.keyboard.press('Escape');
  await details.waitFor({ state: 'detached' });
  assert.equal(await weekly.getAttribute('aria-expanded'), 'false');
}

async function checkProfileModelHistory(page, cwd, fixture) {
  const promptTrace = await readFile(fixture.trace, 'utf8');
  const profiles = [];
  const modelIds = id => ['qa-' + id, 'qa-' + id + '-fast'];
  async function assertCatalog(id, source, models) {
    const status = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
    assert.equal(status.connected, true, status.lastError);
    assert.equal(status.activeProfileId, id);
    assert.equal(status.modelListSource, source);
    assert.deepEqual(status.availableModels.map(model => model.modelId), models);
    assert.equal(status.activeSessionCount, source === 'live' ? 1 : 0);
  }
  async function switchTo(id) {
    await page.getByTestId('switch-profile-' + id).click();
    await page.getByTestId('profile-row-' + id).locator('.badge-accent').waitFor();
    await page.getByTestId('empty-pane-0').getByRole('heading').waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-testid^="session-pane-"]').count(), 0);
  }
  await openAccountSettings(page);
  for (const name of ['Fixture Profile A', 'Fixture Profile B']) {
    await typeInField(page.getByTestId('create-profile-input'), name);
    await page.getByTestId('create-profile-btn').press('Enter');
    const row = page.locator('[data-testid^="profile-row-"]').filter({ hasText: name });
    await row.waitFor();
    const id = (await row.getAttribute('data-testid')).slice('profile-row-'.length);
    assert.match(id, /^profile-[a-f0-9-]{36}$/);
    assert.equal(path.resolve(await row.getAttribute('title')), path.join(fixture.env.GRAVITY_QA_PROFILES_DIR, id));
    profiles.push({ id, title: name + ' session' });
  }
  assert.notEqual(profiles[0].id, profiles[1].id);
  for (const profile of profiles) {
    await switchTo(profile.id);
    await assertCatalog(profile.id, 'unknown', []);
    assert.deepEqual(await page.evaluate(() => window.gravityDesktop.listSessions()), []);
    await page.keyboard.press('Escape');
    const { id, composer } = await createDesktopSession(page, cwd, profile.title);
    profile.sessionId = id;
    assert.equal(await composer.inputValue(), '');
    assert.deepEqual(await page.evaluate(async id => (await window.gravityDesktop.getSessionMessagePage(id)).messages, id), []);
    await assertCatalog(profile.id, 'live', modelIds(profile.id));
    const chip = page.getByTestId('model-select-' + id);
    await chip.click();
    const choices = page.getByTestId('model-menu-' + id).locator('.model-menu-list [role="menuitemradio"]');
    await choices.first().waitFor();
    assert.deepEqual(await choices.evaluateAll(items => items.map(item => item.title)), modelIds(profile.id));
    assert.equal(await choices.first().getAttribute('aria-checked'), 'true');
    await chip.click();
    if (profile === profiles[0]) await checkIsolatedProfileQuota(page, id);
    await typeInField(composer, profile.title + ' private draft');
    await openAccountSettings(page);
  }
  // The mock intentionally reuses session IDs across its processes, so an unscoped lookup is observable.
  assert.equal(profiles[0].sessionId, profiles[1].sessionId);
  for (const profile of profiles) {
    await switchTo(profile.id);
    await assertCatalog(profile.id, 'cached', modelIds(profile.id));
    const rows = await page.evaluate(() => window.gravityDesktop.listSessions());
    assert.deepEqual(rows.map(row => [row.profileId, row.sessionId, row.title, row.modelId]), [
      [profile.id, profile.sessionId, profile.title, modelIds(profile.id)[0]],
    ]);
  }
  await switchTo('default');
  await assertCatalog('default', 'cached', ['mock-model', 'mock-model-2']);
  const defaultSessions = await page.evaluate(() => window.gravityDesktop.listSessions());
  assert.deepEqual(defaultSessions.map(row => row.title).sort(), ['Fixture interrupt', 'Fixture recover', 'Fixture unknown', 'Fixture zero']);
  assert.equal(await readFile(fixture.trace, 'utf8'), promptTrace);
  console.log('Packaged desktop switched between two isolated profiles. Each began with no reported models, displayed its own live menu, and recovered only its own cached models and session title. The four default-profile sessions remained intact.');
}

async function checkRecordedSession(page, firstLaunch) {
  const search = page.getByTestId('sidebar-search-input');
  await typeInField(search, '记录交互测试');
  const thread = page.getByRole('group', { name: '记录交互测试', exact: true });
  await thread.focus();
  await thread.press('Enter');
  const thought = page.getByTestId('thinking-block-qa-thought').locator('.cc-thinking-head');
  await thought.waitFor({ timeout: 10000 }).catch(async error => {
    const info = await page.evaluate(async id => {
      const boot = await window.gravityDesktop.getBootstrap();
      return { sessions: boot.sessions.map(s => [s.sessionId, s.status]), tabs: boot.layout.openTabSessionIds,
        messages: (await window.gravityDesktop.getSessionMessagePage(id)).messages.length, text: document.body.innerText.slice(0, 600) };
    }, recordedId);
    throw new Error('Recorded transcript missing in window: ' + JSON.stringify(info), { cause: error });
  });
  assert.equal(await thought.getAttribute('aria-expanded'), String(firstLaunch));
  if (firstLaunch) await thought.click();
  const tab = page.getByTestId('inspector-tab-terminal');
  assert.equal(await tab.locator('.tone-danger').count(), firstLaunch ? 1 : 0);
  await tab.click();
  const row = page.locator('.term').filter({ hasText: 'END_OF_COMMAND' });
  assert.equal(await row.locator('pre').count(), 0);
  await row.getByRole('button', { name: '展开' }).click();
  assert.equal(await row.locator('code').textContent(), longCommand);
  assert.equal(await row.locator('pre').textContent(), 'PACKAGED_OUTPUT');
  await row.getByRole('button', { name: '收起' }).click();
  const grant = await page.evaluate(async id => (await window.gravityDesktop.getBootstrap()).sessions.find(row => row.sessionId === id), recordedId);
  assert.equal(grant?.hasApprovalGrants, true);
  assert.equal(grant.approvalModeOverride, 'rules-only');
  if (!firstLaunch) {
    const clear = page.getByRole('button', { name: '清除本会话已记住的授权' });
    await clear.click();
    await clear.waitFor({ state: 'detached' });
    await thought.waitFor();
    const cleared = await page.evaluate(async id => (await window.gravityDesktop.getBootstrap()).sessions.find(row => row.sessionId === id), recordedId);
    assert.equal(cleared.hasApprovalGrants, false);
    assert.equal(cleared.approvalModeOverride, undefined);
    console.log('Packaged durable approvals: reopened the same sample conversation across processes, cleared both remembered grants in the UI and continued reading offline.');
  }
  await page.getByTestId('inspector-tab-swarm').click();
  assert.equal(await page.getByRole('button', { name: '加载演示拓扑' }).count(), 0);
  assert.equal(await tab.locator('.tab-count').count(), 0);
  const group = page.getByTestId('tool-group-qa-read');
  assert.equal(await group.evaluate(el => el.open), false);
  await group.locator('summary').click();
  assert.equal(await group.locator('.tool-group-body > .cc-tool').count(), 2);
  const userMessage = page.getByTestId('user-msg-qa-user');
  assert.equal(await userMessage.locator('.sent-annotation blockquote').textContent(), '示意图');
  assert.equal(await userMessage.locator('.sent-annotation p').textContent(), '显示本地图片');
  assert.doesNotMatch(await userMessage.textContent(), /Notations|请严格结合|针对原文/);
  const markdown = page.locator('.md').filter({ has: page.locator('img[alt="本地图片"]') });
  const inlineImgRef = markdown.locator('p').first().locator('a.md-link-file');
  assert.equal((await inlineImgRef.textContent())?.trim(), '本地图片');
  assert.ok((await inlineImgRef.getAttribute('title') || '').includes('./本地 示意图.png'));
  assert.equal(await markdown.locator('p img').count(), 0);
  assert.equal(await markdown.locator('[data-testid="message-previews"]').evaluate(el => el.previousElementSibling.textContent), '这是正文的最后一段。');
  const image = page.getByRole('button', { name: '本地图片' });
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('img[alt="本地图片"]')?.naturalWidth > 0);
  await image.click();
  await page.locator('dialog[open] img').waitFor();
  assert.ok(await page.locator('dialog img').evaluate(el => el.complete && el.naturalWidth > 0));
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({ state: 'detached' });
  await page.getByTestId('inspector-tab-swarm').click();
  await page.getByTestId('swarm-title-banner').waitFor();
  await page.getByTestId('swarm-earlier').click();
  await page.getByTestId('swarm-board-seq-1').waitFor();
  assert.match(await page.getByTestId('swarm-board-seq-1').innerText(), /合成协作消息 1/);
  await page.getByTestId('swarm-newer').click();
  await page.getByTestId('swarm-board-seq-54').waitFor();
  await page.getByTestId('inspector-tab-context').click();
  const scale = page.getByTestId('heatmap-y-scale');
  await scale.waitFor();
  assert.doesNotMatch(await scale.innerText(), /\$/);
  assert.match(await scale.locator('[title]').first().getAttribute('title'), /Token/i);
  assert.match(await page.getByTestId('heatmap-24h-bars').locator('[title]').first().getAttribute('title'), /\$/);
  await page.getByTestId('inspector-tab-plan').click();
  console.log('Packaged built-ins: migrated 54 board messages, navigated oldest and newest pages without members, and checked the Token chart and dollar tooltip.');
  console.log('Recorded desktop session — persistent thought and terminal state, complete command, grouped operations, real local PNG and zoom OK');
}

async function checkReviewerActivation(page, profile, endpoint, requests) {
  const original = await page.evaluate(async endpoint => {
    const bridge = window.gravityDesktop;
    const before = (await bridge.getBootstrap()).approvalConfig;
    await bridge.updateApprovalConfig({ mode: 'manual', externalReviewer: {
      provider: 'local-ollama', endpoint, model: 'sample-ui-review', enabled: false, timeoutMs: 15000,
    } });
    return before;
  }, endpoint);
  const toggle = page.getByTestId('reviewer-enable-action');
  const row = page.locator('.setting-row').filter({ has: toggle });
  const feedback = row.getByTestId('reviewer-activation-feedback');
  const confirm = row.getByTestId('reviewer-test-and-enable');
  async function openReviewer() {
    await page.keyboard.press('Control+,');
    await page.getByTestId('settings-tab-approvals').click();
    await page.getByTestId('drawer-tab-reviewer').click();
    await toggle.waitFor();
  }
  async function saved(enabled, mode) {
    let config;
    const deadline = Date.now() + 5000;
    do {
      config = JSON.parse(await readFile(path.join(profile, 'approval-config.json'), 'utf8'));
      if (config.externalReviewer.enabled === enabled && config.mode === mode) break;
      await delay(25);
    } while (Date.now() < deadline);
    assert.equal(config.externalReviewer.enabled, enabled);
    assert.equal(config.externalReviewer.model, 'sample-ui-review');
    assert.equal(config.mode, mode);
    return config.externalReviewer;
  }
  async function startTest(number) {
    await confirm.click();
    await confirm.filter({ hasText: /正在测试/ }).waitFor();
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(await toggle.isChecked(), false);
    const deadline = Date.now() + 5000;
    while (requests.length < number && Date.now() < deadline) await delay(25);
    assert.equal(requests.length, number, 'Each explicit test must send exactly one model request');
    const { body, response } = requests[number - 1];
    const sample = JSON.parse(body.messages.find(message => message.role === 'user').content);
    assert.equal(sample.command, 'git status');
    assert.equal(sample.intentSummary, 'Connection test using a fixed read-only example');
    return response;
  }
  try {
    await openReviewer();
    assert.equal(await toggle.isChecked(), false);
    await toggle.click();
    await feedback.waitFor();
    await confirm.waitFor();
    assert.match(await feedback.innerText(), /sample-ui-review/);
    assert.match(await feedback.innerText(), /样例/);
    assert.match(await feedback.innerText(), /计费/);
    assert.match(await confirm.innerText(), /测试并启用/);
    assert.equal(await toggle.isChecked(), false);
    assert.equal((await saved(false, 'manual')).verificationMethod, undefined);
    assert.equal(requests.length, 0, 'Opening the activation prompt must not call a model');
    const colors = await feedback.evaluate(element => {
      const sample = document.createElement('span');
      sample.style.color = 'var(--text-primary)';
      element.append(sample);
      const expected = getComputedStyle(sample).color;
      sample.remove();
      return { actual: getComputedStyle(element).color, expected };
    });
    assert.equal(colors.actual, colors.expected, 'The activation instructions must use the readable primary text color');
    await row.screenshot({ path: path.resolve('tests/artifacts/reviewer-activation-prompt.png') });

    const failed = await startTest(1);
    failed.writeHead(503).end(JSON.stringify({ error: 'Synthetic reviewer unavailable' }));
    await feedback.filter({ hasText: /503/ }).waitFor();
    assert.equal(await confirm.isEnabled(), true);
    assert.equal(await toggle.isChecked(), false);
    await saved(false, 'manual');

    const success = await startTest(2);
    success.end(JSON.stringify({ message: { content: JSON.stringify({
      recommended: 'ask', riskLevel: 'low', reason: '合成设置测试返回。',
    }) }, done: true, prompt_eval_count: 7, eval_count: 5 }));
    await page.locator('[data-testid="reviewer-enable-action"]:checked').waitFor();
    const settings = await saved(true, 'hybrid');
    assert.equal(settings.verificationMethod, 'review-call');
    assert.ok(Number.isFinite(Date.parse(settings.lastVerifiedAt)));
    await page.keyboard.press('Escape');
    await page.getByTestId('empty-pane-0').waitFor();
    await openReviewer();
    assert.equal(await toggle.isChecked(), true);
    await toggle.click();
    await saved(false, 'rules-only');
    assert.equal(await toggle.isChecked(), false);
    assert.equal(requests.length, 2, 'Disabling review must not call a model');
    await page.keyboard.press('Escape');
    await page.getByTestId('empty-pane-0').waitFor();
    await openReviewer();
    await toggle.click();
    await saved(true, 'hybrid');
    assert.equal(requests.length, 2, 'Re-enabling a verified configuration must reuse the saved test');
    const stats = await page.evaluate(() => window.gravityDesktop.getTelemetryDashboard());
    assert.equal(stats.externalReviewer?.cumulativeAllTime.callCount ?? 0, 0);
    console.log('Packaged reviewer settings: click offered confirmation, HTTP 503 kept review off, retry saved hybrid, disabling saved rules-only, and re-enabling reused the saved test. Two loopback probes, zero chat reviews.');
  } finally {
    if (await page.getByTestId('settings-tab-approvals').isVisible()) await page.keyboard.press('Escape');
    await page.evaluate(config => window.gravityDesktop.updateApprovalConfig({
      mode: config.mode, externalReviewer: config.externalReviewer,
    }), original);
  }
}

async function checkExternalSampleTests(page, profile) {
  const calls = [];
  const uiRequests = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({ models: [{ name: 'sample-translate' }, { name: 'sample-review' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/api/chat') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const { model } = body;
    calls.push(model);
    if (model === 'sample-ui-review') {
      uiRequests.push({ body, response });
      return;
    }
    const content = model === 'sample-translate' ? '正在检查配置文件。' :
      JSON.stringify({ recommended: 'ask', riskLevel: 'low', reason: '样例复核已返回。' });
    response.end(JSON.stringify({ message: { content }, prompt_eval_count: 7, eval_count: 5, done: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    const checks = await page.evaluate(async endpoint => {
      const bridge = window.gravityDesktop;
      const original = await bridge.getBootstrap();
      const base = { provider: 'local-ollama', endpoint, enabled: true, timeoutMs: 8000 };
      const translation = { ...base, model: 'sample-translate' };
      const review = { ...base, model: 'sample-review' };
      const discovered = await bridge.discoverExternalTranslationModels(base);
      const rejected = await bridge.updateTranslationConfig({ engine: 'external-api', externalTranslator: translation })
        .then(() => false, () => true);
      const tr = await bridge.testExternalTranslatorConnection(translation);
      const rv = await bridge.testExternalReviewerConnection(review);
      const trSaved = await bridge.updateTranslationConfig({ engine: 'external-api', externalTranslator: translation });
      const rvSaved = await bridge.updateApprovalConfig({ mode: 'hybrid', externalReviewer: review });
      const stats = await bridge.getTelemetryDashboard();
      await bridge.updateTranslationConfig(original.translationConfig);
      await bridge.updateApprovalConfig({ mode: original.approvalConfig.mode, externalReviewer: original.approvalConfig.externalReviewer });
      return { models: discovered.models.length, rejected, translation: tr.sampleTranslation, review: rv.message,
        activeTranslation: trSaved.externalTranslator.enabled, activeReviewer: rvSaved.externalReviewer.enabled,
        chatTranslationCalls: stats.externalTranslator?.cumulativeAllTime.callCount ?? 0,
        chatReviewCalls: stats.externalReviewer?.cumulativeAllTime.callCount ?? 0 };
    }, endpoint);
    assert.deepEqual(checks, { models: 2, rejected: true, translation: '正在检查配置文件。', review: '样例复核已返回。',
      activeTranslation: true, activeReviewer: true, chatTranslationCalls: 0, chatReviewCalls: 0 });
    assert.deepEqual(calls, ['sample-translate', 'sample-review']);
    console.log('Desktop sample connections: local HTTP fixture returned translation and review; model listing alone could not enable translation; chat counters stayed at zero.');
    await checkReviewerActivation(page, profile, endpoint, uiRequests);
    assert.deepEqual(calls, ['sample-translate', 'sample-review', 'sample-ui-review', 'sample-ui-review']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function checkSessionActions(page) {
  const more = page.getByTestId('manage-session-' + recordedId);
  const actions = page.getByRole('dialog', { name: '管理会话' });
  const row = page.getByRole('group', { name: '记录交互测试', exact: true });
  await row.hover();
  await more.click();
  await actions.getByRole('button', { name: '归档会话' }).click();
  const archive = page.getByTestId('archived-sessions');
  await archive.locator('summary').click();
  await page.getByTestId('archived-session-' + recordedId).click();
  await actions.getByRole('button', { name: '恢复会话' }).click();
  await row.hover();
  await more.click();
  await actions.getByRole('button', { name: '删除会话' }).click();
  await actions.getByRole('button', { name: '取消' }).click();
  assert.ok((await page.evaluate(async id => (await window.gravityDesktop.getSessionMessagePage(id)).messages, recordedId)).length > 0);
  await row.hover();
  await more.click();
  await actions.getByRole('button', { name: '删除会话' }).click();
  await actions.getByRole('button', { name: '确认永久删除' }).click();
  await more.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(async id => (await window.gravityDesktop.getSessionMessagePage(id)).messages, recordedId), []);
  console.log('Desktop: archived, restored, cancelled deletion, then deleted the disposable conversation.');
}

async function checkLiveQuota(page) {
  const weekly = page.getByTestId('quota-weekly');
  await weekly.waitFor();
  await weekly.hover();
  const view = page.getByTestId('quota-details');
  const bucket = view.getByTestId('quota-bucket').first();
  await bucket.or(view.getByRole('alert')).first().waitFor({ timeout: 85000 });
  if (!await bucket.count()) throw new Error(await view.getByRole('alert').textContent());
  assert.ok(await view.locator('progress').count() > 0);
  const bucketCount = await view.getByTestId('quota-bucket').count();
  const weeklyAmount = await view.locator('article[title="gemini-weekly"] header span').textContent();
  assert.ok(weeklyAmount && (await weekly.textContent()).includes(weeklyAmount));
  await page.getByTestId('topbar-app-icon').hover();
  await view.waitFor({ state: 'detached' });
  assert.ok(await weekly.isVisible());
  console.log('Official account quota: ' + bucketCount + ' windows. Weekly badge matched the official row and remained visible after dismissal.');
}

async function exerciseLiveChat(page, cwd) {
  const welcome = page.getByTestId('empty-pane-0');
  await welcome.getByRole('heading').waitFor();
  const start = page.getByTestId('sidebar-new-session-btn');
  await start.focus();
  await start.press('Enter');
  await typeInField(page.getByTestId('new-session-cwd-input'), cwd);
  await typeInField(page.getByTestId('new-session-title-input'), 'Gravity Windows QA');
  await page.getByTestId('confirm-create-session-btn').press('Enter');
  const composer = page.locator('[data-testid^="composer-input-"]').first();
  await composer.waitFor({ timeout: 45000 });
  const sessionId = (await composer.getAttribute('data-testid')).slice('composer-input-'.length);
  let step = 'sending the first user message';
  try {
    if (process.env.GRAVITY_DESKTOP_LIVE === 'quota') {
      step = 'reading the official quota in the open conversation';
      await checkLiveQuota(page);
      await page.evaluate(id => window.gravityDesktop.closeSession(id), sessionId);
      return;
    }
    if (process.env.GRAVITY_DESKTOP_LIVE === 'question') {
      step = 'asking the model to present two color choices';
      await typeInField(composer, 'Use your native ask_question tool to ask me which accent color I prefer. Offer Teal and Amber as two choices. Wait for my answer, then repeat my chosen color in a short sentence. No files or commands.');
      await composer.press('Enter');
      const form = page.getByTestId('question-bar');
      await form.waitFor({ timeout: 70000 });
      const native = await page.evaluate(async id => (await window.gravityDesktop.getSessionMessagePage(id)).messages.some(m => m.question?.state === 'open'), sessionId);
      step = 'editing and submitting a color choice';
      const choice = form.getByRole('button', { name: /teal|青绿/i }).first();
      await choice.press('Enter');
      await typeInField(form.getByRole('textbox', { name: /修改选项|Edit option/i }).first(), 'Sea glass green');
      await form.getByRole('button', { name: '发送回答' }).press('Enter');
      await form.waitFor({ state: 'detached' });
      step = 'confirming the model received the edited color';
      await page.waitForFunction(async id => (await window.gravityDesktop.getSessionMessagePage(id)).messages
        .some(m => m.role === 'assistant' && !m.isStreaming && /sea glass green/i.test(m.content)), sessionId, { timeout: 85000 });
      await checkLiveQuota(page);
      console.log('Official model answered the edited choice Sea glass green; question source = ' + (native ? 'native form' : 'chat options'));
      await page.evaluate(id => window.gravityDesktop.closeSession(id), sessionId);
      return;
    }
    await typeInField(composer, 'Reply only with GRAVITY_OK. No tools are needed.');
    await composer.press('Enter');
    step = 'waiting for the official reply in the chat window';
    await page.locator('[data-testid^="assistant-body-"]').filter({ hasText: 'GRAVITY_OK' }).first().waitFor({ timeout: 75000 });
    const swarm = await page.evaluate(id => window.gravityDesktop.getSwarmState(id), sessionId);
    assert.equal(swarm.workers.some(w => w.name === 'thought-translator'), false);
    step = 'editing the previous user message using the empty composer shortcut';
    await page.waitForFunction(async id => (await window.gravityDesktop.getSessionMessagePage(id)).messages.some(m => m.role === 'assistant' && !m.isStreaming), sessionId);
    await composer.press('ArrowUp');
    const editor = page.getByRole('textbox', { name: '编辑原消息' });
    await typeInField(editor, 'Reply only with GRAVITY_REVISED. No tools are needed.');
    await editor.press('Control+Enter');
    const next = await page.waitForFunction(id => {
      const error = document.querySelector('.message-editor [role="alert"]');
      if (error) return { error: error.textContent };
      const active = document.querySelector('[data-testid^="composer-input-"]')?.getAttribute('data-testid');
      if (active && active !== 'composer-input-' + id) return { branch: active.slice('composer-input-'.length) };
    }, sessionId, { timeout: 45000 }).then(handle => handle.jsonValue());
    assert.ok(next.branch, next.error || 'Revision did not open a branch');
    step = 'waiting for the official response in the new branch';
    await page.waitForFunction(async id => {
      const messages = (await window.gravityDesktop.getSessionMessagePage(id)).messages;
      return messages.some(m => m.sendFailed || (m.role === 'assistant' && !m.revisionHistory && !m.isStreaming && m.content.trim()));
    }, next.branch, { timeout: 120000, polling: 700 });
    await page.locator('[data-testid^="assistant-body-"]').filter({ hasText: 'GRAVITY_REVISED' }).first().waitFor({ timeout: 7000 });
    const branchId = (await composer.getAttribute('data-testid')).slice('composer-input-'.length);
    assert.notEqual(branchId, sessionId);
    const checked = await page.evaluate(async ([origin, branch]) => ({
      old: (await window.gravityDesktop.getSessionMessagePage(origin)).messages.filter(m => m.role === 'user').map(m => m.content),
      edited: (await window.gravityDesktop.getSessionMessagePage(branch)).messages.filter(m => m.role === 'user').map(m => m.content),
      swarm: await window.gravityDesktop.getSwarmState(branch),
    }), [sessionId, branchId]);
    assert.equal(checked.old.length, 1); assert.match(checked.old[0], /GRAVITY_OK/);
    assert.equal(checked.edited.length, 1); assert.match(checked.edited[0], /GRAVITY_REVISED/);
    assert.equal(checked.swarm.workers.some(w => w.name === 'thought-translator'), false);
    step = 'reading the official quota before closing the conversation footer';
    await checkLiveQuota(page);
    await page.evaluate(id => window.gravityDesktop.closeSession(id), branchId);
    step = 'closing the verified session';
    await page.evaluate(id => window.gravityDesktop.closeSession(id), sessionId);
    console.log('Portable live chat — created from the UI, original and revised prompts answered, local branch has no translation member');
  } catch (error) {
    if (!page.isClosed()) {
      const diagnostic = await page.evaluate(async id => {
        const { sessions, layout } = await window.gravityDesktop.getBootstrap();
        const testSessions = sessions.filter(s => s.sessionId === id);
        return { tabs: layout.openTabSessionIds, alert: document.querySelector('.message-editor [role="alert"]')?.textContent,
          sessions: await Promise.all(testSessions.map(async s => ({ id: s.sessionId, status: s.status, model: s.modelId,
            messages: (await window.gravityDesktop.getSessionMessagePage(s.sessionId)).messages.map(m => ({ role: m.role, streaming: m.isStreaming, failed: m.sendFailed, text: m.content.slice(0, 400), question: m.question, tools: m.toolCalls?.map(t => t.canonicalToolName) })) }))) };
      }, sessionId).catch(() => undefined);
      console.error('Disposable QA conversation state: ' + JSON.stringify(diagnostic));
      await page.evaluate(id => window.gravityDesktop.closeSession(id), sessionId).catch(() => {});
    }
    throw new Error('Portable live chat failed while ' + step, { cause: error });
  }
}

async function inspectPackage(executable, profile, firstLaunch, liveWorkspace, fixture) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const childEnv = { ...process.env, ...fixture?.env, AGY_BINARY_PATH: fixture?.binary ?? (liveWorkspace ? (process.env.AGY_BINARY_PATH || '') : path.join(profile, 'offline', 'agy.exe')), AGY_RENDERER_URL: '' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
    cwd: liveWorkspace || process.cwd(),
    env: childEnv,
    windowsHide: true, stdio: 'ignore',
  });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  // The portable launcher extracts Electron before creating its actual desktop window.
  let browser;
  try {
    const deadline = Date.now() + 45000;
    while (!browser && Date.now() < deadline) {
      const lines = (await readFile(portFile, 'utf8').catch(() => '')).trim().split(/\r?\n/);
      if (lines[0] && lines[1]) {
        browser = await chromium.connectOverCDP('ws://127.0.0.1:' + lines[0] + lines[1], { timeout: 2000 }).catch(() => undefined);
      }
      if (!browser) await delay(150);
    }
    assert.ok(browser, 'Packaged Electron did not open its isolated window');
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 10000 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const readyOrError = page.locator('[data-testid="agy-app-root"], [data-testid="app-bootstrap-error"]').first();
    try {
      await readyOrError.waitFor({ timeout: liveWorkspace ? 90000 : 30000 });
      const bootError = page.getByTestId('app-bootstrap-error');
      if (await bootError.count()) throw new Error(await bootError.innerText());
    } catch (error) {
      const status = await page.evaluate(() => ({ protocol: location.protocol, title: document.title,
        bridge: Boolean(window.gravityDesktop), loading: document.querySelector('[data-testid="app-loading"]')?.textContent?.slice(0, 400) }));
      throw new Error('Isolated desktop startup: ' + JSON.stringify({ status, errors }), { cause: error });
    }
    assert.equal(await page.title(), 'Gravity');
    assert.equal(new URL(page.url()).protocol, 'file:');
    const connection = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
    assert.equal(connection.connected, Boolean(liveWorkspace), connection.lastError);
    if (fixture) {
      assert.equal(path.resolve(connection.agyBinaryPath), fixture.binary);
      assert.equal(connection.agyVersion, '1.0.0');
      await checkRecoveryAndCache(page, liveWorkspace, fixture);
      await checkProfileModelHistory(page, liveWorkspace, fixture);
      assert.deepEqual(errors, []);
      return;
    }
    if (!liveWorkspace) assert.ok(connection.lastError);
    assert.equal(await page.getByTestId('topbar-app-icon').evaluate(img => img.complete && img.naturalWidth > 0), true);
    const welcome = page.getByTestId('empty-pane-0');
    await welcome.getByRole('heading').waitFor();
    assert.equal(await page.locator('[data-testid^="session-pane-"]').count(), 0);
    // Observe a settled, empty launch before exercising navigation and opening a conversation.
    await delay(2500);
    assert.ok(await welcome.isVisible());
    assert.equal(await page.locator('[data-testid^="session-pane-"]').count(), 0);
    if (!liveWorkspace) {
      const initialDpr = await page.evaluate(() => window.devicePixelRatio);
      for (let press = 0; press < 3; press++) await page.keyboard.press('Control+Equal');
      await page.getByTestId('app-toast').filter({ hasText: '130%' }).waitFor();
      await page.waitForFunction(base => Math.abs(window.devicePixelRatio / base - 1.3) < 0.01, initialDpr);
      assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).uiScale, 1.3);
      await page.keyboard.press('Control+0');
      await page.getByTestId('app-toast').filter({ hasText: '100%' }).waitFor();
      await page.waitForFunction(base => Math.abs(window.devicePixelRatio / base - 1) < 0.01, initialDpr);
      assert.equal(JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8')).uiScale, 1);
    }
    await page.keyboard.press('Control+,');
    await page.getByTestId('settings-tab-about').press('Enter');
    const about = page.getByTestId('about-gravity-modal');
    await about.getByText('Gravity', { exact: true }).first().waitFor();
    await about.getByText(expectedVersion, { exact: true }).waitFor();
    if (!liveWorkspace) {
      await page.getByTestId('settings-tab-general').press('Enter');
      assert.match(await page.getByTestId('translation-engine').textContent(), /本地|离线/);
    }
    if (firstLaunch) {
      await page.getByTestId('settings-tab-themes').press('Enter');
      await page.getByTestId('theme-card-solarized-dark').press('Enter');
    }
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'solarized-dark');
    await page.keyboard.press('Escape');
    await welcome.getByRole('heading').waitFor();
    if (!liveWorkspace) {
      if (!firstLaunch) await checkExternalSampleTests(page, profile);
      await checkRecordedSession(page, firstLaunch);
      if (firstLaunch) {
        await page.getByTestId('tab-close-' + recordedId).press('Enter');
        await welcome.waitFor();
      } else await checkSessionActions(page);
    } else {
      // Stop this test run if the official client requests verification or reports a rate limit.
      const notice = page.locator('.cc-system, [role="alert"], .toast').filter({
        hasText: /\b(?:403|429)\b|rate.?limit|too many requests|captcha|verification required|限流|安全验证|人机验证|请求过于频繁/i,
      }).first();
      await Promise.race([
        process.env.GRAVITY_DESKTOP_LIVE === 'titles' ? checkLiveTitle(page, profile) : exerciseLiveChat(page, liveWorkspace),
        notice.waitFor({ timeout: 0 }).then(() => { throw new Error('Official service requested verification or reported a rate limit. Live checks stopped.'); }),
      ]);
    }
    assert.deepEqual(errors, []);
    console.log(path.relative(process.cwd(), executable) + ' — Gravity, desktop IPC, icons, settings and persisted theme OK');
  } finally {
    if (browser) {
      const session = await browser.newBrowserCDPSession().catch(() => undefined);
      await session?.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
    }
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error('Test instance did not exit')); }, 10000);
      })]);
    } finally { clearTimeout(timer); }
  }
}

(async () => {
  assert.equal(process.platform, 'win32');
  const profile = await mkdtemp(path.join(tmpdir(), 'gravity-package-'));
  const synthetic = process.env.GRAVITY_DESKTOP_SYNTHETIC === 'recovery-cache';
  let workspace, liveProfile;
  try {
    const artifacts = path.resolve('tests/artifacts');
    await mkdir(artifacts, { recursive: true });
    workspace = await mkdtemp(path.join(artifacts, 'desktop-qa-'));
    if (synthetic) {
      const fixture = await prepareRecoveryFixture(profile);
      await inspectPackage(path.join(releaseRoot, 'Gravity.exe'), profile, true, workspace, fixture);
      return;
    }
    await seedRecordedSession(profile, workspace);
    await inspectPackage(path.join(releaseRoot, 'win-unpacked/Gravity.exe'), profile, true);
    await inspectPackage(path.join(releaseRoot, 'Gravity.exe'), profile, false);
    if (process.env.GRAVITY_DESKTOP_LIVE) {
      liveProfile = await mkdtemp(path.join(tmpdir(), 'gravity-package-live-'));
      if (process.env.GRAVITY_DESKTOP_LIVE === 'titles') await seedTitleFixture(liveProfile, workspace);
      await inspectPackage(path.join(releaseRoot, 'Gravity.exe'), liveProfile, true, workspace);
    }
  } finally {
    if (synthetic) await removeRecoveryProfile(profile);
    else await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    if (liveProfile) await rm(liveProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
