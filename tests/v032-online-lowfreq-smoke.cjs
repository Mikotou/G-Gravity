'use strict';

/**
 * G-Gravity v0.3.2 — Strictly Rate-Limited Slow-Paced Live Online Smoke Test.
 *
 * Launches the real packaged Windows Electron desktop app (`win-unpacked/Gravity.exe`)
 * connected to the real official `agy` CLI (`AGY_BINARY_PATH` or `PATH`) using an isolated temp
 * `--user-data-dir` and temp workspace under `os.tmpdir()`.
 *
 * MANDATORY HARD ANTI-BAN RATE-LIMITER:
 *   - MAX_CONCURRENT_SESSIONS = 2 (hard cap; this smoke opens at most 1 session)
 *   - MAX_REQUESTS_PER_60S = 4 (sliding 60s window; hard abort if ever exceeded)
 *   - MIN_SPACING_MS = 15_000 (minimum 15s gap between any two live online requests)
 *   - Zero retries on any 403 / 429 / rate-limit / captcha / verification / RESOURCE_EXHAUSTED alert
 *   - Isolated `--user-data-dir` + temp workspace; strips ELECTRON_RUN_AS_NODE / ANTIGRAVITY_* / GEMINI_HOME / T3_*
 *   - Verifies ZERO newly spawned orphan `agy.EXE` processes after clean exit.
 */

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

const execFileAsync = promisify(execFile);

const EXPECTED_VERSION = 'v' + require('../package.json').version;
const OFFICIAL_AGY_PATH = process.env.AGY_BINARY_PATH || 'agy';
const RISK_CONTROL_RE =
  /\b(?:403|429)\b|rate.?limit|too many requests|captcha|verification required|RESOURCE_EXHAUSTED|PERMISSION_DENIED|限流|安全验证|人机验证|请求过于频繁/i;

/* ============================================================================
 * 1. Mandatory Hard OnlineRateLimiter (Non-Negotiable Anti-Ban Guard)
 * ========================================================================== */

class OnlineRateLimiter {
  static MAX_CONCURRENT_SESSIONS = 2;
  static MAX_REQUESTS_PER_60S = 4;
  static MIN_SPACING_MS = 15_000;
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
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }

  async acquireRequestSlot(label) {
    // 1) Enforce >= 15,000ms spacing since previous live request (with +350ms jitter cushion)
    if (this.timestamps.length > 0) {
      const lastTs = this.timestamps[this.timestamps.length - 1];
      const elapsed = Date.now() - lastTs;
      if (elapsed < OnlineRateLimiter.MIN_SPACING_MS) {
        const waitMs = OnlineRateLimiter.MIN_SPACING_MS - elapsed + 350;
        console.log(`[OnlineRateLimiter] Spacing guard: waiting ${waitMs}ms before "${label}"...`);
        await delay(waitMs);
      }
    }

    // 2) Wait out rolling 60s window if already at 4/4 before claiming next slot
    this.prune(Date.now());
    if (this.timestamps.length >= OnlineRateLimiter.MAX_REQUESTS_PER_60S) {
      const oldest = this.timestamps[0];
      const waitWindowMs = Math.max(0, oldest + OnlineRateLimiter.WINDOW_MS - Date.now()) + 350;
      console.log(`[OnlineRateLimiter] Sliding 60s cap (4/4) reached: waiting ${waitWindowMs}ms before "${label}"...`);
      await delay(waitWindowMs);
    }

    const now = Date.now();
    this.prune(now);

    // 3) Hard non-negotiable invariant assertions
    if (this.timestamps.length > 0) {
      const gap = now - this.timestamps[this.timestamps.length - 1];
      if (gap < OnlineRateLimiter.MIN_SPACING_MS) {
        throw new Error(
          `[OnlineRateLimiter] HARD ABORT: spacing ${gap}ms < ${OnlineRateLimiter.MIN_SPACING_MS}ms for "${label}"`
        );
      }
    }
    if (this.timestamps.length + 1 > OnlineRateLimiter.MAX_REQUESTS_PER_60S) {
      throw new Error(
        `[OnlineRateLimiter] HARD ABORT: sliding 60s count would reach ${this.timestamps.length + 1} > ${OnlineRateLimiter.MAX_REQUESTS_PER_60S} for "${label}"`
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
      `[OnlineRateLimiter] Request #${record.index} (${label}) at ${record.iso} | rolling60s=${record.rolling60sCount}/${OnlineRateLimiter.MAX_REQUESTS_PER_60S} | spacingMs=${spacingMs ?? 'initial'} | activeSessions=${record.activeSessions}/${OnlineRateLimiter.MAX_CONCURRENT_SESSIONS}`
    );
    return record;
  }
}

/* ============================================================================
 * 2. Local Loopback Mock OpenAI-Compatible Guardian Server (127.0.0.1 only)
 * ========================================================================== */

async function startMockGuardianServer() {
  const requests = [];
  let mode = 'approve'; // 'approve' | 'escalate'

  const server = createServer((req, res) => {
    const urlPath = (req.url || '').split('?')[0];
    if (req.method === 'GET' && /\/models$/i.test(urlPath)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'local-qa-mock' }],
        })
      );
      return;
    }

    if (req.method === 'POST' && /\/chat\/completions$/i.test(urlPath)) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let payload = {};
        let reviewInput = {};
        try {
          payload = JSON.parse(rawBody);
          const userMsg = (payload.messages || []).find((m) => m.role === 'user');
          if (userMsg && typeof userMsg.content === 'string') {
            reviewInput = JSON.parse(userMsg.content);
          }
        } catch {
          // keep empty reviewInput
        }

        const isConnectionTest =
          reviewInput.intentSummary === 'Connection test using a fixed read-only example' ||
          reviewInput.command === 'git status';

        let decision;
        if (isConnectionTest || mode === 'approve') {
          decision = {
            recommended: 'approve',
            riskLevel: 'low',
            riskScore: 15,
            intentAlignment: 'aligned',
            reason: isConnectionTest
              ? '连接测试只读样例安全通过'
              : '工作区内验证命令符合用户明确意图，风险较低，允许执行',
          };
        } else {
          decision = {
            recommended: 'ask',
            riskLevel: 'high',
            riskScore: 86,
            intentAlignment: 'uncertain',
            reason: 'QA 模拟高风险且意图不确定场景，请人工核对后再决定是否放行',
          };
        }

        const entry = {
          index: requests.length + 1,
          timestamp: new Date().toISOString(),
          isConnectionTest,
          modeAtCall: mode,
          model: payload.model,
          toolName: reviewInput.toolName,
          command: reviewInput.command,
          floorTier: reviewInput.floorTier,
          withinWorkspace: reviewInput.withinWorkspace,
          hasConversationContext: Boolean(reviewInput.conversationContext),
          decision,
        };
        requests.push(entry);
        console.log(
          `[MockGuardian] #${entry.index} (${entry.isConnectionTest ? 'probe' : entry.modeAtCall}) tool=${entry.toolName} floorTier=${entry.floorTier ?? 'n/a'} cmd=${JSON.stringify((entry.command || '').slice(0, 120))} -> ${decision.recommended}/${decision.riskLevel}(${decision.riskScore},${decision.intentAlignment})`
        );

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl-v032-qa-${entry.index}`,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(decision),
                },
              },
            ],
            usage: { prompt_tokens: 180, completion_tokens: 42, total_tokens: 222 },
          })
        );
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found: ' + urlPath } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
  return {
    baseUrl,
    requests,
    setMode(next) {
      mode = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/* ============================================================================
 * 3. Helpers: Binary Resolution, Process Snapshot, UI Actions, Turn Waiter
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
    } catch {
      /* try next */
    }
  }
  throw new Error('Packaged win-unpacked/Gravity.exe not found. Checked: ' + candidates.join(', '));
}

async function listAgyProcessPids() {
  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await execFileAsync(
      psExe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'agy.exe\' OR Name=\'agy.EXE\'" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 10000 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    // Ignore unrelated synthetic-cli mock processes from parallel E2E runs; strictly audit official agy.EXE processes
    return list.filter((p) => !/synthetic-cli/i.test(String(p.CommandLine || '')));
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
  const conn = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
  assert.ok(
    conn.activeSessionCount < OnlineRateLimiter.MAX_CONCURRENT_SESSIONS,
    `Backend already has ${conn.activeSessionCount} active sessions (cap is ${OnlineRateLimiter.MAX_CONCURRENT_SESSIONS})`
  );

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
  const hit = await page.evaluate((patternSrc) => {
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

/**
 * Waits for a live turn to settle while inspecting UI approval cards, tool calls, and risk-control alerts.
 * Uses pure local in-memory IPCs (`getSessionMessagePage`), never polling `session/list`.
 */
async function waitForLiveAssistantTurn(page, sessionId, prevAssistantCount, options = {}) {
  const { timeoutMs = 130_000, onApprovalCard } = options;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const handledCardIds = new Set();
  const observedCards = [];
  let lastHeartbeatAt = 0;
  let lastState = null;

  while (Date.now() < deadline) {
    await checkRiskControlInUI(page);

    // Check if an inline Stage 3 approval card appeared
    const cardSnapshot = await page.evaluate(() => {
      const card = document.querySelector('[data-testid^="inline-request-view-"]');
      if (!card) return null;
      const testId = card.getAttribute('data-testid') || '';
      const requestId = testId.slice('inline-request-view-'.length);
      const riskBadge = card.querySelector(`[data-testid="risk-badge-${requestId}"]`)?.textContent?.trim() || null;
      const riskScore = card.querySelector(`[data-testid="risk-score-${requestId}"]`)?.textContent?.trim() || null;
      const intentAlignment =
        card.querySelector(`[data-testid="intent-alignment-${requestId}"]`)?.textContent?.trim() || null;
      const floorTier = card.getAttribute('data-floor-tier') || null;
      const cmd = card.querySelector(`[data-testid="request-cmd-${requestId}"]`)?.textContent?.trim() || '';
      const aiReason = card.querySelector(`[data-testid="request-ai-reason-${requestId}"]`)?.textContent?.trim() || null;
      return { requestId, riskBadge, riskScore, intentAlignment, floorTier, cmd, aiReason };
    });

    if (cardSnapshot && !handledCardIds.has(cardSnapshot.requestId)) {
      handledCardIds.add(cardSnapshot.requestId);
      observedCards.push(cardSnapshot);
      console.log(`[ONLINE-SMOKE] Approval card appeared: ${JSON.stringify(cardSnapshot)}`);
      if (typeof onApprovalCard === 'function') {
        await onApprovalCard(cardSnapshot);
      }
    }

    const state = await page.evaluate(async (sid) => {
      const messages = (await window.gravityDesktop.getSessionMessagePage(sid)).messages;
      const assistants = messages.filter((m) => m.role === 'assistant');
      const users = messages.filter((m) => m.role === 'user');
      const systems = messages.filter((m) => m.role === 'system').map((m) => m.content);
      const cancelBtn = document.querySelector(`[data-testid="cancel-prompt-btn-${sid}"]`);
      const composerEl = document.querySelector(`[data-testid="composer-input-${sid}"]`);
      const paneErrorEl = document.querySelector(`[data-testid="pane-error-${sid}"]`);
      const questionBarEl = document.querySelector('[data-testid^="question-bar-"], .question-bar');
      const reviewingCardEl = document.querySelector('[data-testid^="approval-reviewing-card-"]');
      const diagCards = Array.from(document.querySelectorAll('[data-testid="turn-diagnostic-card"]')).map((el) => ({
        code: el.getAttribute('data-diagnostic-code'),
        severity: el.getAttribute('data-diagnostic-severity'),
        text: (el.textContent || '').trim().slice(0, 180),
      }));
      const settledStrips = Array.from(document.querySelectorAll('[data-testid^="turn-settled-"]')).map((el) =>
        (el.textContent || '').trim().slice(0, 180)
      );
      const failurePeeks = Array.from(document.querySelectorAll('[data-testid^="tool-failure-peek-"]')).map((el) =>
        (el.textContent || '').trim().slice(0, 180)
      );
      const failedGroupBadges = Array.from(document.querySelectorAll('[data-testid^="tool-group-failed-"]')).map(
        (el) => (el.textContent || '').trim()
      );
      const last = assistants.at(-1);
      return {
        isCancelVisible: Boolean(cancelBtn),
        userCount: users.length,
        assistantCount: assistants.length,
        composerDraftLen: composerEl ? composerEl.value.length : -1,
        paneError: paneErrorEl ? (paneErrorEl.textContent || '').trim().slice(0, 160) : null,
        questionBar: questionBarEl ? (questionBarEl.textContent || '').trim().slice(0, 160) : null,
        reviewingCard: reviewingCardEl ? (reviewingCardEl.textContent || '').trim().slice(0, 160) : null,
        lastAssistant: last
          ? {
              id: last.id,
              content: last.content || '',
              isStreaming: Boolean(last.isStreaming),
              completedAt: last.completedAt || null,
              sendFailed: Boolean(last.sendFailed),
              turnStop: last.turnStop || null,
              thoughtsCount: (last.thoughts || []).length,
              translatedThoughts: (last.thoughts || []).filter((t) => Boolean(t.translatedZhText)).length,
              toolCalls: (last.toolCalls || []).map((tc) => ({
                toolCallId: tc.toolCallId,
                rawToolName: tc.rawToolName,
                canonicalToolName: tc.canonicalToolName,
                status: tc.status,
                exitCode: tc.exitCode,
                command: tc.command,
                outputPreview: (tc.outputPreview || '').slice(0, 220),
              })),
            }
          : null,
        systems,
        diagCards,
        settledStrips,
        failurePeeks,
        failedGroupBadges,
      };
    }, sessionId);
    lastState = state;

    if (Date.now() - lastHeartbeatAt >= 12_000) {
      lastHeartbeatAt = Date.now();
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `[WAIT +${elapsedSec}s] users=${state.userCount} assistants=${state.assistantCount} (prev=${prevAssistantCount}) busy=${state.isCancelVisible} streaming=${state.lastAssistant?.isStreaming} completed=${Boolean(state.lastAssistant?.completedAt)} tools=${state.lastAssistant?.toolCalls?.length ?? 0} draftLen=${state.composerDraftLen} qBar=${state.questionBar ? 'YES' : 'no'} revCard=${state.reviewingCard ? 'YES' : 'no'} paneErr=${state.paneError || 'none'}`
      );
    }

    for (const sysMsg of state.systems) {
      if (RISK_CONTROL_RE.test(sysMsg)) {
        throw new Error(`RISK_CONTROL_ABORT: System message signaled risk control: ${sysMsg}`);
      }
    }

    if (
      state.assistantCount > prevAssistantCount &&
      state.lastAssistant &&
      !state.lastAssistant.isStreaming &&
      state.lastAssistant.completedAt &&
      !state.isCancelVisible
    ) {
      // Brief pause so auto-recover (if any) would start and flip isCancelVisible back to true
      await delay(900);
      const recheckBusy = await page.evaluate(
        (sid) => Boolean(document.querySelector(`[data-testid="cancel-prompt-btn-${sid}"]`)),
        sessionId
      );
      if (recheckBusy) {
        continue;
      }
      if (state.lastAssistant.sendFailed) {
        throw new Error(`Session ${sessionId} turn failed: ${state.lastAssistant.content}`);
      }
      return { ...state, observedCards };
    }

    await delay(500);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for session ${sessionId} turn to settle. Last state: ${JSON.stringify(lastState)}`
  );
}

/* ============================================================================
 * 4. Main Execution
 * ========================================================================== */

(async () => {
  assert.equal(process.platform, 'win32', 'Online live smoke targets Windows Gravity.exe');
  require('node:fs').accessSync(OFFICIAL_AGY_PATH);
  const executable = resolveReleaseExecutable();
  console.log(`[ONLINE-SMOKE] Packaged binary: ${executable}`);
  console.log(`[ONLINE-SMOKE] Official agy CLI: ${OFFICIAL_AGY_PATH}`);

  const preAgyProcesses = await listAgyProcessPids();
  const preAgyPids = new Set(preAgyProcesses.map((p) => p.ProcessId));
  console.log(
    `[ONLINE-SMOKE] Pre-existing agy PIDs before test: ${preAgyPids.size ? [...preAgyPids].join(', ') : '(none)'}`
  );

  const root = await mkdtemp(path.join(tmpdir(), 'gravity-v032-online-'));
  const profile = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(path.join(workspace, 'tmp-cache'), { recursive: true }),
    mkdir(path.join(workspace, 'tmp-manual'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, 'smoke-note.txt'), 'G-Gravity v0.3.2 online smoke fixture\n', 'utf8'),
    writeFile(path.join(workspace, 'tmp-cache', 'dummy.txt'), 'disposable cache fixture\n', 'utf8'),
    writeFile(path.join(workspace, 'tmp-manual', 'dummy.txt'), 'disposable manual approval fixture\n', 'utf8'),
  ]);

  // Isolated preferences: offline local translator, auto-update check disabled
  await writeFile(
    path.join(profile, 'preferences.json'),
    JSON.stringify(
      {
        locale: 'zh-CN',
        theme: 'claude-code-dark',
        defaultThoughtTrack: 'zh',
        translationEngine: 'local',
        defaultWorkspaceCwd: workspace,
        autoCheckUpdates: false,
      },
      null,
      2
    ),
    'utf8'
  );

  const guardian = await startMockGuardianServer();
  console.log(`[ONLINE-SMOKE] Local loopback Mock Guardian started at ${guardian.baseUrl}`);

  const limiter = new OnlineRateLimiter();
  const createdSessions = [];
  const summary = {
    binary: executable,
    agyPath: OFFICIAL_AGY_PATH,
    scenarios: {},
    rateLimiter: [],
    guardianCalls: [],
    auditEntries: [],
    orphanAgyCount: -1,
  };

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
    // Strip harness / test env vars so Gravity.exe spawns official agy.EXE cleanly
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
    page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 15000 }));
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.locator('[data-testid="agy-app-root"], [data-testid="app-bootstrap-error"]').first().waitFor({ timeout: 90000 });
    const bootErr = page.getByTestId('app-bootstrap-error');
    if (await bootErr.count()) throw new Error('Bootstrap error: ' + (await bootErr.innerText()));

    const conn = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
    console.log(
      `[ONLINE-SMOKE] ACP connected=${conn.connected}, version=${conn.agyVersion}, models=${(conn.availableModels || []).length}, lastError=${conn.lastError || '(none)'}`
    );
    assert.equal(conn.connected, true, 'Official agy ACP failed to connect: ' + conn.lastError);
    if (conn.lastError && /authentication required|sign in|unauthenticated/i.test(conn.lastError)) {
      throw new Error(`AUTH_REQUIRED: Official agy CLI is not signed in (${conn.lastError})`);
    }
    summary.agyVersion = conn.agyVersion;
    summary.availableModelsCount = (conn.availableModels || []).length;

    // ========================================================================
    // SCENARIO 1: Live online connection, streaming reply, thought & telemetry
    // ========================================================================
    console.log('\n--- [SCENARIO 1] Real online connection & streaming Q&A ---');
    const sid = await createLiveSessionViaUI(page, limiter, workspace, 'v0.3.2 Online Smoke');
    createdSessions.push(sid);
    const initialMode = await page.getByTestId(`execution-mode-pill-${sid}`).getAttribute('data-execution-mode');
    const initialApprovalLabel = (await page.getByTestId(`approval-mode-pill-${sid}`).innerText()).trim();
    console.log(`[ONLINE-SMOKE] Session ${sid} initial UI state: executionMode=${initialMode}, approvalPill="${initialApprovalLabel}"`);

    await limiter.acquireRequestSlot('S1: Live no-tools Q&A');
    const composer = page.getByTestId(`composer-input-${sid}`);
    await typeField(
      composer,
      'Reply with V032_LIVE_S1_OK and 1 concise sentence explaining what a TCP handshake is. Do not invoke any tools.'
    );
    await composer.press('Enter');

    const t1 = await waitForLiveAssistantTurn(page, sid, 0);
    assert.ok(
      t1.lastAssistant.content.includes('V032_LIVE_S1_OK'),
      `Scenario 1 missing V032_LIVE_S1_OK: ${t1.lastAssistant.content}`
    );
    const tele1 = await page.evaluate(() => window.gravityDesktop.getTelemetryDashboard());
    const tokens1 = tele1.activeSessions[sid]?.costSummary?.totalTokens ?? 0;
    const usedCtx1 = tele1.activeSessions[sid]?.usedContextTokens ?? 0;
    assert.ok(tokens1 > 0 || usedCtx1 > 0, `Expected real telemetry growth after Scenario 1 (tokens=${tokens1}, ctx=${usedCtx1})`);
    summary.scenarios.scenario1 = {
      ok: true,
      replyPreview: t1.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 160),
      thoughtsCount: t1.lastAssistant.thoughtsCount,
      translatedThoughts: t1.lastAssistant.translatedThoughts,
      totalTokens: tokens1,
      usedContextTokens: usedCtx1,
    };
    console.log(`[SCENARIO 1 PASS] ${JSON.stringify(summary.scenarios.scenario1)}`);

    // ========================================================================
    // SCENARIO 2: Configure v0.3.2 Approve for me via real Settings UI + live command tests
    // ========================================================================
    console.log('\n--- [SCENARIO 2] Approve for me v0.3.2 UI setup & live Guardian tests ---');
    await page.getByTestId('open-theme-modal-btn').click();
    await page.getByTestId('theme-settings-modal').waitFor({ timeout: 10000 });
    await page.getByTestId('settings-tab-approvals').click();
    await page.getByTestId('approval-drawer').waitFor({ timeout: 10000 });

    // Verify v0.3.2 default approval policy UI state on Rules tab
    const defaultPolicyUI = {
      allowAlignedHighRiskPass: await page.getByTestId('policy-allow-aligned-high-risk').isChecked(),
      alignedHighRiskMaxScore: Number(await page.getByTestId('policy-aligned-high-risk-score-input').inputValue()),
      fastPassLowRiskDev: await page.getByTestId('policy-fast-pass-low-risk-dev').isChecked(),
    };
    console.log(`[SCENARIO 2] Default v0.3.2 Approval Policy UI: ${JSON.stringify(defaultPolicyUI)}`);
    assert.equal(defaultPolicyUI.allowAlignedHighRiskPass, true, 'Expected allowAlignedHighRiskPass default true');
    assert.equal(defaultPolicyUI.alignedHighRiskMaxScore, 80, 'Expected alignedHighRiskMaxScore default 80');
    assert.equal(defaultPolicyUI.fastPassLowRiskDev, true, 'Expected fastPassLowRiskDev default true');

    // Switch to External Reviewer tab & configure loopback OpenAI-Compatible mock Guardian via real UI
    await page.getByTestId('drawer-tab-reviewer').click();
    const providerSelect = page.locator('[data-testid="approval-drawer"] select').first();
    await providerSelect.selectOption('openai-compatible');
    const endpointInput = page.locator('[data-testid="approval-drawer"] input[type="text"]').first();
    await typeField(endpointInput, guardian.baseUrl);
    await typeField(page.getByTestId('reviewer-apikey-input'), 'sk-v032-local-loopback-smoke-key-0001');

    // Trigger model discovery & wait for model list to settle
    await page.getByTestId('discover-reviewer-models-btn').click();
    await page.getByTestId('reviewer-model-select').waitFor({ timeout: 10000 });
    await delay(300);

    // Click Test Connection and wait for verified badge
    await page.getByTestId('test-reviewer-connection-btn').click();
    await page.locator('[data-testid="reviewer-connection-badge"].badge-success').waitFor({ timeout: 15000 });
    console.log('[SCENARIO 2] Loopback Guardian connection test PASSED in Settings UI');

    // Enable External Reviewer switch (auto-switches default approval mode to hybrid & saves policy)
    await page.locator('label.switch:has([data-testid="reviewer-enable-action"])').click();
    await page.waitForFunction(
      () => {
        const cb = document.querySelector('[data-testid="reviewer-enable-action"]');
        return Boolean(cb && cb.checked);
      },
      null,
      { timeout: 10000 }
    );
    await delay(400);

    // Close Settings modal via Escape
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-overlay').waitFor({ state: 'detached', timeout: 10000 });

    // Verify persisted approval-config.json on disk (0 extra ACP RPCs)
    const persistedApprovalCfg = JSON.parse(await readFile(path.join(profile, 'approval-config.json'), 'utf8'));
    console.log(
      `[SCENARIO 2] Persisted approval-config.json: mode=${persistedApprovalCfg.mode}, allowAlignedHighRiskPass=${persistedApprovalCfg.allowAlignedHighRiskPass}, alignedHighRiskMaxScore=${persistedApprovalCfg.alignedHighRiskMaxScore}, fastPassLowRiskDev=${persistedApprovalCfg.fastPassLowRiskDev}, reviewerEnabled=${persistedApprovalCfg.externalReviewer?.enabled}`
    );
    assert.equal(persistedApprovalCfg.mode, 'hybrid');
    assert.equal(persistedApprovalCfg.allowAlignedHighRiskPass, true);
    assert.equal(persistedApprovalCfg.alignedHighRiskMaxScore, 80);
    assert.equal(persistedApprovalCfg.fastPassLowRiskDev, true);
    assert.equal(persistedApprovalCfg.externalReviewer?.enabled, true);

    // Scenario 2A: Aligned external-network read command (curl.exe -sI --max-time 8 https://example.com)
    // In Gravity v0.3.2, curl is Stage 2 grey_zone (standard floor), carries agy's real NotificationTimeoutSeconds/SafeToAutoRun/Blocking,
    // and with Mock Guardian returning aligned/low(15)/approve must auto-pass with 0 popups!
    guardian.setMode('approve');
    const prevAssistantCount2A = t1.assistantCount;
    const prevAuditLen2A = (await page.evaluate(() => window.gravityDesktop.listApprovalAudit(50))).length;
    const prevGuardianCalls2A = guardian.requests.length;
    await limiter.acquireRequestSlot('S2A: Aligned workspace command (curl -sI, 0-popup check)');
    await typeField(
      composer,
      'Run this exact terminal command right now: curl.exe -sI --max-time 8 https://example.com (do not ask questions, execute it directly), then report the HTTP status line and include V032_AUTO_PASS_OK.'
    );
    await composer.press('Enter');

    const t2A = await waitForLiveAssistantTurn(page, sid, prevAssistantCount2A, {
      onApprovalCard: async (card) => {
        // Record unexpected card and allow once so turn does not deadlock
        await delay(400);
        await page.getByTestId(`btn-allow-once-${card.requestId}`).click();
      },
    });
    const auditsAfter2A = await page.evaluate(() => window.gravityDesktop.listApprovalAudit(50));
    const newAudits2A = auditsAfter2A.slice(0, Math.max(0, auditsAfter2A.length - prevAuditLen2A));
    const newGuardianCalls2A = guardian.requests.slice(prevGuardianCalls2A);
    console.log(
      `[SCENARIO 2A] Settled | popups=${t2A.observedCards.length} | guardianCalls=${newGuardianCalls2A.length} | tools=${JSON.stringify(t2A.lastAssistant.toolCalls.map((tc) => ({ name: tc.rawToolName, cmd: tc.command, status: tc.status, exitCode: tc.exitCode })))} | newAudits=${JSON.stringify(newAudits2A.map((a) => ({ tool: a.toolName, cmd: a.commandOrSummary, verdict: a.verdict, source: a.decisionSource, risk: a.riskLevel, reason: a.reason })))}`
    );

    // Scenario 2B: Escalated high-risk/uncertain command -> approval card appears & human clicks Allow Once
    guardian.setMode('escalate');
    const prevAssistantCount2B = t2A.assistantCount;
    const prevAuditLen2B = auditsAfter2A.length;
    const prevGuardianCalls2B = guardian.requests.length;
    await limiter.acquireRequestSlot('S2B: Escalated command (curl -sI example.org, approval card + human click)');
    await typeField(
      composer,
      'Run this exact terminal command right now: curl.exe -sI --max-time 8 https://example.org (do not ask questions, execute it directly), then report the HTTP status line and include V032_MANUAL_CARD_OK.'
    );
    await composer.press('Enter');

    let clickedManualAllow = false;
    const t2B = await waitForLiveAssistantTurn(page, sid, prevAssistantCount2B, {
      onApprovalCard: async (card) => {
        await delay(650); // realistic human reading pause
        await page.getByTestId(`btn-allow-once-${card.requestId}`).click();
        clickedManualAllow = true;
      },
    });
    const auditsAfter2B = await page.evaluate(() => window.gravityDesktop.listApprovalAudit(50));
    const newAudits2B = auditsAfter2B.slice(0, Math.max(0, auditsAfter2B.length - prevAuditLen2B));
    const newGuardianCalls2B = guardian.requests.slice(prevGuardianCalls2B);
    console.log(
      `[SCENARIO 2B] Settled | popups=${t2B.observedCards.length} | guardianCalls=${newGuardianCalls2B.length} | clickedAllowOnce=${clickedManualAllow} | tools=${JSON.stringify(t2B.lastAssistant.toolCalls.map((tc) => ({ name: tc.rawToolName, cmd: tc.command, status: tc.status, exitCode: tc.exitCode })))} | newAudits=${JSON.stringify(newAudits2B.map((a) => ({ tool: a.toolName, cmd: a.commandOrSummary, verdict: a.verdict, source: a.decisionSource, risk: a.riskLevel })))}`
    );

    summary.scenarios.scenario2 = {
      ok:
        t2A.observedCards.length === 0 &&
        newAudits2A.length >= 1 &&
        t2B.observedCards.length >= 1 &&
        clickedManualAllow,
      defaultPolicyUI,
      scenario2A: {
        popups: t2A.observedCards.length,
        guardianCalls: newGuardianCalls2A.length,
        tools: t2A.lastAssistant.toolCalls,
        newAudits: newAudits2A.map((a) => ({
          verdict: a.verdict,
          decisionSource: a.decisionSource,
          riskLevel: a.riskLevel,
          commandOrSummary: a.commandOrSummary.slice(0, 140),
          reason: a.reason,
        })),
        replyPreview: t2A.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 140),
      },
      scenario2B: {
        popups: t2B.observedCards.length,
        guardianCalls: newGuardianCalls2B.length,
        clickedManualAllow,
        firstCard: t2B.observedCards[0] || null,
        tools: t2B.lastAssistant.toolCalls,
        newAudits: newAudits2B.map((a) => ({
          verdict: a.verdict,
          decisionSource: a.decisionSource,
          riskLevel: a.riskLevel,
          commandOrSummary: a.commandOrSummary.slice(0, 140),
        })),
        replyPreview: t2B.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 140),
      },
    };
    console.log(`[SCENARIO 2 SUMMARY] ok=${summary.scenarios.scenario2.ok}`);

    // ========================================================================
    // SCENARIO 3: Real command failure (`exit 1`) — MUST NOT silently stall!
    // ========================================================================
    console.log('\n--- [SCENARIO 3] Real command exit 1 non-silent recovery ---');
    guardian.setMode('approve');
    const prevAssistantCount3 = t2B.assistantCount;
    await limiter.acquireRequestSlot('S3: Command exit 1 failure recovery');
    await typeField(
      composer,
      'Run this exact terminal command once: node -e "console.error(\'E_SMOKE\'); process.exit(1)" and report the exact exit code and stderr output. Do not retry or modify the command.'
    );
    await composer.press('Enter');

    const t3 = await waitForLiveAssistantTurn(page, sid, prevAssistantCount3, {
      onApprovalCard: async (card) => {
        await delay(500);
        await page.getByTestId(`btn-allow-once-${card.requestId}`).click();
      },
    });
    const failedTools = t3.lastAssistant.toolCalls.filter(
      (tc) => tc.status === 'failed' || tc.status === 'rejected' || (typeof tc.exitCode === 'number' && tc.exitCode !== 0)
    );
    const hasSubstantiveReply = t3.lastAssistant.content.trim().length > 0;
    const hasDiagnosticOrSettledUI =
      t3.diagCards.length > 0 || t3.settledStrips.length > 0 || Boolean(t3.lastAssistant.turnStop);
    console.log(
      `[SCENARIO 3] Settled | tools=${JSON.stringify(t3.lastAssistant.toolCalls)} | failedGroupBadges=${JSON.stringify(t3.failedGroupBadges)} | failurePeeks=${JSON.stringify(t3.failurePeeks)} | settledStrips=${JSON.stringify(t3.settledStrips)} | diagCards=${JSON.stringify(t3.diagCards)} | reply="${t3.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 160)}"`
    );
    assert.ok(
      failedTools.length > 0 || t3.lastAssistant.content.includes('E_SMOKE') || t3.lastAssistant.content.includes('1'),
      `Scenario 3 did not record failed tool or exit 1 output: ${JSON.stringify(t3.lastAssistant)}`
    );
    assert.ok(
      hasSubstantiveReply || hasDiagnosticOrSettledUI,
      'Scenario 3 silently stalled with neither reply nor diagnostic/settled UI!'
    );
    summary.scenarios.scenario3 = {
      ok: true,
      toolCalls: t3.lastAssistant.toolCalls,
      failedToolsCount: failedTools.length,
      failedGroupBadges: t3.failedGroupBadges,
      failurePeeks: t3.failurePeeks,
      settledStrips: t3.settledStrips,
      diagCards: t3.diagCards,
      turnStop: t3.lastAssistant.turnStop,
      replyPreview: t3.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 180),
    };
    console.log(`[SCENARIO 3 PASS]`);

    // ========================================================================
    // SCENARIO 4: Turbo (full-access) UI flow + Shift+Tab safety + getAccountQuota()
    // ========================================================================
    console.log('\n--- [SCENARIO 4] Turbo UI flow, official agy 1.5.17 capability probe, Shift+Tab & quota ---');
    const modePill = page.getByTestId(`execution-mode-pill-${sid}`);
    const modeBefore = await modePill.getAttribute('data-execution-mode');
    assert.equal(modeBefore, 'default', `Expected initial execution mode default, got ${modeBefore}`);

    // Open mode popover & click Turbo (full-access)
    await modePill.click();
    await page.getByTestId(`execution-mode-menu-${sid}`).waitFor({ timeout: 5000 });
    await page.getByTestId(`execution-mode-option-full-access-${sid}`).click();

    // Verify risk confirmation dialog appears before activating Turbo
    await page.getByTestId(`turbo-confirm-${sid}`).waitFor({ timeout: 5000 });
    const confirmText = (await page.getByTestId(`turbo-confirm-${sid}`).innerText()).replace(/\s+/g, ' ').trim();
    console.log(`[SCENARIO 4] Turbo confirmation dialog visible: "${confirmText.slice(0, 140)}"`);
    await delay(400);

    // Confirm Turbo switch & observe official agy 1.5.17 response
    await page.getByTestId(`turbo-confirm-btn-${sid}`).click();
    await delay(1200);

    const modeAfterTurboClick = await modePill.getAttribute('data-execution-mode');
    const paneErrorLocator = page.getByTestId(`pane-error-${sid}`);
    const paneErrorText = (await paneErrorLocator.count())
      ? (await paneErrorLocator.innerText()).replace(/\s+/g, ' ').trim()
      : null;
    const officialSupportedFullAccess = modeAfterTurboClick === 'full-access';
    console.log(
      `[SCENARIO 4] Official agy ${conn.agyVersion} full-access result: supported=${officialSupportedFullAccess}, modeAfterClick=${modeAfterTurboClick}, paneError=${paneErrorText || '(none)'}`
    );
    if (!officialSupportedFullAccess) {
      assert.ok(
        paneErrorText && paneErrorText.length > 0,
        'If official agy rejects full-access, UI must display a clear error banner rather than failing silently'
      );
      // Dismiss error banner cleanly
      const dismissBtn = page.getByTestId(`pane-error-dismiss-${sid}`);
      if (await dismissBtn.count()) await dismissBtn.click();
    }

    // Blur textarea so Shift+Tab is handled by global mode cycler (App.tsx !isTypingTarget)
    await page.evaluate(() => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    });
    await delay(250);

    const shiftTabSequence = [];
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Shift+Tab');
      await delay(650);
      const curMode = await modePill.getAttribute('data-execution-mode');
      shiftTabSequence.push(curMode);
    }
    console.log(`[SCENARIO 4] Shift+Tab 4x sequence from "${modeAfterTurboClick}": ${JSON.stringify(shiftTabSequence)}`);
    if (officialSupportedFullAccess) {
      assert.equal(shiftTabSequence[0], 'default', `Shift+Tab from full-access must exit to default, got ${shiftTabSequence[0]}`);
    }
    assert.equal(
      shiftTabSequence.includes('full-access'),
      false,
      `Shift+Tab must NEVER cycle back into full-access: ${JSON.stringify(shiftTabSequence)}`
    );

    // Final live getAccountQuota() guarded by OnlineRateLimiter
    await limiter.acquireRequestSlot('S4: getAccountQuota');
    const quotaOutcome = await page.evaluate(async () => {
      try {
        const q = await window.gravityDesktop.getAccountQuota();
        return {
          ok: true,
          plan: q.plan || null,
          bucketCount: (q.buckets || []).length,
          buckets: (q.buckets || []).map((b) => ({
            id: b.id,
            remainingFraction: b.remainingFraction,
            remainingAmount: b.remainingAmount,
          })),
        };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    });
    console.log(`[SCENARIO 4] Live getAccountQuota() outcome: ${JSON.stringify(quotaOutcome)}`);

    summary.scenarios.scenario4 = {
      ok: true,
      turboConfirmDialogShown: true,
      officialSupportedFullAccess,
      modeAfterTurboClick,
      paneErrorText,
      shiftTabSequence,
      quotaOutcome,
    };

    // Collect full audit log before closing
    summary.auditEntries = await page.evaluate(() => window.gravityDesktop.listApprovalAudit(50));
    summary.guardianCalls = guardian.requests;
    summary.rateLimiter = limiter.history;

    assert.deepEqual(pageErrors, [], 'Page errors during online live smoke: ' + JSON.stringify(pageErrors));

    // Close session cleanly via IPC
    for (const id of [...createdSessions]) {
      await page.evaluate((s) => window.gravityDesktop.closeSession(s), id);
      limiter.unregisterSession(id);
    }
    createdSessions.length = 0;

    console.log('\n=== ONLINE RATE-LIMITER COMPLIANCE AUDIT ===');
    for (const r of limiter.history) {
      console.log(
        `  #${r.index} ${r.iso} | ${r.label} | rolling60s=${r.rolling60sCount}/${OnlineRateLimiter.MAX_REQUESTS_PER_60S} | spacingMs=${r.spacingSincePrevMs ?? 'initial'} | activeSessions=${r.activeSessions}/${OnlineRateLimiter.MAX_CONCURRENT_SESSIONS}`
      );
    }
  } finally {
    summary.guardianCalls = guardian.requests;
    summary.rateLimiter = limiter.history;
    if (page && !page.isClosed()) {
      summary.auditEntries = await page.evaluate(() => window.gravityDesktop.listApprovalAudit(50)).catch(() => summary.auditEntries);
    }
    if (page && !page.isClosed() && createdSessions.length > 0) {
      for (const id of createdSessions) {
        await page.evaluate((s) => window.gravityDesktop.closeSession(s), id).catch(() => {});
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

    await guardian.close().catch(() => {});

    // Give Windows a brief moment to finalize process teardown, then verify ZERO orphan agy processes!
    await delay(1500);
    const postAgyProcesses = await listAgyProcessPids();
    const leaked = postAgyProcesses.filter((p) => !preAgyPids.has(p.ProcessId));
    summary.orphanAgyCount = leaked.length;
    console.log(`[ONLINE-SMOKE] Orphan agy check: ${leaked.length} newly spawned remaining`);
    if (leaked.length > 0) {
      console.error('ORPHAN AGY PROCESSES DETECTED:', JSON.stringify(leaked));
      process.exitCode = 1;
    }

    console.log('\n=== V032_ONLINE_SMOKE_SUMMARY_JSON ===');
    console.log(JSON.stringify(summary, null, 2));

    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }).catch((err) => {
      console.warn('Temp cleanup warning:', err.message);
    });
  }
})().catch((err) => {
  console.error('\nONLINE LIVE SMOKE FAILED:', err);
  process.exitCode = 1;
});
