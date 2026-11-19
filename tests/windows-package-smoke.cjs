const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
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
  await copyFile(path.resolve('assets/icons/gravity-claude-dark.png'), path.join(cwd, '本地 示意图.png'));
  await save('owned-sessions-default.json', { [recordedId]: { sessionId: recordedId, cwd, rawCwd: cwd, title: '记录交互测试', updatedAt: date,
    profileId: 'default', modelId: '', executionMode: 'default', reasoningEffort: 'high', status: 'closed', pinned: false, isLegacyApprovalPollution: false } });
  await save('layout.json', { openTabSessionIds: [], activePrimarySessionId: null, activeInspectorTab: 'plan' });
  await save('messages-default.json', { [recordedId]: [
    { id: 'qa-user', sessionId: recordedId, role: 'user', content: '【逐处标记批注 (Notations)】\n1. 针对原文「示意图」：显示本地图片（第 7 条消息）\n\n请严格结合以上逐处标记位置与批注说明进行修改或解答。', createdAt: date },
    { id: 'qa-agent', sessionId: recordedId, role: 'assistant', createdAt: date, completedAt: date,
      content: '配图见 ![本地图片](<./本地 示意图.png>)。\n\n这是正文的最后一段。',
      thoughts: [{ id: 'qa-thought', originalText: 'The image is ready.', translatedZhText: '图片准备好了。', translationSource: 'local-model', languageDetected: 'en', isStreaming: false }],
      toolCalls: [card('qa-read', 'Read', 'sample.txt'), card('qa-command', 'Bash', longCommand)] },
  ] });
}

async function typeInField(field, text) {
  await field.focus();
  await field.press('Control+a');
  await field.press('Backspace');
  await field.pressSequentially(text);
  assert.equal(await field.inputValue(), text);
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
  const userMessage = page.getByTestId('user-msg-qa-user');
  assert.equal(await userMessage.locator('.sent-annotation blockquote').textContent(), '示意图');
  assert.equal(await userMessage.locator('.sent-annotation p').textContent(), '显示本地图片');
  assert.doesNotMatch(await userMessage.textContent(), /Notations|请严格结合|针对原文/);
  const markdown = page.locator('.md').filter({ has: page.locator('img[alt="本地图片"]') });
  assert.ok((await markdown.locator('p').first().textContent()).includes('./本地 示意图.png'));
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
  console.log('Recorded desktop session — persistent thought and terminal state, complete command, grouped operations, real local PNG and zoom OK');
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
  assert.ok((await page.evaluate(id => window.gravityDesktop.getSessionMessages(id), recordedId)).length > 0);
  await row.hover();
  await more.click();
  await actions.getByRole('button', { name: '删除会话' }).click();
  await actions.getByRole('button', { name: '确认永久删除' }).click();
  await more.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(id => window.gravityDesktop.getSessionMessages(id), recordedId), []);
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
  if (process.env.GRAVITY_DESKTOP_LIVE === 'quota') return;
  let step = 'sending the first user message';
  try {
    if (process.env.GRAVITY_DESKTOP_LIVE === 'question') {
      step = 'asking the model to present two color choices';
      await typeInField(composer, 'Use your native ask_question tool to ask me which accent color I prefer. Offer Teal and Amber as two choices. Wait for my answer, then repeat my chosen color in a short sentence. No files or commands.');
      await composer.press('Enter');
      const form = page.getByTestId('question-bar');
      await form.waitFor({ timeout: 70000 });
      const native = await page.evaluate(async id => (await window.gravityDesktop.getSessionMessages(id)).some(m => m.question?.state === 'open'), sessionId);
      step = 'editing and submitting a color choice';
      const choice = form.getByRole('button', { name: /teal|青绿/i }).first();
      await choice.press('Enter');
      await typeInField(form.getByRole('textbox', { name: /修改选项|Edit option/i }).first(), 'Sea glass green');
      await form.getByRole('button', { name: '发送回答' }).press('Enter');
      await form.waitFor({ state: 'detached' });
      step = 'confirming the model received the edited color';
      await page.waitForFunction(async id => (await window.gravityDesktop.getSessionMessages(id))
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
    await page.waitForFunction(async id => (await window.gravityDesktop.getSessionMessages(id)).some(m => m.role === 'assistant' && !m.isStreaming), sessionId);
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
      const messages = await window.gravityDesktop.getSessionMessages(id);
      return messages.some(m => m.sendFailed || (m.role === 'assistant' && !m.revisionHistory && !m.isStreaming && m.content.trim()));
    }, next.branch, { timeout: 120000, polling: 700 });
    await page.locator('[data-testid^="assistant-body-"]').filter({ hasText: 'GRAVITY_REVISED' }).first().waitFor({ timeout: 7000 });
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
    console.log('Portable live chat — created from the UI, original and revised prompts answered, local branch has no translation member');
  } catch (error) {
    if (!page.isClosed()) {
      const diagnostic = await page.evaluate(async id => {
        const { sessions, layout } = await window.gravityDesktop.getBootstrap();
        const testSessions = sessions.filter(s => s.sessionId === id);
        return { tabs: layout.openTabSessionIds, alert: document.querySelector('.message-editor [role="alert"]')?.textContent,
          sessions: await Promise.all(testSessions.map(async s => ({ id: s.sessionId, status: s.status, model: s.modelId,
            messages: (await window.gravityDesktop.getSessionMessages(s.sessionId)).map(m => ({ role: m.role, streaming: m.isStreaming, failed: m.sendFailed, text: m.content.slice(0, 400), question: m.question, tools: m.toolCalls?.map(t => t.canonicalToolName) })) }))) };
      }, sessionId).catch(() => undefined);
      console.error('Disposable QA conversation state: ' + JSON.stringify(diagnostic));
      await page.evaluate(id => window.gravityDesktop.closeSession(id), sessionId).catch(() => {});
    }
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
    const welcome = page.getByTestId('empty-pane-0');
    await welcome.getByRole('heading').waitFor();
    assert.equal(await page.locator('[data-testid^="session-pane-"]').count(), 0);
    // Observe a settled, empty launch before exercising navigation and opening a conversation.
    await delay(2500);
    assert.ok(await welcome.isVisible());
    assert.equal(await page.locator('[data-testid^="session-pane-"]').count(), 0);
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
        (async () => { await exerciseLiveChat(page, liveWorkspace); if (process.env.GRAVITY_DESKTOP_LIVE !== 'question') await checkLiveQuota(page); })(),
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
