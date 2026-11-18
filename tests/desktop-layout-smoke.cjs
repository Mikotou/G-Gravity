const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');

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
      const recent = page.getByTestId('recent-thread-0-layout-test');
      await recent.focus(); await recent.press('Enter');
    }
    await openFromWelcome();
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
    await page.getByRole('button', { name: '发送 2 条批注' }).press('Enter');
    await page.waitForFunction(() => window.fixture.calls.length === 1);
    const prompt = await page.evaluate(() => window.fixture.calls[0].text);
    for (const value of ['关键原文', '意见一', '第二段可以另写批注。', '意见二']) assert.ok(prompt.includes(value));
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?keyboard-workspace');
    const welcome = page.getByTestId('empty-pane-0');
    await welcome.getByRole('heading').waitFor();
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
    console.log('Local keyboard workspace: welcome, settings, explicit new conversation, typed first message, edited and resent into a new branch.');
    assert.deepEqual(errors, []);
    console.log('Chromium: stable thought typography and paragraph gaps ' + settled.map(p => p[7]).join('/') +
      'px; 3 viewport sizes, both message roles, image tray and zoom, previous-message editing, highlights, reload and combined send passed.');
  } finally { await browser?.close(); await rm(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
