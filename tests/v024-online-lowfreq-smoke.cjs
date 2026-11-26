'use strict';

/**
 * G-Gravity v0.2.4 Wave 5B — Strictly Rate-Limited Low-Frequency Live Online Smoke.
 *
 * Launches the real packaged Windows Electron desktop app (`win-unpacked/Gravity.exe`)
 * connected to the real official `agy` CLI (`AGY_BINARY_PATH` or `PATH`) using an isolated temp
 * `--user-data-dir` and temp workspace under `os.tmpdir()`.
 *
 * MANDATORY HARD ANTI-BAN RATE-LIMITER:
 *   - MAX_CONCURRENT_SESSIONS = 3 (hard assertion before every createSession; NEVER 4)
 *   - MAX_REQUESTS_PER_60S = 5 (sliding 60s window; throws immediately if ever exceeded)
 *   - MIN_SPACING_MS = 13_000 (minimum 13s gap between any two live requests)
 *   - Zero retries on any 403 / 429 / rate-limit / captcha / verification alert — immediate abort!
 */

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

const execFileAsync = promisify(execFile);

const EXPECTED_VERSION = 'v' + require('../package.json').version;
const OFFICIAL_AGY_PATH = process.env.AGY_BINARY_PATH || 'agy';
const RISK_CONTROL_RE = /\b(?:403|429)\b|rate.?limit|too many requests|captcha|verification required|RESOURCE_EXHAUSTED|PERMISSION_DENIED|限流|安全验证|人机验证|请求过于频繁/i;

/* ============================================================================
 * 1. Mandatory Hard OnlineRateLimiter (Non-Negotiable Anti-Ban Guard)
 * ========================================================================== */

class OnlineRateLimiter {
  static MAX_CONCURRENT_SESSIONS = 3;
  static MAX_REQUESTS_PER_60S = 5;
  static MIN_SPACING_MS = 13_000;
  static WINDOW_MS = 60_000;

  constructor() {
    this.timestamps = [];
    this.history = [];
    this.activeSessionIds = new Set();
  }

  assertSessionCapBeforeCreate() {
    const nextCount = this.activeSessionIds.size + 1;
    if (nextCount > OnlineRateLimiter.MAX_CONCURRENT_SESSIONS) {
      throw new Error(
        `[OnlineRateLimiter] BLOCKED: active sessions would reach ${nextCount}, exceeding hard cap ${OnlineRateLimiter.MAX_CONCURRENT_SESSIONS}`
      );
    }
  }

  registerSession(sessionId) {
    this.assertSessionCapBeforeCreate();
    this.activeSessionIds.add(sessionId);
    console.log(
      `[OnlineRateLimiter] Session opened: ${sessionId} | activeSessions=${this.activeSessionIds.size}/${OnlineRateLimiter.MAX_CONCURRENT_SESSIONS}`
    );
  }

  unregisterSession(sessionId) {
    this.activeSessionIds.delete(sessionId);
    console.log(
      `[OnlineRateLimiter] Session closed: ${sessionId} | activeSessions=${this.activeSessionIds.size}/${OnlineRateLimiter.MAX_CONCURRENT_SESSIONS}`
    );
  }

  prune(now = Date.now()) {
    const cutoff = now - OnlineRateLimiter.WINDOW_MS;
    this.timestamps = this.timestamps.filter(ts => ts > cutoff);
  }

  async acquireRequestSlot(label) {
    // Enforce >= 13,000ms spacing since previous live request
    if (this.timestamps.length > 0) {
      const lastTs = this.timestamps[this.timestamps.length - 1];
      const elapsed = Date.now() - lastTs;
      if (elapsed < OnlineRateLimiter.MIN_SPACING_MS) {
        const waitMs = OnlineRateLimiter.MIN_SPACING_MS - elapsed + 150;
        console.log(`[OnlineRateLimiter] Spacing guard: waiting ${waitMs}ms before ${label}...`);
        await delay(waitMs);
      }
    }

    const now = Date.now();
    this.prune(now);

    if (this.timestamps.length + 1 > OnlineRateLimiter.MAX_REQUESTS_PER_60S) {
      throw new Error(
        `[OnlineRateLimiter] HARD ABORT: sliding 60s request count would reach ${this.timestamps.length + 1} > ${OnlineRateLimiter.MAX_REQUESTS_PER_60S} for "${label}"`
      );
    }

    const spacingMs = this.timestamps.length > 0 ? now - this.timestamps[this.timestamps.length - 1] : null;
    this.timestamps.push(now);
    const record = {
      index: this.history.length + 1,
      label,
      iso: new Date(now).toISOString(),
      epochMs: now,
      rolling60sCount: this.timestamps.length,
      spacingSincePrevMs: spacingMs,
      activeSessions: this.activeSessionIds.size,
    };
    this.history.push(record);
    console.log(
      `[OnlineRateLimiter] Request #${record.index} (${label}) at ${record.iso} | rolling60s=${record.rolling60sCount}/${OnlineRateLimiter.MAX_REQUESTS_PER_60S} | spacingMs=${spacingMs ?? 'N/A'} | activeSessions=${record.activeSessions}/${OnlineRateLimiter.MAX_CONCURRENT_SESSIONS}`
    );
    return record;
  }
}

/* ============================================================================
 * 2. Helpers: Binary Resolution, Process Snapshot, Electron Launch
 * ========================================================================== */

function resolveReleaseExecutable() {
  const candidates = [];
  if (process.env.GRAVITY_RELEASE_DIR) {
    candidates.push(path.join(path.resolve(process.env.GRAVITY_RELEASE_DIR), 'win-unpacked', 'Gravity.exe'));
  }
  candidates.push(
    path.resolve('release', EXPECTED_VERSION, 'win-unpacked', 'Gravity.exe'),
    path.resolve('release', 'win-unpacked', 'Gravity.exe')
  );
  for (const exe of candidates) {
    try {
      require('node:fs').accessSync(exe);
      return exe;
    } catch { /* try next */ }
  }
  throw new Error('Packaged win-unpacked/Gravity.exe not found. Checked: ' + candidates.join(', '));
}

async function listAgyProcessPids() {
  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await execFileAsync(
      psExe,
      [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'agy.exe\' OR Name=\'agy.EXE\'" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 10000 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function typeField(locator, text) {
  await locator.click();
  await locator.press('Control+a');
  await locator.press('Backspace');
  await locator.fill(text);
  assert.equal(await locator.inputValue(), text);
}

async function createLiveSessionViaUI(page, limiter, cwd, title) {
  limiter.assertSessionCapBeforeCreate();
  // Pure in-memory check (zero extra ACP RPCs): assert backend active count < 3 before creating one more
  const conn = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
  assert.ok(conn.activeSessionCount < OnlineRateLimiter.MAX_CONCURRENT_SESSIONS, `Backend already has ${conn.activeSessionCount} active sessions (cap is 3)`);

  await page.getByTestId('sidebar-new-session-btn').click();
  await page.getByTestId('new-session-modal').waitFor();
  await typeField(page.getByTestId('new-session-cwd-input'), cwd);
  await typeField(page.getByTestId('new-session-title-input'), title);
  await page.getByTestId('confirm-create-session-btn').click();
  await page.getByTestId('new-session-modal').waitFor({ state: 'detached', timeout: 30000 });

  const activeTab = page.locator('[data-testid^="tab-item-"].is-active').first();
  await activeTab.waitFor({ timeout: 30000 });
  const sid = (await activeTab.getAttribute('data-testid')).slice('tab-item-'.length);
  await page.getByTestId(`composer-input-${sid}`).waitFor({ timeout: 20000 });
  limiter.registerSession(sid);
  return sid;
}

async function checkRiskControlInUI(page) {
  const hit = await page.evaluate(patternSrc => {
    const re = new RegExp(patternSrc, 'i');
    const nodes = document.querySelectorAll('.cc-system, [role="alert"], .toast, [data-testid="app-toast"]');
    for (const el of nodes) {
      const text = (el.textContent || '').trim();
      if (text && re.test(text)) return text;
    }
    return null;
  }, RISK_CONTROL_RE.source);
  if (hit) {
    throw new Error(`RISK_CONTROL_ABORT: Detected rate-limit/verification signal in UI: ${hit}`);
  }
}

async function waitForLiveAssistantTurn(page, sessionId, expectedToken, expectedAssistantCount, timeoutMs = 110_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await checkRiskControlInUI(page);
    // Pure in-memory Electron IPC reads only (never polls ACP session/list in a loop!)
    const state = await page.evaluate(async sid => {
      const messages = (await window.gravityDesktop.getSessionMessagePage(sid)).messages;
      const assistants = messages.filter(m => m.role === 'assistant');
      const systems = messages.filter(m => m.role === 'system').map(m => m.content);
      const cancelBtn = document.querySelector(`[data-testid="composer-cancel-btn-${sid}"]`);
      return {
        isCancelVisible: Boolean(cancelBtn),
        assistantCount: assistants.length,
        lastAssistant: assistants.at(-1)
          ? {
              content: assistants.at(-1).content,
              isStreaming: Boolean(assistants.at(-1).isStreaming),
              completedAt: assistants.at(-1).completedAt || null,
              sendFailed: Boolean(assistants.at(-1).sendFailed),
              thoughtsCount: (assistants.at(-1).thoughts || []).length,
              translatedThoughts: (assistants.at(-1).thoughts || []).filter(t => Boolean(t.translatedZhText)).length,
            }
          : null,
        systems,
      };
    }, sessionId);

    for (const sysMsg of state.systems) {
      if (RISK_CONTROL_RE.test(sysMsg)) {
        throw new Error(`RISK_CONTROL_ABORT: System message signaled risk control: ${sysMsg}`);
      }
    }

    if (
      state.assistantCount >= expectedAssistantCount &&
      state.lastAssistant &&
      !state.lastAssistant.isStreaming &&
      state.lastAssistant.completedAt &&
      !state.isCancelVisible
    ) {
      if (state.lastAssistant.sendFailed) {
        throw new Error(`Session ${sessionId} turn #${expectedAssistantCount} failed: ${state.lastAssistant.content}`);
      }
      if (expectedToken && !state.lastAssistant.content.includes(expectedToken)) {
        console.log(`[ONLINE-SMOKE] Warning: Expected token "${expectedToken}" not literally matched in reply: ${state.lastAssistant.content.slice(0, 160)}`);
      }
      return state;
    }
    await delay(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for session ${sessionId} turn #${expectedAssistantCount} to settle`);
}

/* ============================================================================
 * 3. Main Execution
 * ========================================================================== */

(async () => {
  assert.equal(process.platform, 'win32', 'Online live smoke targets Windows Gravity.exe');
  require('node:fs').accessSync(OFFICIAL_AGY_PATH);
  const executable = resolveReleaseExecutable();
  console.log(`[ONLINE-SMOKE] Packaged binary: ${executable}`);
  console.log(`[ONLINE-SMOKE] Official agy CLI: ${OFFICIAL_AGY_PATH}`);

  const preAgyProcesses = await listAgyProcessPids();
  const preAgyPids = new Set(preAgyProcesses.map(p => p.ProcessId));
  console.log(`[ONLINE-SMOKE] Pre-existing agy PIDs before test: ${preAgyPids.size ? [...preAgyPids].join(', ') : '(none)'}`);

  const root = await mkdtemp(path.join(tmpdir(), 'gravity-v024-online-'));
  const profile = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(workspace, { recursive: true })]);

  // Isolated preferences: offline local translator only (zero external APIs), no auto-update network check
  await writeFile(
    path.join(profile, 'preferences.json'),
    JSON.stringify({
      locale: 'zh-CN',
      theme: 'claude-code-dark',
      defaultThoughtTrack: 'zh',
      translationEngine: 'local',
      defaultWorkspaceCwd: workspace,
      autoCheckUpdates: false,
    }, null, 2),
    'utf8'
  );

  const limiter = new OnlineRateLimiter();
  const createdSessions = [];
  let browser;
  let child;
  let exited;
  let page;

  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const childEnv = {
      ...process.env,
      AGY_BINARY_PATH: OFFICIAL_AGY_PATH,
      AGY_RENDERER_URL: '',
    };
    // CRITICAL: T3 Code sets ELECTRON_RUN_AS_NODE=1 and Antigravity harness env vars
    // (ANTIGRAVITY_*, GEMINI_HOME, AGY_ACP_FORCE_FILE_STORAGE, etc.) in child shells.
    // Remove them so Gravity.exe spawns official `agy.EXE` in a clean standard desktop env.
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.GEMINI_HOME;
    delete childEnv.AGY_ACP_FORCE_FILE_STORAGE;
    delete childEnv.AGY_CLI_DISABLE_AUTO_UPDATE;
    for (const key of Object.keys(childEnv)) {
      if (/^(?:ANTIGRAVITY_|T3_|T3CODE_)/i.test(key)) {
        delete childEnv[key];
      }
    }

    child = spawn(
      executable,
      ['--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
      { cwd: workspace, env: childEnv, windowsHide: true, stdio: 'ignore' }
    );
    exited = new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', reject);
    });

    const deadline = Date.now() + 45000;
    while (!browser && Date.now() < deadline) {
      const lines = (await readFile(portFile, 'utf8').catch(() => '')).trim().split(/\r?\n/);
      if (lines[0] && lines[1]) {
        browser = await chromium
          .connectOverCDP(`ws://127.0.0.1:${lines[0]}${lines[1]}`, { timeout: 2500 })
          .catch(() => undefined);
      }
      if (!browser) await delay(150);
    }
    assert.ok(browser, 'Packaged Gravity.exe did not expose DevToolsActivePort');

    const context = browser.contexts()[0];
    page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15000 });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.locator('[data-testid="agy-app-root"], [data-testid="app-bootstrap-error"]').first().waitFor({ timeout: 90000 });
    const bootErr = page.getByTestId('app-bootstrap-error');
    if (await bootErr.count()) throw new Error('Bootstrap error: ' + await bootErr.innerText());

    const conn = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
    console.log(`[ONLINE-SMOKE] ACP connected=${conn.connected}, version=${conn.agyVersion}, models=${(conn.availableModels || []).length}, lastError=${conn.lastError || '(none)'}`);
    assert.equal(conn.connected, true, 'Official agy ACP failed to connect: ' + conn.lastError);
    if (conn.lastError && /authentication required|sign in|unauthenticated/i.test(conn.lastError)) {
      throw new Error(
        `AUTH_REQUIRED: Official agy CLI (${OFFICIAL_AGY_PATH}) is not signed in on the default profile (ACP reported "${conn.lastError}"). Sign in interactively via official "agy" CLI and re-run.`
      );
    }

    // ------------------------------------------------------------------------
    // Request #1 (Session 1): short no-tools prompt + verify streaming/thought/telemetry
    // ------------------------------------------------------------------------
    const s1 = await createLiveSessionViaUI(page, limiter, workspace, 'Online Smoke S1');
    createdSessions.push(s1);
    await limiter.acquireRequestSlot('S1 Turn 1');
    const c1 = page.getByTestId(`composer-input-${s1}`);
    await typeField(c1, 'Reply with ONLINE_S1_OK and 1 short sentence explaining what an event loop is. No tools needed.');
    await c1.press('Enter');

    const s1t1 = await waitForLiveAssistantTurn(page, s1, 'ONLINE_S1_OK', 1, 110_000);
    assert.ok(s1t1.lastAssistant.content.includes('ONLINE_S1_OK'), `S1 Turn 1 missing ONLINE_S1_OK: ${s1t1.lastAssistant.content}`);
    const teleAfterS1 = await page.evaluate(() => window.gravityDesktop.getTelemetryDashboard());
    const s1TokensT1 = teleAfterS1.activeSessions[s1]?.costSummary?.totalTokens ?? 0;
    console.log(`[ONLINE-SMOKE] S1 Turn 1 settled | thoughts=${s1t1.lastAssistant.thoughtsCount} (zh=${s1t1.lastAssistant.translatedThoughts}) | tokens=${s1TokensT1} | reply="${s1t1.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 140)}"`);
    assert.ok(s1TokensT1 > 0 || (teleAfterS1.activeSessions[s1]?.usedContextTokens ?? 0) > 0, 'Expected real telemetry update after S1 Turn 1');

    // ------------------------------------------------------------------------
    // Request #2 (Session 2, parallel with S1, >=13s after #1) + mid-stream tab switch isolation check
    // ------------------------------------------------------------------------
    const s2 = await createLiveSessionViaUI(page, limiter, workspace, 'Online Smoke S2');
    createdSessions.push(s2);
    await limiter.acquireRequestSlot('S2 Turn 1');
    const c2 = page.getByTestId(`composer-input-${s2}`);
    await typeField(c2, 'Reply with ONLINE_S2_OK and list 2 HTTP status codes. No tools needed.');
    await c2.press('Enter');

    // Switch to S1 mid-stream & verify pane isolation, then switch back to S2
    await delay(400);
    await page.getByTestId(`tab-item-${s1}`).click();
    await page.getByTestId(`session-pane-${s1}`).waitFor();
    const s1PaneText = await page.getByTestId(`session-pane-${s1}`).innerText();
    assert.ok(s1PaneText.includes('ONLINE_S1_OK'), 'S1 pane lost its message during mid-stream switch');
    assert.equal(s1PaneText.includes('ONLINE_S2_OK'), false, 'S2 output leaked into S1 pane!');
    await page.getByTestId(`tab-item-${s2}`).click();
    await page.getByTestId(`session-pane-${s2}`).waitFor();

    const s2t1 = await waitForLiveAssistantTurn(page, s2, 'ONLINE_S2_OK', 1, 110_000);
    assert.ok(s2t1.lastAssistant.content.includes('ONLINE_S2_OK'), `S2 Turn 1 missing ONLINE_S2_OK: ${s2t1.lastAssistant.content}`);
    console.log(`[ONLINE-SMOKE] S2 Turn 1 settled | isolation verified | reply="${s2t1.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 140)}"`);

    // ------------------------------------------------------------------------
    // Request #3 (Session 3, parallel 3 sessions total, >=13s after #2)
    // ------------------------------------------------------------------------
    const s3 = await createLiveSessionViaUI(page, limiter, workspace, 'Online Smoke S3');
    createdSessions.push(s3);
    await limiter.acquireRequestSlot('S3 Turn 1');
    const c3 = page.getByTestId(`composer-input-${s3}`);
    await typeField(c3, 'Reply with ONLINE_S3_OK only. No tools needed.');
    await c3.press('Enter');

    const s3t1 = await waitForLiveAssistantTurn(page, s3, 'ONLINE_S3_OK', 1, 110_000);
    assert.ok(s3t1.lastAssistant.content.includes('ONLINE_S3_OK'), `S3 Turn 1 missing ONLINE_S3_OK: ${s3t1.lastAssistant.content}`);

    // Confirm all 3 parallel sessions are active & idle
    const allThree = await page.evaluate(async ids => {
      const list = await window.gravityDesktop.listSessions();
      return ids.map(id => {
        const s = list.find(x => x.sessionId === id);
        return { id, status: s?.status };
      });
    }, [s1, s2, s3]);
    assert.deepEqual(allThree.map(x => x.status), ['idle', 'idle', 'idle'], 'All 3 parallel sessions must settle to idle');
    console.log(`[ONLINE-SMOKE] S3 Turn 1 settled | all 3 parallel sessions idle: ${JSON.stringify(allThree)}`);

    // ------------------------------------------------------------------------
    // Request #4 (Session 1 multi-turn follow-up, >=13s after #3)
    // ------------------------------------------------------------------------
    await page.getByTestId(`tab-item-${s1}`).click();
    await page.getByTestId(`session-pane-${s1}`).waitFor();
    await limiter.acquireRequestSlot('S1 Turn 2');
    const c1Turn2 = page.getByTestId(`composer-input-${s1}`);
    await typeField(c1Turn2, 'Remember your previous reply? Reply ONLY with ONLINE_S1_TURN2_OK.');
    await c1Turn2.press('Enter');

    const s1t2 = await waitForLiveAssistantTurn(page, s1, 'ONLINE_S1_TURN2_OK', 2, 110_000);
    assert.ok(s1t2.lastAssistant.content.includes('ONLINE_S1_TURN2_OK'), `S1 Turn 2 missing ONLINE_S1_TURN2_OK: ${s1t2.lastAssistant.content}`);
    const s1Msgs = await page.evaluate(async sid => (await window.gravityDesktop.getSessionMessagePage(sid)).messages, s1);
    assert.equal(s1Msgs.filter(m => m.role === 'user').length, 2, 'Expected 2 user messages in S1');
    assert.equal(s1Msgs.filter(m => m.role === 'assistant').length, 2, 'Expected 2 assistant messages in S1');

    const teleAfterT2 = await page.evaluate(() => window.gravityDesktop.getTelemetryDashboard());
    const s1TokensT2 = teleAfterT2.activeSessions[s1]?.costSummary?.totalTokens ?? 0;
    console.log(`[ONLINE-SMOKE] S1 Turn 2 settled | tokens grew ${s1TokensT1} -> ${s1TokensT2} | reply="${s1t2.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 120)}"`);
    assert.ok(s1TokensT2 >= s1TokensT1, `Expected telemetry growth or maintenance (${s1TokensT1} -> ${s1TokensT2})`);

    // ------------------------------------------------------------------------
    // Single Live Quota Check (non-fatal if helper/profile unavailable)
    // ------------------------------------------------------------------------
    await limiter.acquireRequestSlot('getAccountQuota');
    const quotaOutcome = await page.evaluate(async () => {
      try {
        const q = await window.gravityDesktop.getAccountQuota();
        return { ok: true, plan: q.plan || null, bucketCount: (q.buckets || []).length, buckets: (q.buckets || []).map(b => ({ id: b.id, remainingFraction: b.remainingFraction, remainingAmount: b.remainingAmount })) };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    });
    console.log(`[ONLINE-SMOKE] Live getAccountQuota() outcome: ${JSON.stringify(quotaOutcome)}`);

    assert.deepEqual(pageErrors, [], 'Page errors during online live smoke: ' + JSON.stringify(pageErrors));

    // Close all 3 sessions cleanly via IPC
    for (const sid of [...createdSessions]) {
      await page.evaluate(id => window.gravityDesktop.closeSession(id), sid);
      limiter.unregisterSession(sid);
    }
    createdSessions.length = 0;

    console.log('\n=== ONLINE RATE-LIMITER COMPLIANCE AUDIT ===');
    for (const r of limiter.history) {
      console.log(`  #${r.index} ${r.iso} | ${r.label} | rolling60s=${r.rolling60sCount}/5 | spacingMs=${r.spacingSincePrevMs ?? 'initial'} | activeSessions=${r.activeSessions}/3`);
    }
  } finally {
    if (page && !page.isClosed() && createdSessions.length > 0) {
      for (const sid of createdSessions) {
        await page.evaluate(id => window.gravityDesktop.closeSession(id), sid).catch(() => {});
      }
    }
    if (browser) {
      const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
      await cdp?.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
    }
    if (child && exited) {
      let timer;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              child.kill();
              reject(new Error('Gravity.exe did not exit within 12s'));
            }, 12000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    // Give Windows a brief moment to finalize process teardown, then verify ZERO orphan agy processes!
    await delay(1200);
    const postAgyProcesses = await listAgyProcessPids();
    const leaked = postAgyProcesses.filter(p => !preAgyPids.has(p.ProcessId));
    console.log(`[ONLINE-SMOKE] Orphan agy check: ${leaked.length} newly spawned remaining`);
    if (leaked.length > 0) {
      console.error('ORPHAN AGY PROCESSES DETECTED:', JSON.stringify(leaked));
      process.exitCode = 1;
    }

    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }).catch(err => {
      console.warn('Temp cleanup warning:', err.message);
    });
  }
})().catch(err => {
  console.error('\nONLINE LIVE SMOKE FAILED:', err);
  process.exitCode = 1;
});
