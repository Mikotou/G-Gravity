const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');
const releaseRoot = path.resolve(process.env.GRAVITY_RELEASE_DIR || 'release');
const expectedVersion = 'v' + require('../package.json').version;

const recordedId = 'gravity-packaged-ui-fixture';
const longCommand = 'echo ' + 'example-argument '.repeat(30) + 'END_OF_COMMAND';

async function seedRecordedSession(profile, cwd) {
  const date = new Date().toISOString();
  const card = (id, name, target) => ({ toolCallId: id, rawToolName: name, canonicalToolName: name,
    compactTarget: target.slice(0, 240), argsSummary: JSON.stringify({ command: target }), startedAt: date,
    completedAt: date, status: name === 'Bash' ? 'failed' : 'completed', outputPreview: 'PACKAGED_OUTPUT',
    ...(name === 'Bash' ? { exitCode: 1 } : {}) });
  const save = (file, data) => writeFile(path.join(profile, file), JSON.stringify(data), 'utf8');
  await copyFile(path.resolve('assets/icons/gravity-claude-dark.png'), path.join(cwd, '本地 示意图.png'));
  await save('owned-sessions-default.json', { [recordedId]: { sessionId: recordedId, cwd, rawCwd: cwd, title: '记录交互测试', updatedAt: date,
    profileId: 'default', modelId: '', executionMode: 'default', reasoningEffort: 'high', status: 'closed', pinned: false, isLegacyApprovalPollution: false } });
  await save('layout.json', { openTabSessionIds: [recordedId], activePrimarySessionId: recordedId, activeInspectorTab: 'plan' });
  await save('messages-default.json', { [recordedId]: [
    { id: 'qa-user', sessionId: recordedId, role: 'user', content: '显示本地图片', createdAt: date },
    { id: 'qa-agent', sessionId: recordedId, role: 'assistant', createdAt: date, completedAt: date,
      content: '![本地图片](<./本地 示意图.png>)',
      thoughts: [{ id: 'qa-thought', originalText: 'The image is ready.', translatedZhText: '图片准备好了。', translationSource: 'local-model', languageDetected: 'en', isStreaming: false }],
      toolCalls: [card('qa-read', 'Read', 'sample.txt'), card('qa-command', 'Bash', longCommand)] },
  ] });
}

async function checkRecordedSession(page, firstLaunch) {
  const thought = page.getByTestId('thinking-block-qa-thought').locator('.cc-thinking-head');
  await thought.waitFor({ timeout: 10000 }).catch(async error => {
    const info = await page.evaluate(async id => {
      const boot = await window.gravityDesktop.getBootstrap();
      return { sessions: boot.sessions.map(s => [s.sessionId, s.status]), tabs: boot.layout.openTabSessionIds,
        messages: (await window.gravityDesktop.getSessionMessages(id)).length, text: document.body.innerText.slice(0, 600) };
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
  await page.getByTestId('inspector-tab-swarm').click();
  assert.equal(await page.getByRole('button', { name: '加载演示拓扑' }).count(), 0);
  assert.equal(await tab.locator('.tab-count').count(), 0);
  const group = page.getByTestId('tool-group-qa-read');
  assert.equal(await group.evaluate(el => el.open), false);
  await group.locator('summary').click();
  assert.equal(await group.locator('.tool-group-body > .cc-tool').count(), 2);
  const image = page.getByRole('button', { name: '本地图片' });
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('img[alt="本地图片"]')?.naturalWidth > 0);
  await image.click();
  await page.locator('dialog[open] img').waitFor();
  assert.ok(await page.locator('dialog img').evaluate(el => el.complete && el.naturalWidth > 0));
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({ state: 'detached' });
  console.log('Recorded desktop session — persistent thought and terminal state, complete command, grouped operations, real local PNG and zoom OK');
}

async function chooseEngine(page, engine) {
  await page.getByTestId('settings-tab-general').click();
  await page.getByTestId('translation-engine').selectOption(engine);
  await page.waitForFunction(async wanted => (await window.gravityDesktop.getBootstrap()).preferences.translationEngine === wanted, engine);
}

async function exerciseLiveChat(page, cwd) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+n');
  await page.getByTestId('new-session-cwd-input').fill(cwd);
  await page.getByTestId('new-session-title-input').fill('Gravity Windows QA');
  await page.getByTestId('confirm-create-session-btn').click();
  const composer = page.locator('[data-testid^="composer-input-"]').first();
  await composer.waitFor({ timeout: 45000 });
  const sessionId = (await composer.getAttribute('data-testid')).slice('composer-input-'.length);
  let step = 'sending the first user message';
  try {
    await composer.fill('桌面发行版测试，请只回复 GRAVITY_OK。无需调用工具。');
    await page.getByTestId('send-prompt-btn-' + sessionId).click();
    step = 'waiting for the parent to register its translator';
    const ready = page.getByText(/蜂群翻译成员已就绪|蜂群翻译暂不可用/).first();
    await ready.waitFor({ timeout: 180000 });
    assert.match(await ready.textContent(), /成员已就绪/);
    step = 'waiting for the official reply in the chat window';
    await page.locator('[data-testid^="assistant-body-"]').filter({ hasText: 'GRAVITY_OK' }).first().waitFor({ timeout: 75000 });
    step = 'checking the real swarm member';
    const swarm = await page.evaluate(id => window.gravityDesktop.getSwarmState(id), sessionId);
    assert.match(swarm.workers.find(w => w.name === 'thought-translator')?.id || '', /^[0-9a-f-]{36}$/i);
    step = 'selecting the local engine and editing the earlier user turn';
    await page.keyboard.press('Control+,');
    await chooseEngine(page, 'local');
    await page.keyboard.press('Escape');
    const old = await page.evaluate(async id => (await window.gravityDesktop.getSessionMessages(id)).find(m => m.role === 'user').id, sessionId);
    await page.getByTestId('user-msg-' + old).hover();
    await page.getByTestId('edit-msg-' + old).click({ timeout: 30000 });
    await page.getByRole('textbox', { name: '编辑原消息' }).fill('桌面修订测试，请只回复 GRAVITY_REVISED，不需要调用工具。');
    await page.getByRole('button', { name: '重新发送' }).click();
    await page.locator('[data-testid^="assistant-body-"]').filter({ hasText: 'GRAVITY_REVISED' }).first().waitFor({ timeout: 120000 });
    const branchId = (await composer.getAttribute('data-testid')).slice('composer-input-'.length);
    assert.notEqual(branchId, sessionId);
    const checked = await page.evaluate(async ([origin, branch]) => ({
      old: (await window.gravityDesktop.getSessionMessages(origin)).filter(m => m.role === 'user').map(m => m.content),
      edited: (await window.gravityDesktop.getSessionMessages(branch)).filter(m => m.role === 'user').map(m => m.content),
      swarm: await window.gravityDesktop.getSwarmState(branch),
    }), [sessionId, branchId]);
    assert.equal(checked.old.length, 1); assert.match(checked.old[0], /GRAVITY_OK/);
    assert.equal(checked.edited.length, 1); assert.match(checked.edited[0], /GRAVITY_REVISED/);
    assert.equal(checked.swarm.workers.some(w => w.name === 'thought-translator'), false);
    await page.evaluate(id => window.gravityDesktop.closeSession(id), branchId);
    step = 'closing the verified session';
    await page.evaluate(id => window.gravityDesktop.closeSession(id), sessionId);
    console.log('Portable live chat — parent created from the UI, swarm member verified, original and revised prompts answered, local branch has no translation member');
  } catch (error) {
    if (!page.isClosed()) await page.evaluate(id => window.gravityDesktop.closeSession(id), sessionId).catch(() => {});
    throw new Error('Portable live chat failed while ' + step, { cause: error });
  }
}

async function inspectPackage(executable, profile, firstLaunch, liveWorkspace) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const child = spawn(executable, ['--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
    cwd: liveWorkspace || process.cwd(),
    env: { ...process.env, AGY_BINARY_PATH: liveWorkspace ? (process.env.AGY_BINARY_PATH || '') : path.join(profile, 'offline', 'agy.exe'), AGY_RENDERER_URL: '' },
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
    await page.getByTestId('agy-app-root').waitFor();
    assert.equal(await page.title(), 'Gravity');
    assert.equal(new URL(page.url()).protocol, 'file:');
    const connection = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
    assert.equal(connection.connected, Boolean(liveWorkspace), connection.lastError);
    if (!liveWorkspace) assert.ok(connection.lastError);
    assert.equal(await page.getByTestId('topbar-app-icon').evaluate(img => img.complete && img.naturalWidth > 0), true);
    if (!liveWorkspace) await checkRecordedSession(page, firstLaunch);
    await page.keyboard.press('Control+,');
    await page.getByTestId('settings-tab-about').click();
    const about = page.getByTestId('about-gravity-modal');
    await about.getByText('Gravity', { exact: true }).first().waitFor();
    await about.getByText(expectedVersion, { exact: true }).waitFor();
    if (!liveWorkspace) {
      await page.getByTestId('settings-tab-general').click();
      assert.equal(await page.getByTestId('translation-engine').inputValue(), firstLaunch ? 'swarm' : 'local');
      if (firstLaunch) await chooseEngine(page, 'local');
    }
    if (firstLaunch) {
      await page.getByTestId('settings-tab-themes').click();
      await page.getByTestId('theme-card-solarized-dark').click();
    }
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'solarized-dark');
    if (liveWorkspace) await exerciseLiveChat(page, liveWorkspace);
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
  let workspace, liveProfile;
  try {
    const artifacts = path.resolve('tests/artifacts');
    await mkdir(artifacts, { recursive: true });
    workspace = await mkdtemp(path.join(artifacts, 'desktop-qa-'));
    await seedRecordedSession(profile, workspace);
    await inspectPackage(path.join(releaseRoot, 'win-unpacked/Gravity.exe'), profile, true);
    await inspectPackage(path.join(releaseRoot, 'Gravity.exe'), profile, false);
    if (process.env.GRAVITY_DESKTOP_LIVE) {
      liveProfile = await mkdtemp(path.join(tmpdir(), 'gravity-package-live-'));
      await inspectPackage(path.join(releaseRoot, 'Gravity.exe'), liveProfile, true, workspace);
    }
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    if (liveProfile) await rm(liveProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
