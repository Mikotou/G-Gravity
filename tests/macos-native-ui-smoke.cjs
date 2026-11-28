// Run with node tests/macos-native-ui-smoke.cjs in a signed-in macOS desktop after npm run build.
// GRAVITY_MAC_EXECUTABLE can point to a packaged .app's Contents/MacOS/Gravity executable.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, mkdir, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { _electron: electron } = require('playwright-core');

const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const RECORDED_SESSION_ID = 'gravity-mac-v031-smoke';
const RECORDED_SESSION_TITLE = 'Mac v0.3.1 验收样例';

async function run() {
  if (process.platform !== 'darwin') {
    console.log('Skipped native menu, fullscreen and Terminal smoke test. It requires a logged-in macOS desktop.');
    return;
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gravity-mac-ui-')));
  const home = path.join(root, 'home');
  const profile = path.join(root, "client's data");
  const workspace = path.join(root, 'mac workspace');
  const cli = path.join(root, 'fake CLI', 'agy');
  const preferencesFile = path.join(profile, 'preferences.json');
  const profileId = 'profile-' + randomUUID();
  let desktop;
  try {
    await Promise.all([home, profile, workspace, path.dirname(cli)].map(dir => mkdir(dir)));
    const sampleImagePath = path.join(workspace, 'mac 示意图.png');
    await writeFile(sampleImagePath, TINY_PNG_BYTES);
    const sampleImageUrl = pathToFileURL(sampleImagePath).href;
    const nowIso = new Date().toISOString();
    await writeFile(preferencesFile, JSON.stringify({ locale: 'zh-CN', uiScale: 1, autoCheckUpdates: false }));
    await writeFile(path.join(profile, 'profiles.json'), JSON.stringify({
      activeProfileId: profileId, profiles: [{ profileId, name: 'Mac QA' }],
    }));
    await writeFile(path.join(profile, 'layout.json'), JSON.stringify({
      openTabSessionIds: [], activePrimarySessionId: null, activeInspectorTab: 'plan',
    }));
    await writeFile(path.join(profile, `owned-sessions-${profileId}.json`), JSON.stringify({
      [RECORDED_SESSION_ID]: {
        sessionId: RECORDED_SESSION_ID, cwd: workspace, rawCwd: workspace, title: RECORDED_SESSION_TITLE,
        updatedAt: nowIso, profileId, modelId: '', executionMode: 'default', reasoningEffort: 'high',
        status: 'closed', pinned: false, isLegacyApprovalPollution: false,
      },
    }));
    await writeFile(path.join(profile, `messages-${profileId}.json`), JSON.stringify({
      [RECORDED_SESSION_ID]: [
        { id: 'mac-u1', sessionId: RECORDED_SESSION_ID, role: 'user', content: '请检查本地示意图并汇总当前状态。', createdAt: nowIso },
        {
          id: 'mac-a1', sessionId: RECORDED_SESSION_ID, role: 'assistant', createdAt: nowIso, completedAt: nowIso,
          content: `- [mac 示意图.png](${sampleImageUrl}) — macOS 本地预览样例`,
          turnStop: {
            code: 'max_tokens', severity: 'paused', stopReason: 'max_tokens',
            titleZh: '回复因达到单轮长度上限而暂停', titleEn: 'Response paused at output length limit',
            messageZh: '已保留目前全部已生成内容。', messageEn: 'All partial output has been kept.',
            suggestionsZh: ['点击「继续生成」接着输出剩余部分。'], suggestionsEn: ['Click "Continue" to finish generating.'],
            actions: ['continue_turn', 'dismiss'], occurredAt: nowIso,
          },
        },
      ],
    }));
    // The test login requires a real Terminal and reports its exact arguments. Other invocations return offline.
    await writeFile(cli, [
      '#!/bin/sh', 'for arg do', '  if [ "$arg" = --login ]; then',
      '    [ -t 0 ] && [ -t 1 ] || exit 89',
      '    printf "%s\\n" "$@" > "$0.seen" || exit 87', '    exit 0', '  fi', 'done', 'exit 2', '',
    ].join('\n'), { mode: 0o700 });

    const pageErrors = [];
    const trackedPages = new WeakSet();
    function trackPage(page) {
      if (trackedPages.has(page)) return;
      trackedPages.add(page);
      page.on('pageerror', error => pageErrors.push(error?.message || String(error)));
    }
    async function verifyWindowReady(page) {
      trackPage(page);
      await page.waitForFunction(() => document.documentElement.dataset.windowChrome === 'mac-inset');
      await page.getByTestId('sidebar-new-session-btn').waitFor();
      await page.bringToFront();
      return page;
    }
    async function launch() {
      const packaged = process.env.GRAVITY_MAC_EXECUTABLE;
      const env = { ...process.env, HOME: home, AGY_BINARY_PATH: cli };
      delete env.AGY_RENDERER_URL;
      delete env.ELECTRON_RUN_AS_NODE;
      desktop = await electron.launch({
        executablePath: packaged || require('electron'), env,
        args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), '--user-data-dir=' + profile], timeout: 30_000,
      });
      desktop.on('window', trackPage);
      const page = await desktop.firstWindow();
      return verifyWindowReady(page);
    }
    async function checkView(expectedLabel) {
      const view = await desktop.evaluate(({ Menu }, label) => {
        const menu = Menu.getApplicationMenu();
        const items = menu.items.find(item => item.label === label)?.submenu?.items || [];
        return items.filter(item => item.id).map(item => ({
          id: item.id, role: item.role, accelerator: item.accelerator,
        }));
      }, expectedLabel);
      assert.deepEqual(view.map(item => item.id), ['gravity-size-actual', 'gravity-size-in', 'gravity-size-out', 'gravity-fullscreen']);
      assert.deepEqual(view.slice(0, 3).map(item => item.accelerator), ['Command+0', 'Command+Plus', 'Command+-']);
      // The fullscreen role supplies its platform shortcut. The actual native transition is checked below.
      assert.equal(view.at(-1).role, 'togglefullscreen');
    }
    async function clickMenu(id) {
      await desktop.evaluate(({ Menu, BrowserWindow }, itemId) => {
        const win = BrowserWindow.getAllWindows()[0];
        Menu.getApplicationMenu().getMenuItemById(itemId).click({}, win, win.webContents);
      }, id);
    }
    async function checkScale(page, value) {
      await page.waitForFunction(scale => {
        return document.documentElement.style.getPropertyValue('--win-controls-w') === Math.round(138 / scale) + 'px';
      }, value);
      // Give a duplicate keyboard/accelerator dispatch a chance to reach the renderer before checking the final value.
      await delay(180);
      const zoom = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
      assert.ok(Math.abs(zoom - value) < 0.0001, 'Actual window scale = ' + zoom + ', expected ' + value);
      assert.equal(JSON.parse(await readFile(preferencesFile, 'utf8')).uiScale, value);
    }
    async function fullscreen(expected) {
      await desktop.evaluate(({ Menu, BrowserWindow }, enter) => new Promise((resolve, reject) => {
        const win = BrowserWindow.getAllWindows()[0];
        const timer = setTimeout(() => reject(Error('Native fullscreen transition timed out')), 8_000);
        win.focus();
        win.once(enter ? 'enter-full-screen' : 'leave-full-screen', () => { clearTimeout(timer); resolve(); });
        // Cocoa handles the menu item's togglefullscreen role. Exercise its native responder action.
        Menu.sendActionToFirstResponder('toggleFullScreen:');
      }), expected);
      assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), expected);
    }
    async function closeLastWindowToDock(page) {
      const proc = desktop.process();
      let exited = false;
      let exitInfo = '';
      const onExit = (code, signal) => {
        exited = true;
        exitInfo = `code=${code}, signal=${signal}`;
      };
      proc.once('exit', onExit);
      try {
        const pageClosed = page.waitForEvent('close', { timeout: 15_000 });
        await desktop.evaluate(({ BrowserWindow }) => {
          const wins = BrowserWindow.getAllWindows();
          if (wins.length === 0) throw new Error('Expected at least one open window before closing');
          for (const win of wins) win.close();
        });
        await pageClosed;
        // Issue #3.3 (Decision D1): closing the last window on macOS keeps Electron resident in the Dock.
        await delay(800);
        assert.equal(exited, false, `Closing the last window on macOS must keep the app alive in the Dock (${exitInfo})`);
        assert.equal(proc.exitCode, null, 'Electron process exitCode must remain null while resident in the Dock');
        assert.equal(
          await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
          0,
          'All BrowserWindows should be closed while the app remains Dock resident'
        );
      } finally {
        proc.off('exit', onExit);
      }
    }
    async function reopenFromDockActivate() {
      const nextWindow = desktop.waitForEvent('window', { timeout: 15_000 });
      await desktop.evaluate(({ app }) => { app.emit('activate', {}, false); });
      const reopened = await nextWindow;
      await verifyWindowReady(reopened);
      assert.equal(
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        1,
        'Dock activate should reopen exactly one main window'
      );
      return reopened;
    }
    async function quitApp() {
      const proc = desktop.process();
      const closed = once(proc, 'exit', { signal: AbortSignal.timeout(15_000) });
      await desktop.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
      const [code] = await closed;
      assert.equal(code, 0, 'Explicit app.quit() should exit the macOS app cleanly with code 0');
      desktop = undefined;
    }

    async function checkV031RecordedUi(page, locale) {
      const expectedReveal = locale === 'zh-CN' ? '在访达中显示' : 'Show in Finder';
      const expectedDiagTitle = locale === 'zh-CN' ? '回复因达到单轮长度上限而暂停' : 'Response paused at output length limit';
      const pane = page.getByTestId('session-pane-' + RECORDED_SESSION_ID);
      if (!await pane.isVisible()) {
        const thread = page.getByRole('group', { name: RECORDED_SESSION_TITLE, exact: true });
        await thread.waitFor({ timeout: 10_000 });
        await thread.focus();
        await thread.press('Enter');
        await pane.waitFor({ timeout: 10_000 });
      }
      const fileLink = pane.locator('a.md-link-file').first();
      await fileLink.waitFor({ timeout: 10_000 });
      assert.equal((await fileLink.locator('.md-link-label').textContent())?.trim(), 'mac 示意图.png');
      assert.doesNotMatch((await fileLink.textContent()) || '', /file:\/\/\//i);
      assert.ok((await fileLink.getAttribute('title') || '').startsWith('/'), 'POSIX link tooltip should preserve leading /');

      const gallery = pane.getByTestId('md-media-gallery');
      await gallery.waitFor({ timeout: 10_000 });
      await page.waitForFunction(() => {
        const img = document.querySelector('[data-testid="md-media-gallery"] img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      });
      const revealBtn = gallery.getByTestId('md-media-reveal-btn').first();
      assert.equal(await revealBtn.getAttribute('title'), expectedReveal);

      if (locale === 'zh-CN') {
        await gallery.locator('button.message-image').first().click();
        const dialog = page.locator('dialog[open]');
        await dialog.waitFor({ timeout: 10_000 });
        assert.equal((await dialog.getByTestId('lightbox-reveal-btn').textContent())?.trim(), expectedReveal);
        assert.match((await dialog.getByTestId('lightbox-copy-image-btn').getAttribute('title')) || '', /⌘C/);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
      }

      const diagCard = pane.locator('[data-testid="turn-diagnostic-card"][data-diagnostic-code="max_tokens"]').first();
      await diagCard.waitFor({ timeout: 10_000 });
      assert.ok(((await diagCard.textContent()) || '').includes(expectedDiagTitle));
      assert.doesNotMatch((await diagCard.textContent()) || '', /\bCtrl\s*\+/i);
      assert.equal(await page.locator('[data-testid="inspector-tab-plan"]').count(), 0, 'Deprecated inspector-tab-plan must not render');
    }

    const first = await launch();
    const firstBootstrap = await first.evaluate(() => window.gravityDesktop.getBootstrap());
    assert.equal(
      firstBootstrap.layout.activeInspectorTab,
      'context',
      'Legacy layout.json activeInspectorTab:"plan" must fall back to "context" on launch'
    );
    assert.equal(await first.locator('[data-testid="inspector-tab-plan"]').count(), 0, 'Deprecated inspector-tab-plan must not render on launch');
    await checkView('视图');
    assert.match(await first.getByTestId('sidebar-new-session-btn').getAttribute('title'), /⌘N/);
    await checkV031RecordedUi(first, 'zh-CN');
    await fullscreen(true);
    await fullscreen(false);
    await clickMenu('gravity-size-in');
    await checkScale(first, 1.1);
    await clickMenu('gravity-size-out');
    await checkScale(first, 1);
    await desktop.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.focus();
      for (const type of ['keyDown', 'keyUp']) contents.sendInputEvent({ type, keyCode: '=', modifiers: ['meta'] });
    });
    await checkScale(first, 1.1);
    await first.getByTestId('account-menu-btn').click();
    await first.getByTestId('locale-switch-en').click();
    await first.waitForFunction(() => document.documentElement.lang === 'en-US');
    await checkView('View');
    await checkV031RecordedUi(first, 'en-US');
    await first.getByTestId('tab-close-' + RECORDED_SESSION_ID).click();

    // Issue #3.3 (D1): close last window -> stays resident in Dock -> Dock activate reopens working window.
    await closeLastWindowToDock(first);
    const reopened = await reopenFromDockActivate();
    await checkView('View');
    assert.match(await reopened.getByTestId('sidebar-new-session-btn').getAttribute('title'), /⌘N/);
    await checkScale(reopened, 1.1);
    // Verify native menu zoom rebinds cleanly to the newly reopened window's webContents.
    await clickMenu('gravity-size-in');
    await checkScale(reopened, 1.2);
    await clickMenu('gravity-size-out');
    await checkScale(reopened, 1.1);
    const reopenedBootstrap = await reopened.evaluate(() => window.gravityDesktop.getBootstrap());
    assert.equal(reopenedBootstrap.windowChrome, 'mac-inset');
    assert.equal(reopenedBootstrap.preferences.locale, 'en-US');
    assert.equal(reopenedBootstrap.preferences.uiScale, 1.1);
    // Repeated Dock activate while a window is already open must not spawn a duplicate window.
    await desktop.evaluate(({ app }) => { app.emit('activate', {}, true); });
    await delay(250);
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.deepEqual(pageErrors, [], 'Unexpected renderer page errors after Dock activate reopen: ' + pageErrors.join('; '));

    // Explicit Command+Q / app.quit() exits cleanly with code 0, then cold relaunch restores persisted preferences.
    await quitApp();

    const restored = await launch();
    await checkView('View');
    assert.match(await restored.getByTestId('sidebar-new-session-btn').getAttribute('title'), /⌘N/);
    await checkScale(restored, 1.1);
    await clickMenu('gravity-size-actual');
    await checkScale(restored, 1);
    // Invoke the production bridge. The real system Terminal opens only the disposable fake CLI above.
    let watchdog;
    let login;
    try {
      login = await Promise.race([
        restored.evaluate(() => window.gravityDesktop.launchOfficialLogin()),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('Visible login test timed out')), 40_000); }),
      ]);
    } finally { clearTimeout(watchdog); }
    assert.equal(login.launched, true);
    assert.deepEqual((await readFile(cli + '.seen', 'utf8')).trimEnd().split('\n'),
      ['acp', '--app-data-dir', path.join(profile, 'profiles', profileId), '--login']);
    // Also verify explicit app.quit() exits cleanly from the 0-window Dock-resident state.
    await closeLastWindowToDock(restored);
    await quitApp();
    assert.deepEqual(pageErrors, [], 'Unexpected renderer page errors during macOS native UI smoke: ' + pageErrors.join('; '));
    console.log('Passed native fullscreen, bilingual View menu, single-step persisted zoom, Dock-resident close + activate reopen, clean app.quit(), and visible Terminal login with a fake CLI.');
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    assert.equal(path.dirname(root), await realpath(tmpdir()));
    assert.match(path.basename(root), /^gravity-mac-ui-[a-zA-Z0-9]+$/);
    await rm(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
