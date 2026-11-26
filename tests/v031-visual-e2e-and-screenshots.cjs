'use strict';

/**
 * G-Gravity v0.3.1 — Frontend Visual E2E & Screenshot Verification Suite.
 *
 * Fully offline (zero network calls): bundles a real React TSX harness mounting `<App />`
 * via `esbuild` + `tsconfig.renderer.json`, launches Chromium (`msedge` or bundled `chromium`)
 * via `playwright-core`, and asserts:
 *   1. Screenshot 1 & Screenshot 2 regression scenario (bulleted `file:///` links, `.svg`/`.png`/`.ico`
 *      prose backticks, panoramic showcase PNG + 8 square icon PNG/SVG tiles, `.ico` & directory tray)
 *      across Claude Code Dark, Claude Code Light, and `split-2` narrow pane;
 *   2. Pause & Error Diagnostic Cards (`max_tokens`, `rate_limited_429` with live countdown,
 *      `acp_disconnected` with Reconnect button, `waiting_question`) in Dark & Light themes;
 *   3. Zero `pageerror`, zero horizontal overflow, zero `file:///` text leaks in visible links,
 *      zero `.svg`/`.png` broken muted placeholders, non-overlapping bounding boxes between
 *      `.md-media-gallery` and `.md-files-tray` (`tray.top >= gallery.bottom`), and valid image
 *      aspect ratios;
 *   4. Saves 5 high-DPI screenshots under `tests/screenshots/v031-qa/`.
 */

const assert = require('node:assert/strict');
const { cp, mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');

const SCREENSHOT_DIR = path.resolve('tests/screenshots/v031-qa');
const VIEWPORT = { width: 1440, height: 900 };

const VISUAL_FIXTURE_TSX = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildDiagnosticBanner,
  type ChatMessageItem,
  type InspectLocalTargetsInput,
  type InspectLocalTargetsResult,
  type InspectedLocalTarget,
  type ManagedSessionSummary,
  type ThemePreference,
  type WorkspaceSplitMode,
} from '@shared';
import { App } from './src/renderer/App';
import { createFallbackDesktopBridge } from './src/renderer/services/desktop-bridge';
import { applyThemePreference } from './src/renderer/styles/theme';
import './src/renderer/styles/global.css';
import './src/renderer/styles/design-system.css';
import './src/renderer/styles/claude-studio.css';

function drawShowcasePng(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 680;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 1600, 680);
  grad.addColorStop(0, '#1d1916');
  grad.addColorStop(1, '#2f251e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1600, 680);

  const accents = ['#d97757', '#38bdf8', '#4ade80', '#f59e0b'];
  accents.forEach((color, idx) => {
    const x = 90 + idx * 365;
    ctx.fillStyle = '#25201c';
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.roundRect(x, 120, 310, 440, 36);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x + 155, 290, 92, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.stroke();

    ctx.fillStyle = '#f2ece4';
    ctx.font = 'bold 54px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('>_', x + 155, 310);

    ctx.fillStyle = '#b8afa4';
    ctx.font = '600 26px sans-serif';
    ctx.fillText('Gravity #' + (idx + 1), x + 155, 470);
  });

  ctx.fillStyle = '#f2ece4';
  ctx.font = '700 38px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('G-Gravity Icon Studio · Panoramic Showcase (1600×680)', 90, 74);
  return canvas.toDataURL('image/png');
}

function drawSquareIconPng(label: string, bg: string, accent: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(24, 24, 464, 464, 108);
  ctx.fill();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 22;
  ctx.beginPath();
  ctx.arc(256, 236, 126, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.font = 'bold 116px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('>_', 256, 274);

  ctx.fillStyle = '#f2ece4';
  ctx.font = '600 32px sans-serif';
  ctx.fillText(label, 256, 434);
  return canvas.toDataURL('image/png');
}

function makeVectorSvgDataUrl(label: string, bg: string, accent: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">' +
    '<rect x="24" y="24" width="464" height="464" rx="108" fill="' + bg + '"/>' +
    '<circle cx="256" cy="236" r="126" fill="none" stroke="' + accent + '" stroke-width="22"/>' +
    '<text x="256" y="274" text-anchor="middle" font-family="monospace" font-weight="700" font-size="112" fill="' + accent + '">&gt;_</text>' +
    '<text x="256" y="434" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="30" fill="#f2ece4">' + label + '</text>' +
    '</svg>';
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

async function mountVisualQaApp() {
  const fallback = createFallbackDesktopBridge();
  const baseBoot = await fallback.getBootstrap();

  const showcaseDataUrl = drawShowcasePng();
  const iconSpecs = [
    { name: '01-gravity-lens.png', ext: 'png', mime: 'image/png', dataUrl: drawSquareIconPng('Lens', '#1d1916', '#d97757'), size: 64210 },
    { name: '01-gravity-lens.svg', ext: 'svg', mime: 'image/svg+xml', dataUrl: makeVectorSvgDataUrl('Lens SVG', '#211b18', '#e08b6d'), size: 4820 },
    { name: '01-gravity-lens-256.png', ext: 'png', mime: 'image/png', dataUrl: drawSquareIconPng('Lens 256', '#24201c', '#d97757'), size: 22410 },
    { name: '02-gravity-orbit.png', ext: 'png', mime: 'image/png', dataUrl: drawSquareIconPng('Orbit', '#1b1c1f', '#0a84ff'), size: 61880 },
    { name: '02-gravity-orbit.svg', ext: 'svg', mime: 'image/svg+xml', dataUrl: makeVectorSvgDataUrl('Orbit SVG', '#141923', '#38bdf8'), size: 4610 },
    { name: '03-gravity-pulse.png', ext: 'png', mime: 'image/png', dataUrl: drawSquareIconPng('Pulse', '#24071b', '#e95420'), size: 58920 },
    { name: '04-gravity-prism.png', ext: 'png', mime: 'image/png', dataUrl: drawSquareIconPng('Prism', '#002b36', '#2aa198'), size: 60440 },
    { name: '05-gravity-core.png', ext: 'png', mime: 'image/png', dataUrl: drawSquareIconPng('Core', '#1e1b18', '#4ade80'), size: 59120 },
  ];

  const inspectedCatalog: Record<string, InspectedLocalTarget> = {
    'c:/workspace/demoapp/icon-studio/gravity-icon-showcase.png': {
      rawTarget: 'file:///C:/Workspace/DemoApp/icon-studio/gravity-icon-showcase.png',
      kind: 'image',
      exists: true,
      resolvedPath: 'C:\\\\Workspace\\\\DemoApp\\\\icon-studio\\\\gravity-icon-showcase.png',
      fileUrl: 'file:///C:/Workspace/DemoApp/icon-studio/gravity-icon-showcase.png',
      fileName: 'gravity-icon-showcase.png',
      parentHint: 'icon-studio',
      ext: 'png',
      mimeType: 'image/png',
      sizeBytes: 348160,
      width: 1600,
      height: 680,
      aspectRatio: 1600 / 680,
      previewDataUrl: showcaseDataUrl,
    },
    'c:/workspace/demoapp/icon-studio/01-gravity-lens.ico': {
      rawTarget: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico',
      kind: 'file',
      exists: true,
      resolvedPath: 'C:\\\\Workspace\\\\DemoApp\\\\icon-studio\\\\01-gravity-lens.ico',
      fileUrl: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico',
      fileName: '01-gravity-lens.ico',
      parentHint: 'icon-studio',
      ext: 'ico',
      mimeType: 'image/x-icon',
      sizeBytes: 42816,
    },
    'c:/workspace/demoapp/icon-studio': {
      rawTarget: 'C:/Workspace/DemoApp/icon-studio',
      kind: 'directory',
      exists: true,
      resolvedPath: 'C:\\\\Workspace\\\\DemoApp\\\\icon-studio',
      fileUrl: 'file:///C:/Workspace/DemoApp/icon-studio',
      fileName: 'icon-studio',
      parentHint: 'C:\\\\Workspace\\\\DemoApp',
    },
    'f:/proj/src/core-service.ts': {
      rawTarget: 'file:///F:/proj/src/core-service.ts#L10-L20',
      kind: 'file',
      exists: true,
      resolvedPath: 'F:\\\\proj\\\\src\\\\core-service.ts',
      fileUrl: 'file:///F:/proj/src/core-service.ts',
      fileName: 'core-service.ts',
      parentHint: 'src',
      ext: 'ts',
      mimeType: 'text/typescript',
      sizeBytes: 18420,
    },
  };

  for (const ic of iconSpecs) {
    inspectedCatalog['c:/workspace/demoapp/icon-studio/' + ic.name] = {
      rawTarget: 'file:///C:/Workspace/DemoApp/icon-studio/' + ic.name,
      kind: 'image',
      exists: true,
      resolvedPath: 'C:\\\\Workspace\\\\DemoApp\\\\icon-studio\\\\' + ic.name,
      fileUrl: 'file:///C:/Workspace/DemoApp/icon-studio/' + ic.name,
      fileName: ic.name,
      parentHint: 'icon-studio',
      ext: ic.ext,
      mimeType: ic.mime,
      sizeBytes: ic.size,
      width: 512,
      height: 512,
      aspectRatio: 1,
      previewDataUrl: ic.dataUrl,
    };
  }

  const nowIso = new Date().toISOString();
  const mixedSession: ManagedSessionSummary = {
    ...baseBoot.sessions[0],
    sessionId: 'sess-v031-mixed-media',
    cwd: 'C:\\\\Workspace\\\\DemoApp\\\\icon-studio',
    rawCwd: 'C:\\\\Workspace\\\\DemoApp\\\\icon-studio',
    title: 'Design｜图标工作台与图文混排验收',
    status: 'idle',
    readOnly: false,
    updatedAt: nowIso,
  };

  const diagSession: ManagedSessionSummary = {
    ...baseBoot.sessions[1],
    sessionId: 'sess-v031-diagnostics',
    cwd: 'C:\\\\Workspace\\\\DemoApp\\\\workspace',
    rawCwd: 'C:\\\\Workspace\\\\DemoApp\\\\workspace',
    title: 'QA｜暂停截断与错误恢复诊断卡验收',
    status: 'error',
    readOnly: false,
    diagnostic: buildDiagnosticBanner('acp_disconnected', { exitCode: 137 }),
    updatedAt: nowIso,
  };

  const mixedMarkdown = [
    '### 图标资产导出与目录总览',
    '',
    '已为你生成全套 \`.svg\`、\`.png\`、\`.ico\` 与 \`-mac.png\` 图标格式，并输出至目录 \`C:/Workspace/DemoApp/icon-studio\`：',
    '',
    '- 主视觉总览图：[gravity-icon-showcase.png](file:///C:/Workspace/DemoApp/icon-studio/gravity-icon-showcase.png)（宽屏 1600×680）',
    ...iconSpecs.map((ic) => '- [' + ic.name + '](file:///C:/Workspace/DemoApp/icon-studio/' + ic.name + ') — 原创 Gravity 图标变体'),
    '- Windows 打包图标：[01-gravity-lens.ico](file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico)',
    '- 关联核心代码：[core-service.ts](file:///F:/proj/src/core-service.ts#L10-L20)',
    '',
    '所有图片与非图片文件/目录已分别收纳至底部画廊与文件托盘，避免混格错位。',
  ].join('\\n');

  const messagesMap: Record<string, ChatMessageItem[]> = {
    'sess-v031-mixed-media': [
      {
        id: 'u-mixed-1',
        sessionId: 'sess-v031-mixed-media',
        role: 'user',
        content: '请帮我整理 icon-studio 的全部图标资产，导出 .svg/.png/.ico 并生成总览预览。',
        createdAt: nowIso,
      },
      {
        id: 'a-mixed-1',
        sessionId: 'sess-v031-mixed-media',
        role: 'assistant',
        content: mixedMarkdown,
        createdAt: nowIso,
        completedAt: nowIso,
      },
    ],
    'sess-v031-diagnostics': [
      {
        id: 'u-diag-1',
        sessionId: 'sess-v031-diagnostics',
        role: 'user',
        content: '请输出完整架构评审报告并执行回归检查。',
        createdAt: nowIso,
      },
      {
        id: 'a-diag-waiting-q',
        sessionId: 'sess-v031-diagnostics',
        role: 'assistant',
        content: '等待确认下一步目标环境：',
        turnStop: buildDiagnosticBanner('waiting_question'),
        createdAt: nowIso,
        completedAt: nowIso,
      },
      {
        id: 'a-diag-max-tokens',
        sessionId: 'sess-v031-diagnostics',
        role: 'assistant',
        content: '已完成前 3 章架构评审分析，正在继续撰写第 4 章……',
        turnStop: buildDiagnosticBanner('max_tokens'),
        createdAt: nowIso,
        completedAt: nowIso,
      },
      {
        id: 'a-diag-429',
        sessionId: 'sess-v031-diagnostics',
        role: 'assistant',
        content: '触发频率限制前的阶段性校验已完成。',
        turnStop: buildDiagnosticBanner('rate_limited_429', {
          cooldownUntil: new Date(Date.now() + 58_000).toISOString(),
        }),
        createdAt: nowIso,
        completedAt: nowIso,
      },
    ],
  };

  let currentPreferences = {
    ...baseBoot.preferences,
    locale: 'zh-CN' as const,
    theme: 'claude-code-dark' as ThemePreference,
  };
  let currentLayout = {
    ...baseBoot.layout,
    openTabSessionIds: ['sess-v031-mixed-media', 'sess-v031-diagnostics'],
    activePrimarySessionId: 'sess-v031-mixed-media',
    splitSecondarySessionId: 'sess-v031-diagnostics',
    layoutMode: 'single' as WorkspaceSplitMode,
    leftSidebarCollapsed: false,
    rightInspectorCollapsed: true,
  };

  const bridge = {
    ...fallback,
    getBootstrap: async () => ({
      ...baseBoot,
      preferences: currentPreferences,
      sessions: [mixedSession, diagSession],
      layout: currentLayout,
      pendingApprovals: [],
    }),
    updatePreferences: async (patch: Partial<typeof currentPreferences>) => {
      currentPreferences = { ...currentPreferences, ...patch };
      applyThemePreference(currentPreferences.theme, currentPreferences.customTheme);
      return currentPreferences;
    },
    saveWorkspaceLayout: async (patch: Partial<typeof currentLayout>) => {
      currentLayout = { ...currentLayout, ...patch };
      return currentLayout;
    },
    listSessions: async () => [mixedSession, diagSession],
    getSessionMessagePage: async (id: string) => ({
      earlierCount: 0,
      earlierUserCount: 0,
      earlierVisibleCount: 0,
      precedingOriginId: null,
      messages: messagesMap[id] || [],
    }),
    inspectLocalTargets: async (input: InspectLocalTargetsInput): Promise<InspectLocalTargetsResult> => {
      const items: Record<string, InspectedLocalTarget> = {};
      for (const raw of input.targets) {
        const key = raw
          .trim()
          .replace(/^file:\\/\\/\\/?/i, '')
          .replace(/#L?\\d+(?:-L?\\d+)?$/i, '')
          .replace(/\\\\/g, '/')
          .replace(/\\/+$/, '')
          .toLowerCase();
        const hit =
          inspectedCatalog[key] ||
          Object.values(inspectedCatalog).find((item) => item.fileName.toLowerCase() === key.split('/').at(-1));
        items[raw] = hit
          ? { ...hit, rawTarget: raw }
          : { rawTarget: raw, kind: 'missing', exists: false, fileName: key.split('/').at(-1) || raw };
      }
      return { items };
    },
  };

  window.gravityDesktop = bridge;
  Object.assign(window, {
    __v031Qa: {
      setTheme(theme: ThemePreference) {
        currentPreferences = { ...currentPreferences, theme };
        applyThemePreference(theme);
      },
    },
  });

  const root = createRoot(document.getElementById('root')!);
  root.render(<App />);
}

void mountVisualQaApp();
`;

async function launchBrowser() {
  const preferred = process.env.GRAVITY_BROWSER_CHANNEL || 'msedge';
  try {
    return await chromium.launch({ channel: preferred, headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const streams = Array.from(document.querySelectorAll('.stream')).map((el) => ({
      scrollWidth: Math.round(el.scrollWidth),
      clientWidth: Math.round(el.clientWidth),
    }));
    return {
      docOverflow: Math.round(doc.scrollWidth - doc.clientWidth),
      streams,
    };
  });
  assert.ok(report.docOverflow <= 2, `[${label}] Document horizontal overflow detected: ${JSON.stringify(report)}`);
  for (const s of report.streams) {
    assert.ok(s.scrollWidth <= s.clientWidth + 2, `[${label}] .stream horizontal overflow detected: ${JSON.stringify(s)}`);
  }
}

async function assertMixedMediaPane(page, label) {
  const pane = page.getByTestId('session-pane-sess-v031-mixed-media');
  await pane.waitFor();
  const previews = pane.getByTestId('message-previews');
  await previews.waitFor();
  const gallery = pane.getByTestId('md-media-gallery');
  await gallery.waitFor();
  const filesTray = pane.getByTestId('md-files-tray');
  await filesTray.waitFor();

  // Wait for hero class & images to decode completely
  await page.waitForFunction(() => {
    const g = document.querySelector('[data-testid="session-pane-sess-v031-mixed-media"] [data-testid="md-media-gallery"]');
    if (!g) return false;
    const imgs = Array.from(g.querySelectorAll('img'));
    return Boolean(g.querySelector('.md-media-card.is-hero')) && imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  });

  // 1) Zero file:/// text leaks in visible links
  const leakedLinks = await pane.locator('a.md-link').evaluateAll((nodes) =>
    nodes
      .map((a) => (a.textContent || '').trim())
      .filter((txt) => /file:\/\/\//i.test(txt))
  );
  assert.deepEqual(leakedLinks, [], `[${label}] Found visible file:/// URI leaks in links: ${JSON.stringify(leakedLinks)}`);

  // 2) Zero broken .svg/.png/.ico/-mac.png muted placeholders inside previews
  const brokenMuted = await previews.locator('span.muted').evaluateAll((nodes) =>
    nodes
      .map((el) => (el.textContent || '').trim())
      .filter((txt) => /^\.(?:svg|png|ico)$/i.test(txt) || /^-mac\.png$/i.test(txt))
  );
  assert.deepEqual(brokenMuted, [], `[${label}] Found broken muted extension placeholders: ${JSON.stringify(brokenMuted)}`);

  // 3) Strict separation between Zone A (gallery) and Zone B (files tray)
  assert.equal(await gallery.locator('.message-file').count(), 0, `[${label}] .message-file leaked into .md-media-gallery`);
  assert.equal(await filesTray.locator('img').count(), 0, `[${label}] <img> leaked into .md-files-tray`);
  assert.ok((await filesTray.locator('.message-file').count()) >= 2, `[${label}] Expected .ico and folder in .md-files-tray`);

  // Scroll previews into view so bounding boxes are measured reliably
  await previews.scrollIntoViewIfNeeded();
  const galleryBox = await gallery.boundingBox();
  const trayBox = await filesTray.boundingBox();
  assert.ok(galleryBox && galleryBox.width > 100 && galleryBox.height > 80, `[${label}] Invalid gallery box: ${JSON.stringify(galleryBox)}`);
  assert.ok(trayBox && trayBox.width > 100 && trayBox.height > 24, `[${label}] Invalid tray box: ${JSON.stringify(trayBox)}`);
  assert.ok(
    trayBox.y >= galleryBox.y + galleryBox.height - 1,
    `[${label}] .md-files-tray overlaps .md-media-gallery: gallery=${JSON.stringify(galleryBox)} tray=${JSON.stringify(trayBox)}`
  );

  // 4) Valid aspect ratios on all rendered images in gallery
  const imageMetrics = await gallery.locator('img').evaluateAll((imgs) =>
    imgs.map((img) => ({
      alt: img.alt,
      w: img.clientWidth,
      h: img.clientHeight,
      nw: img.naturalWidth,
      nh: img.naturalHeight,
    }))
  );
  assert.ok(imageMetrics.length > 0 && imageMetrics.length <= 6, `[${label}] Expected 1..6 collapsed gallery images, got ${imageMetrics.length}`);
  for (const m of imageMetrics) {
    assert.ok(m.w > 0 && m.h > 0 && m.nw > 0 && m.nh > 0, `[${label}] Zero-sized image: ${JSON.stringify(m)}`);
    const renderedRatio = m.w / m.h;
    const naturalRatio = m.nw / m.nh;
    assert.ok(
      Math.abs(renderedRatio - naturalRatio) < 0.15,
      `[${label}] Distorted aspect ratio for ${m.alt}: rendered=${renderedRatio.toFixed(2)} natural=${naturalRatio.toFixed(2)}`
    );
  }

  // 5) Expand button present for >6 images + guard against CSS Grid vertical row-void regressions
  await gallery.getByTestId('md-media-expand-btn').waitFor();
  const rowGaps = await gallery.locator('[data-testid="md-media-card"]').evaluateAll((cards) => {
    const rects = cards.map((c) => c.getBoundingClientRect());
    const rows = [];
    for (const r of rects) {
      const hit = rows.find((row) => Math.abs(row.top - r.top) < 8);
      if (hit) {
        hit.bottom = Math.max(hit.bottom, r.bottom);
      } else {
        rows.push({ top: r.top, bottom: r.bottom });
      }
    }
    rows.sort((a, b) => a.top - b.top);
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push(Math.round(rows[i].top - rows[i - 1].bottom));
    return gaps;
  });
  for (const gap of rowGaps) {
    assert.ok(gap >= 0 && gap <= 28, `[${label}] Unexpected vertical void between .md-media-gallery rows: ${JSON.stringify(rowGaps)}`);
  }
  await assertNoHorizontalOverflow(page, label);
}

async function assertDiagnosticsPane(page, label) {
  const pane = page.getByTestId('session-pane-sess-v031-diagnostics');
  await pane.waitFor();

  for (const code of ['waiting_question', 'max_tokens']) {
    const card = pane.locator(`[data-testid="turn-diagnostic-card"][data-diagnostic-code="${code}"]`).first();
    await card.waitFor();
    const box = await card.boundingBox();
    assert.ok(box && box.width > 180 && box.height >= 26, `[${label}] Historical compact card ${code} has invalid box: ${JSON.stringify(box)}`);
  }

  for (const code of ['rate_limited_429', 'acp_disconnected']) {
    const card = pane.locator(`[data-testid="turn-diagnostic-card"][data-diagnostic-code="${code}"]`).first();
    await card.waitFor();
    const box = await card.boundingBox();
    assert.ok(box && box.width > 180 && box.height > 80, `[${label}] Active diagnostic card ${code} has invalid box: ${JSON.stringify(box)}`);
  }

  const card429 = pane.locator('[data-testid="turn-diagnostic-card"][data-diagnostic-code="rate_limited_429"]').first();
  await card429.getByTestId('diagnostic-cooldown-timer').waitFor();
  const retryDisabled = await card429.getByTestId('diagnostic-action-retry_turn').isDisabled();
  assert.equal(retryDisabled, true, `[${label}] rate_limited_429 retry button must be disabled during active cooldown`);

  const cardAcp = pane.locator('[data-testid="turn-diagnostic-card"][data-diagnostic-code="acp_disconnected"]').first();
  await cardAcp.getByTestId('diagnostic-action-reconnect_session').waitFor();

  await assertNoHorizontalOverflow(page, label);
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gravity-v031-visual-qa-'));
  let browser;
  try {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await build({
      stdin: {
        contents: VISUAL_FIXTURE_TSX,
        resolveDir: process.cwd(),
        loader: 'tsx',
        sourcefile: 'tests/v031-visual-fixture.tsx',
      },
      outfile: path.join(dir, 'fixture.js'),
      bundle: true,
      tsconfig: 'tsconfig.renderer.json',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'error',
    });

    const html = [
      '<!doctype html>',
      '<html><head><meta charset="utf-8">',
      '<link rel="stylesheet" href="fixture.css">',
      '<style>html,body,#root{margin:0;padding:0;width:100%;height:100vh;overflow:hidden;}</style>',
      '</head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    ].join('');
    await writeFile(path.join(dir, 'index.html'), html, 'utf8');
    await cp(path.resolve('public/icons'), path.join(dir, 'icons'), { recursive: true });

    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: VIEWPORT });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
    await page.route(/^https?:\/\//, (route) => route.abort());

    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
    await page.getByTestId('agy-app-root').waitFor();

    // 1. Mixed media — Claude Code Dark (single pane)
    await assertMixedMediaPane(page, '01-mixed-media-dark');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-mixed-media-dark.png') });
    console.log('[v0.3.1 Visual QA] Saved 01-mixed-media-dark.png');

    // 2. Mixed media — Claude Code Light (single pane)
    await page.evaluate(() => window.__v031Qa.setTheme('claude-code-light'));
    await page.waitForTimeout(150);
    await assertMixedMediaPane(page, '02-mixed-media-light');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-mixed-media-light.png') });
    console.log('[v0.3.1 Visual QA] Saved 02-mixed-media-light.png');

    // 3. Mixed media + Diagnostics — Split-2 narrow pane (Claude Code Dark)
    await page.evaluate(() => window.__v031Qa.setTheme('claude-code-dark'));
    await page.getByTestId('layout-btn-split-2').click();
    await page.waitForTimeout(200);
    await assertMixedMediaPane(page, '03-mixed-media-split2');
    await assertDiagnosticsPane(page, '03-mixed-media-split2-right');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-mixed-media-split2.png') });
    console.log('[v0.3.1 Visual QA] Saved 03-mixed-media-split2.png');

    // 4. Pause & Error Diagnostic Cards — Claude Code Dark (single pane)
    await page.getByTestId('layout-btn-single').click();
    await page.getByTestId('tab-item-sess-v031-diagnostics').click();
    await page.waitForTimeout(200);
    await assertDiagnosticsPane(page, '04-pause-error-cards-dark');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-pause-error-cards-dark.png') });
    console.log('[v0.3.1 Visual QA] Saved 04-pause-error-cards-dark.png');

    // 5. Pause & Error Diagnostic Cards — Claude Code Light (single pane)
    await page.evaluate(() => window.__v031Qa.setTheme('claude-code-light'));
    await page.waitForTimeout(150);
    await assertDiagnosticsPane(page, '05-pause-error-cards-light');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-pause-error-cards-light.png') });
    console.log('[v0.3.1 Visual QA] Saved 05-pause-error-cards-light.png');

    assert.deepEqual(pageErrors, [], `Unexpected pageerror(s): ${JSON.stringify(pageErrors)}`);
    console.log('[v0.3.1 Visual QA] All 5 visual E2E checks & screenshots passed with 0 pageerrors.');
  } finally {
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
