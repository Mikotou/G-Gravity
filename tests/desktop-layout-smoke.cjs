const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');

async function checkActivitySeam(page) {
  const duration = await page.evaluate(async () => {
    // Measure the repeating flow after the active tab has finished changing from its idle color.
    await Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {})));
    const lines = document.getAnimations().filter(a => a.animationName === 'gv-activity-flow');
    if (lines.length !== 2) throw new Error('Expected a running tab and pane indicator, got ' + lines.length);
    lines.forEach(a => a.pause());
    return Number(lines[0].effect.getTiming().duration);
  });
  for (const [selector, isTab] of [['.tab[data-tab-state="streaming"]', true], ['.pane[data-pane-state="streaming"]', false]]) {
    const rect = await page.locator(selector).boundingBox();
    const clip = { x: Math.ceil(rect.x) + 12, y: isTab ? Math.floor(rect.y + rect.height) - 1 : Math.ceil(rect.y) + 1,
      width: Math.floor(rect.width) - 24, height: 1 };
    async function sample(t) {
      await page.evaluate(async time => {
        document.getAnimations().filter(a => a.animationName === 'gv-activity-flow').forEach(a => { a.currentTime = time; });
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      }, t);
      return (await page.screenshot({ clip })).toString('base64');
    }
    const images = [], phases = [];
    for (const t of [0, duration, duration - 16, duration + 16, duration / 2]) {
      images.push(await sample(t));
      phases.push(await page.locator(selector).evaluate((el, pseudo) => {
        const s = getComputedStyle(el, pseudo);
        return [s.backgroundPositionX, s.backgroundSize, s.backgroundColor, s.backgroundRepeat, s.animationName];
      }, isTab ? '::after' : '::before'));
    }
    const [same, seam, middle] = await page.evaluate(async frames => {
      const pixels = await Promise.all(frames.map(async b64 => {
        const blob = new Blob([Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        return ctx.getImageData(0, 0, canvas.width, 1).data;
      }));
      const delta = (a, b) => pixels[a].reduce((max, channel, i) => Math.max(max, Math.abs(channel - pixels[b][i])), 0);
      return [delta(0, 1), delta(2, 3), delta(0, 4)];
    }, images);
    assert.equal(same, 0, selector + ' loop boundary ' + JSON.stringify({ phases, seam, middle, rect, clip }));
    assert.ok(middle > 20 && seam < middle / 4, selector + ' channel deltas ' + [same, seam, middle]);
    console.log(selector + ' loop pixel differences (boundary, ±16ms, half cycle): ' + [same, seam, middle].join('/'));
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'gv-activity-flow').length), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gravity-renderer-qa-'));
  let browser;
  try {
    await build({ entryPoints: ['tests/desktop-layout.fixture.tsx'], outfile: path.join(dir, 'fixture.js'), bundle: true,
      tsconfig: 'tsconfig.renderer.json', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' });
    await writeFile(path.join(dir, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>#root{height:100vh;width:100%;display:flex}#root>.pane{height:100%;width:100%}</style><div id="root"></div><script src="fixture.js"></script>');
    browser = await chromium.launch({ channel: process.env.GRAVITY_BROWSER_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1240, height: 840 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:\/\//, route => route.abort());
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
    async function openFromWelcome() {
      await page.getByTestId('empty-pane-0').getByRole('heading').waitFor();
      assert.equal(await page.locator('[data-testid^="composer-input-"]').count(), 0);
      const welcome = page.getByTestId('empty-pane-0');
      const recentList = welcome.locator('.recent-item');
      assert.equal(await recentList.first().getAttribute('data-testid'), 'recent-thread-0-fixture-other');
      // Inspect the available actions before explicitly selecting the named second conversation with the keyboard.
      await welcome.getByRole('button').first().focus();
      await page.keyboard.press('Tab');
      const recent = page.getByTestId('recent-thread-0-layout-test');
      await recent.focus(); await recent.press('Enter');
    }
    await openFromWelcome();
    const pane = page.getByTestId('session-pane-layout-test');
    const weekly = pane.getByTestId('quota-weekly');
    assert.equal(await pane.getByTestId('quota-details').count(), 0);
    await weekly.getByText('81.2%').waitFor();
    await weekly.hover();
    const details = pane.getByTestId('quota-details');
    assert.equal(await details.getByTestId('quota-bucket').count(), 4);
    assert.equal(await details.locator('article[title="3p-5h"] header span').textContent(), '0%');
    await details.getByRole('button', { name: '刷新' }).click();
    await weekly.getByText('79.8%').waitFor();
    await page.getByTestId('app-topbar').hover();
    await details.waitFor({ state: 'detached' });
    // v0.2.0: 左侧独立额度触发器已移除，统一收拢至右下角「百分比 + 进度条」入口
    assert.equal(await pane.getByTestId('quota-trigger').count(), 0);
    await pane.getByTestId('quota-weekly-bar').waitFor();
    await weekly.focus(); await weekly.press('ArrowDown');
    await details.waitFor(); await page.keyboard.press('Escape');
    await details.waitFor({ state: 'detached' });
    assert.ok(await weekly.evaluate(node => node === document.activeElement));
    const thought = page.getByTestId('thought-content-flow');
    const measure = () => thought.locator('p').evaluateAll(nodes => nodes.map((p, i) => {
      const s = getComputedStyle(p), rect = p.getBoundingClientRect();
      return [s.fontFamily, s.fontSize, s.fontStyle, s.fontWeight, s.lineHeight, s.color,
        Math.round(rect.height), i ? Math.round(rect.top - nodes[i - 1].getBoundingClientRect().bottom) : 0];
    }));
    await page.waitForFunction(() => document.querySelector('[data-testid="thought-content-flow"]')?.textContent.includes('第三段已完成。'));
    const during = await measure();
    await page.evaluate(() => window.fixture.draw(false));
    await page.getByTestId('thinking-block-flow').locator('.cc-thinking-title').filter({ hasText: /^Thinking$/ }).waitFor();
    const settled = await measure();
    assert.equal(settled.length, 3);
    assert.deepEqual(during, settled);
    assert.ok(settled.every(p => p[7] >= 0 && p[7] < 12));
    for (const [width, height] of [[1240, 840], [620, 680], [330, 540]]) {
      await page.setViewportSize({ width, height });
      for (const alt of ['portrait', 'landscape', 'tiny']) {
        const img = page.getByRole('img', { name: alt, exact: true });
        await img.scrollIntoViewIfNeeded();
        const size = await img.evaluate(i => ({ w: i.clientWidth, h: i.clientHeight, nw: i.naturalWidth, nh: i.naturalHeight }));
        assert.ok(size.h > 0 && size.h <= height * .25 + 2 && size.w <= Math.min(width * .66 + 2, 422), JSON.stringify(size));
        assert.ok(Math.abs(size.w / size.h - size.nw / size.nh) < .12, JSON.stringify(size));
        if (alt === 'tiny') assert.ok(size.w <= 17 && size.h <= 10);
      }
    }
    await page.setViewportSize({ width: 880, height: 760 });
    const dock = page.locator('.composer-dock');
    const oldHeight = (await dock.boundingBox()).height;
    const data = await page.getByRole('img', { name: 'landscape' }).getAttribute('src');
    await page.getByTestId('attach-file-input-layout-test').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from(data.split(',')[1], 'base64') });
    const preview = page.getByTestId('composer-image-tray').getByRole('img', { name: 'preview.png', exact: true });
    await preview.waitFor();
    assert.ok((await preview.boundingBox()).height > 95);
    assert.ok((await dock.boundingBox()).height > oldHeight + 90);
    await preview.click(); await page.locator('dialog[open] img').waitFor(); await page.keyboard.press('Escape');
    await page.getByTestId('composer-image-tray').locator('.composer-image-remove').click();
    const composer = page.getByTestId('composer-input-layout-test');
    await composer.press('ArrowUp');
    const editor = page.getByRole('textbox', { name: '编辑原消息' });
    await editor.press('Control+a'); await editor.pressSequentially('重发的上一条消息');
    await editor.press('Control+Enter');
    assert.equal(await page.evaluate(() => window.fixture.revised), '重发的上一条消息');
    async function annotate(selector, comment) {
      const source = page.locator('[data-testid="assistant-body-reply"] ' + selector);
      await source.scrollIntoViewIfNeeded();
      await source.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      });
      await page.getByTestId('selection-annotate-btn').click();
      await page.getByTestId('selection-notation-input').pressSequentially(comment);
      await page.getByTestId('selection-notation-save-btn').click();
    }
    await annotate('strong', '意见一'); await annotate('p:nth-of-type(2)', '意见二');
    assert.equal(await page.evaluate(() => CSS.highlights.get('gravity-annotations')?.size), 2);
    await page.reload();
    await openFromWelcome();
    await page.waitForFunction(() => CSS.highlights.get('gravity-annotations')?.size === 2);
    await page.evaluate(() => { window.fixture.long = true; window.fixture.draw(false); });
    await pane.getByTestId('attach-file-input-layout-test').setInputFiles({
      name: 'geometry.png', mimeType: 'image/png', buffer: Buffer.from(data.split(',')[1], 'base64')
    });
    await pane.getByTestId('composer-image-tray').waitFor();
    const reads = await page.evaluate(() => window.fixture.quotaReads);
    for (const [mode, width, height] of [['single', 950, 800], ['single', 365, 700], ['split-2', 1160, 840]]) {
      await page.setViewportSize({ width, height });
      await page.getByTestId('layout-btn-' + mode).press('Enter');
      const stream = pane.locator('.stream');
      await stream.hover({ position: { x: 12, y: 12 } });
      await page.mouse.wheel(0, -5000);
      const arrow = pane.getByTestId('jump-latest-layout-test');
      await arrow.waitFor();
      const viewport = await pane.locator('.stream-viewport').boundingBox();
      const composerBox = await pane.locator('.composer-dock').boundingBox();
      const bounds = await arrow.boundingBox();
      const offset = Math.abs(bounds.x + bounds.width / 2 - viewport.x - viewport.width / 2);
      assert.ok(offset <= 1, mode + ' horizontal offset ' + offset);
      assert.ok(bounds.y + bounds.height <= composerBox.y - 4, mode + ' arrow overlapped the composer');
      const footer = await pane.locator('.quota-footer').boundingBox();
      const badge = await weekly.boundingBox();
      assert.ok(badge.x + badge.width <= footer.x + footer.width && badge.x + badge.width >= footer.x + footer.width - 8);
      assert.equal(await pane.getByTestId('quota-trigger').count(), 0);
      console.log(mode + ' ' + width + '×' + height + ' jump offset ' + offset + 'px, gap ' + Math.round(composerBox.y - bounds.y - bounds.height) + 'px');
    }
    assert.equal(await page.evaluate(() => window.fixture.quotaReads), reads);
    await page.getByTestId('layout-btn-single').press('Enter');
    await pane.getByTestId('composer-image-tray').locator('.composer-image-remove').press('Enter');
    await page.getByRole('button', { name: '发送 2 条批注' }).press('Enter');
    await page.waitForFunction(() => window.fixture.calls.length === 1);
    await pane.getByTestId('cancel-prompt-btn-layout-test').waitFor();
    assert.equal(await pane.getByTestId('turn-notation-pins').count(), 0);
    assert.equal(await pane.getByTestId('composer-annotations-layout-test').count(), 0);
    assert.equal(await page.evaluate(() => CSS.highlights.has('gravity-annotations')), false);
    const prompt = await page.evaluate(() => JSON.stringify(window.fixture.calls[0].annotations));
    assert.equal(await page.evaluate(() => window.fixture.calls[0].text), '');
    await checkActivitySeam(page);
    await annotate('strong', '留给下一轮');
    await page.evaluate(() => window.fixture.settle());
    await pane.getByRole('button', { name: '发送 1 条批注' }).waitFor();
    assert.ok((await pane.getByTestId('turn-notation-pins').textContent()).includes('留给下一轮'));
    await pane.locator('.stream').hover({ position: { x: 12, y: 12 } });
    await page.mouse.wheel(0, -5000);
    const latest = pane.getByTestId('jump-latest-layout-test');
    await latest.press('Enter');
    await page.waitForFunction(() => {
      const stream = document.querySelector('[data-testid="session-pane-layout-test"] .stream');
      return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 2;
    });
    await latest.waitFor({ state: 'detached' });
    for (const value of ['关键原文', '意见一', '第二段可以另写批注。', '意见二']) assert.ok(prompt.includes(value));
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?keyboard-workspace');
    const welcome = page.getByTestId('empty-pane-0');
    await welcome.getByRole('heading').waitFor();
    // v0.1.5：一级页签 5 个（Diff 与 Files 合并为 Changes 下的二级视图），二级视图为 2 个页签。
    const inspectorHead = page.getByTestId('right-inspector').locator('.inspector-head');
    assert.equal(await inspectorHead.getByRole('tab').count(), 5);
    assert.equal(await inspectorHead.getByRole('button').count(), 0);
    assert.equal(await page.getByTestId('right-inspector').locator('.inspector-subnav').getByRole('tab').count(), 2);
    await page.getByTestId('toggle-right-inspector-btn').press('Enter');
    await page.getByTestId('toggle-right-inspector-btn').press('Enter');
    assert.equal(await page.locator('[data-testid^="composer-input-"]').count(), 0);
    await page.keyboard.press('Control+,');
    await page.getByTestId('settings-tab-about').press('Enter');
    await page.getByTestId('about-gravity-modal').waitFor();
    await page.keyboard.press('Escape');
    await welcome.getByRole('heading').waitFor();
    await page.getByTestId('sidebar-new-session-btn').press('Enter');
    async function type(field, text) {
      await field.press('Control+a'); await field.press('Backspace'); await field.pressSequentially(text);
      assert.equal(await field.inputValue(), text);
    }
    await type(page.getByTestId('new-session-cwd-input'), 'C:\\Gravity-Keyboard-QA');
    await type(page.getByTestId('new-session-title-input'), 'Keyboard QA');
    await page.getByTestId('confirm-create-session-btn').press('Enter');
    const entry = page.locator('[data-testid^="composer-input-"]').first();
    await entry.waitFor();
    const id = (await entry.getAttribute('data-testid')).slice('composer-input-'.length);
    await type(entry, 'First keyboard message'); await entry.press('Enter');
    await page.waitForFunction(async sid => (await window.fixtureBridge.getSessionMessages(sid)).some(m => m.role === 'assistant' && !m.isStreaming), id);
    await entry.press('ArrowUp');
    const revision = page.getByRole('textbox', { name: '编辑原消息' });
    await type(revision, 'Edited keyboard message'); await revision.press('Control+Enter');
    await page.waitForFunction(sid => {
      const input = document.querySelector('[data-testid^="composer-input-"]');
      return input && input.getAttribute('data-testid') !== 'composer-input-' + sid;
    }, id);
    const newId = (await entry.getAttribute('data-testid')).slice('composer-input-'.length);
    const saved = await page.evaluate(async ([a, b]) => Promise.all([a, b].map(async sid => (await window.fixtureBridge.getSessionMessages(sid))
      .filter(m => m.role === 'user').map(m => m.content))), [id, newId]);
    assert.deepEqual(saved, [['First keyboard message'], ['Edited keyboard message']]);
    await page.getByTestId('layout-btn-split-2').press('Enter');
    const left = page.getByTestId('workspace-slot-0'), right = page.getByTestId('workspace-slot-1');
    await left.getByTestId('session-pane-' + newId).waitFor();
    await page.getByTestId('sidebar-session-' + id).dragTo(right);
    await right.getByTestId('session-pane-' + id).waitFor();
    await page.getByTestId('tab-item-' + newId).dragTo(right);
    await right.getByTestId('session-pane-' + newId).waitFor();
    await left.getByTestId('session-pane-' + id).waitFor();
    assert.ok(await page.getByTestId('tab-item-' + id).isVisible());
    assert.ok(await page.getByTestId('tab-item-' + newId).isVisible());
    await type(left.getByTestId('composer-input-' + id), 'My unsent draft survives a move');
    const historyId = 'ag-history:conv-cli-002';
    await page.getByTestId('history-item-' + historyId).dragTo(left);
    await left.getByTestId('readonly-history-view-' + historyId).waitFor();
    await right.getByTestId('session-pane-' + newId).waitFor();
    assert.ok(await page.getByTestId('tab-item-' + id).isVisible());
    await page.getByTestId('tab-close-' + historyId).press('Enter');
    await left.getByTestId('session-pane-' + id).waitFor();
    assert.equal(await left.getByTestId('composer-input-' + id).inputValue(), 'My unsent draft survives a move');
    console.log('Imported read-only history: sidebar drag into a pane, displaced tab retained, close restored the chat.');
    console.log('Local keyboard workspace: new chat from welcome, edit and resend, native sidebar drag into right pane, then tab drag to swap panes.');
    assert.deepEqual(errors, []);
    console.log('Chromium: stable thought typography and paragraph gaps ' + settled.map(p => p[7]).join('/') +
      'px; 3 viewport sizes, both message roles, image tray and zoom, previous-message editing, highlights, reload and combined send passed.');
  } finally { await browser?.close(); await rm(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
