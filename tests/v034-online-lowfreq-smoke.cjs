'use strict';

/**
 * G-Gravity v0.3.4 — Ultra-Minimal Strictly Rate-Limited Live Online Smoke Test (`W02`).
 *
 * Fixes QA-01 & QA-02:
 *   - QA-01 (Outbound Write-Boundary Metering):
 *     Installs a unified OutboundRateLimiter across EVERY active outbound ACP RPC and CLI probe
 *     (startup handshake, session/new, session/prompt, session/close, mode switch, quota, plugins).
 *     Hard enforces:
 *       * MAX_CONCURRENT_SESSIONS = 1 (single-session minimal smoke)
 *       * MIN_SPACING_MS = 15_000 (>= 15s between ANY two outbound requests)
 *       * MAX_REQUESTS_PER_60S = 4 (sliding 60s window <= 4)
 *       * ZERO retries on 401 / 403 / 429 / captcha / verification / RESOURCE_EXHAUSTED / PERMISSION_DENIED
 *   - QA-02 (Verifiable Zero-Orphan Process Check):
 *     Samples Windows Win32_Process strictly by (ProcessId, ParentProcessId, Name, CreationDateUtcMs).
 *     * NEVER queries or logs CommandLine of host processes.
 *     * Tracks the exact Gravity.exe root PID + creation time + descendant tree observed while running.
 *     * If CIM / PowerShell process inspection fails or returns invalid data, outputs `BLOCKED` and
 *       exits non-zero (exit code 2), REFUSING sign-off instead of silently reporting 0 orphans.
 *
 * Minimal Online Flow (1 manually logged-in default Profile):
 *   1. Pre-flight local compliance checks (0 ACP RPCs: bridge shape, D2-A CSP, D4 zero plaintext keys)
 *   2. 1 Handshake (`initialize` verified via `getConnectionStatus()`, metered)
 *   3. Wait >= 15s -> 1 Create Session (`session/new`, peak sessions = 1)
 *   4. Wait >= 15s -> 1 Short No-Tools Prompt (`session/prompt`) & verify streaming/pagination/telemetry
 *   5. Wait >= 15s -> 1 Close Session (`session/close`) & clean app quit
 *   6. Verifiable 0-orphan post-exit check (PASS / FAIL / BLOCKED)
 */

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const execFileAsync = promisify(execFile);

const EXPECTED_VERSION = 'v' + require('../package.json').version;
const OFFICIAL_AGY_PATH = process.env.AGY_BINARY_PATH || 'agy';

// Immediate abort regex on 401 / 403 / 429 / captcha / human verification / quota risk signals
const RISK_CONTROL_RE =
  /\b(?:401|403|429)\b|rate.?limit|too many requests|captcha|verification required|verify you are human|unauthenticated|login required|RESOURCE_EXHAUSTED|PERMISSION_DENIED|UNAUTHENTICATED|限流|安全验证|人机验证|请求过于频繁|未登录|登录已过期/i;

/** All renderer->main bridge methods that can trigger an outbound ACP RPC or official CLI probe. */
const METERED_BRIDGE_METHODS = Object.freeze([
  'listSessions',
  'createSession',
  'resumeSession',
  'closeSession',
  'sendPrompt',
  'cancelPrompt',
  'compactSessionContext',
  'setSessionMode',
  'setSessionEffort',
  'setSessionModel',
  'reviseMessage',
  'switchConversationBranch',
  'organizeTitles',
  'getAccountQuota',
  'launchOfficialLogin',
  'officialLogout',
  'getPluginsSnapshot',
  'runPluginAction',
  'runMcpAction',
]);

/* ============================================================================
 * 1. QA-01: Unified Outbound Write-Boundary Rate Limiter & Compliance Meter
 * ========================================================================== */

class OutboundRateLimiter {
  static MAX_CONCURRENT_SESSIONS = 1;
  static MAX_REQUESTS_PER_60S = 4;
  static MIN_SPACING_MS = 15_000;
  static WINDOW_MS = 60_000;

  constructor(nowFn = () => Date.now()) {
    this.nowFn = nowFn;
    this.timestamps = [];
    this.history = [];
    this.activeSessionIds = new Set();
    this.peakConcurrentSessions = 0;
    this.violations = [];
    this.abortedReason = null;
  }

  abortOnRiskControl(reason) {
    this.abortedReason = reason;
    throw new Error(`RISK_CONTROL_ABORT: ${reason}`);
  }

  assertNotAborted() {
    if (this.abortedReason) {
      throw new Error(`RISK_CONTROL_ABORT: Further requests blocked (${this.abortedReason})`);
    }
  }

  assertSessionCapBeforeCreate() {
    this.assertNotAborted();
    const nextCount = this.activeSessionIds.size + 1;
    if (nextCount > OutboundRateLimiter.MAX_CONCURRENT_SESSIONS) {
      const msg = `CONCURRENCY_CAP_VIOLATION: active sessions would reach ${nextCount} > ${OutboundRateLimiter.MAX_CONCURRENT_SESSIONS}`;
      this.violations.push(msg);
      throw new Error(msg);
    }
  }

  registerSession(sessionId) {
    this.assertSessionCapBeforeCreate();
    this.activeSessionIds.add(sessionId);
    if (this.activeSessionIds.size > this.peakConcurrentSessions) {
      this.peakConcurrentSessions = this.activeSessionIds.size;
    }
  }

  unregisterSession(sessionId) {
    this.activeSessionIds.delete(sessionId);
  }

  prune(now = this.nowFn()) {
    const cutoff = now - OutboundRateLimiter.WINDOW_MS;
    this.timestamps = this.timestamps.filter((ts) => ts >= cutoff);
  }

  /**
   * Records an outbound request that occurred at the boundary (including app-initiated startup handshake
   * or any renderer bridge call) and verifies hard spacing + 60s window invariants.
   */
  recordOutboundBoundaryEvent(channel, label, now = this.nowFn(), { enforceSpacing = true } = {}) {
    this.assertNotAborted();
    this.prune(now);

    const prevTs = this.timestamps.length > 0 ? this.timestamps[this.timestamps.length - 1] : null;
    const spacingMs = prevTs === null ? null : now - prevTs;

    if (enforceSpacing && spacingMs !== null && spacingMs < OutboundRateLimiter.MIN_SPACING_MS) {
      const msg = `RATE_LIMIT_SPACING_VIOLATION: "${channel}:${label}" spacing ${spacingMs}ms < ${OutboundRateLimiter.MIN_SPACING_MS}ms`;
      this.violations.push(msg);
      throw new Error(msg);
    }
    if (this.timestamps.length + 1 > OutboundRateLimiter.MAX_REQUESTS_PER_60S) {
      const msg = `RATE_LIMIT_WINDOW_VIOLATION: "${channel}:${label}" would reach ${this.timestamps.length + 1}/60s > ${OutboundRateLimiter.MAX_REQUESTS_PER_60S}`;
      this.violations.push(msg);
      throw new Error(msg);
    }

    this.timestamps.push(now);
    const entry = {
      index: this.history.length + 1,
      channel,
      label,
      iso: new Date(now).toISOString(),
      epochMs: now,
      rolling60sCount: this.timestamps.length,
      spacingSincePrevMs: spacingMs,
      activeSessions: this.activeSessionIds.size,
    };
    this.history.push(entry);
    console.log(
      `[OutboundMeter] #${entry.index} (${channel} :: ${label}) at ${entry.iso} | rolling60s=${entry.rolling60sCount}/${OutboundRateLimiter.MAX_REQUESTS_PER_60S} | spacingMs=${spacingMs ?? 'initial'} | activeSessions=${entry.activeSessions}/${OutboundRateLimiter.MAX_CONCURRENT_SESSIONS}`
    );
    return entry;
  }

  /**
   * Waits until the next outbound request slot strictly satisfies BOTH:
   *   - spacing >= MIN_SPACING_MS (15s + 400ms safety buffer)
   *   - sliding 60s count < MAX_REQUESTS_PER_60S (4)
   */
  async waitForNextSlot(label) {
    this.assertNotAborted();
    if (this.timestamps.length > 0) {
      const elapsed = this.nowFn() - this.timestamps[this.timestamps.length - 1];
      if (elapsed < OutboundRateLimiter.MIN_SPACING_MS) {
        const waitMs = OutboundRateLimiter.MIN_SPACING_MS - elapsed + 400;
        console.log(`[OutboundMeter] Enforcing >=15s spacing: waiting ${waitMs}ms before "${label}"...`);
        await delay(waitMs);
      }
    }
    this.prune(this.nowFn());
    if (this.timestamps.length >= OutboundRateLimiter.MAX_REQUESTS_PER_60S) {
      const oldest = this.timestamps[0];
      const waitWindowMs = Math.max(0, oldest + OutboundRateLimiter.WINDOW_MS - this.nowFn()) + 400;
      console.log(`[OutboundMeter] Sliding 60s window full (${this.timestamps.length}/4): waiting ${waitWindowMs}ms before "${label}"...`);
      await delay(waitWindowMs);
    }
    this.assertNotAborted();
  }

  auditSummary() {
    let minSpacingMs = null;
    for (const item of this.history) {
      if (typeof item.spacingSincePrevMs === 'number') {
        minSpacingMs = minSpacingMs === null ? item.spacingSincePrevMs : Math.min(minSpacingMs, item.spacingSincePrevMs);
      }
    }
    const maxRolling60s = this.history.reduce((max, item) => Math.max(max, item.rolling60sCount), 0);
    return {
      totalOutboundRequests: this.history.length,
      minSpacingMs,
      maxRolling60s,
      peakConcurrentSessions: this.peakConcurrentSessions,
      violations: [...this.violations],
      compliant:
        this.violations.length === 0 &&
        this.peakConcurrentSessions <= OutboundRateLimiter.MAX_CONCURRENT_SESSIONS &&
        maxRolling60s <= OutboundRateLimiter.MAX_REQUESTS_PER_60S &&
        (minSpacingMs === null || minSpacingMs >= OutboundRateLimiter.MIN_SPACING_MS),
      history: this.history,
    };
  }
}

/* ============================================================================
 * 2. QA-02: Verifiable Process Tree Snapshot & Zero-Orphan Classifier
 *    - Strictly (ProcessId, ParentProcessId, Name, CreationDateUtcMs)
 *    - ZERO CommandLine query or logging
 *    - Any CIM query failure -> BLOCKED (refuses sign-off)
 * ========================================================================== */

function processIdentityKey(proc) {
  return `${proc.pid}:${proc.creationDateUtcMs}`;
}

/**
 * Samples Windows processes WITHOUT querying or logging CommandLine.
 * Throws on any PowerShell / CIM error so caller marks orphan verification BLOCKED.
 */
async function snapshotWindowsProcessesStrict() {
  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$ErrorActionPreference='Stop'",
    '$rows = Get-CimInstance Win32_Process | ForEach-Object {',
    '  $ts = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() } else { 0 }',
    '  [PSCustomObject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; creationDateUtcMs = [long]$ts }',
    '}',
    '@($rows) | ConvertTo-Json -Compress',
  ].join('; ');

  const { stdout } = await execFileAsync(
    psExe,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }
  );
  const trimmed = String(stdout || '').trim();
  if (!trimmed) {
    throw new Error('CIM Win32_Process query returned empty output');
  }
  const parsed = JSON.parse(trimmed);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) {
    throw new Error('CIM Win32_Process query returned 0 processes');
  }
  return list.map((row) => {
    if (
      !row ||
      !Number.isSafeInteger(row.pid) ||
      !Number.isSafeInteger(row.parentPid) ||
      typeof row.name !== 'string' ||
      !Number.isSafeInteger(row.creationDateUtcMs)
    ) {
      throw new Error('CIM Win32_Process row missing required (pid, parentPid, name, creationDateUtcMs) fields');
    }
    return {
      pid: row.pid,
      parentPid: row.parentPid,
      name: row.name,
      creationDateUtcMs: row.creationDateUtcMs,
    };
  });
}

function collectDescendantTree(processes, rootPid, rootCreationDateUtcMs) {
  const byParent = new Map();
  for (const proc of processes) {
    const bucket = byParent.get(proc.parentPid) || [];
    bucket.push(proc);
    byParent.set(proc.parentPid, bucket);
  }
  const descendants = [];
  const visited = new Set([rootPid]);
  const queue = [{ pid: rootPid, createdAt: rootCreationDateUtcMs }];

  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of byParent.get(parent.pid) || []) {
      if (visited.has(child.pid)) continue;
      // Creation time guard prevents PID-reuse false linkage
      if (child.creationDateUtcMs > 0 && parent.createdAt > 0 && child.creationDateUtcMs + 2000 < parent.createdAt) {
        continue;
      }
      visited.add(child.pid);
      descendants.push(child);
      queue.push({ pid: child.pid, createdAt: child.creationDateUtcMs });
    }
  }
  return descendants;
}

/**
 * Pure classifier for QA-02 zero-orphan verification.
 * Returns ONLY sanitized { pid, parentPid, name, creationDateIso, reason } — NEVER any CommandLine.
 */
function classifyOrphanProcesses({
  preProcesses,
  observedDescendants,
  postProcesses,
  rootPid,
  rootCreationDateUtcMs,
  launchEpochMs,
}) {
  const preKeys = new Set(preProcesses.map(processIdentityKey));
  const observedKeys = new Set(observedDescendants.map(processIdentityKey));
  const trackedPids = new Set([rootPid, ...observedDescendants.map((p) => p.pid)]);
  const orphans = [];

  for (const proc of postProcesses) {
    const key = processIdentityKey(proc);
    if (preKeys.has(key)) continue;

    const createdAfterLaunch =
      proc.creationDateUtcMs === 0 || proc.creationDateUtcMs >= Math.min(launchEpochMs, rootCreationDateUtcMs || launchEpochMs) - 2000;
    const isRootStillAlive =
      proc.pid === rootPid &&
      (rootCreationDateUtcMs === 0 || Math.abs(proc.creationDateUtcMs - rootCreationDateUtcMs) <= 2000);
    const isObservedDescendant = observedKeys.has(key);
    const isChildOfTrackedTree = trackedPids.has(proc.parentPid) && createdAfterLaunch;
    const isNewAgy = /^agy(?:\.exe)?$/i.test(proc.name) && createdAfterLaunch;

    if (isRootStillAlive || isObservedDescendant || isChildOfTrackedTree || isNewAgy) {
      orphans.push({
        pid: proc.pid,
        parentPid: proc.parentPid,
        name: proc.name,
        creationDateIso: proc.creationDateUtcMs > 0 ? new Date(proc.creationDateUtcMs).toISOString() : null,
        reason: isRootStillAlive
          ? 'root-still-alive'
          : isObservedDescendant
            ? 'observed-descendant-survived'
            : isChildOfTrackedTree
              ? 'child-of-instance-tree'
              : 'new-agy-born-during-run',
      });
    }
  }
  return orphans;
}

/* ============================================================================
 * 3. Helpers: Release Binary Resolution, Risk-Control Scanner & Turn Waiter
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
      fs.accessSync(exe);
      return exe;
    } catch {
      /* try next */
    }
  }
  throw new Error('Packaged win-unpacked/Gravity.exe not found. Checked: ' + candidates.join(', '));
}

function assertNoRiskControlText(limiter, text, source) {
  if (typeof text === 'string' && text.trim() && RISK_CONTROL_RE.test(text)) {
    limiter.abortOnRiskControl(`Detected risk-control/auth signal in ${source}: ${text.trim().slice(0, 200)}`);
  }
}

async function checkRiskControlInUI(page, limiter) {
  const hit = await page.evaluate((patternSrc) => {
    const re = new RegExp(patternSrc, 'i');
    const nodes = document.querySelectorAll(
      '.cc-system, [role="alert"], .toast, [data-testid="app-toast"], [data-testid="turn-diagnostic-card"], [data-testid^="pane-error-"]'
    );
    for (const el of nodes) {
      const text = (el.textContent || '').trim();
      if (text && re.test(text)) return text;
    }
    return null;
  }, RISK_CONTROL_RE.source);
  if (hit) {
    limiter.abortOnRiskControl(`UI signaled risk-control/auth error: ${hit.slice(0, 200)}`);
  }
}

async function waitForMinimalAssistantTurn(page, limiter, sessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    await checkRiskControlInUI(page, limiter);
    const state = await page.evaluate(async (sid) => {
      const pageRes = await window.gravityDesktop.getSessionMessagePage(sid);
      const messages = pageRes.messages || [];
      const assistants = messages.filter((m) => m.role === 'assistant');
      const systems = messages.filter((m) => m.role === 'system').map((m) => m.content || '');
      const last = assistants.at(-1);
      const cancelVisible = Boolean(document.querySelector(`[data-testid="cancel-prompt-btn-${sid}"]`));
      return {
        messageCount: messages.length,
        earlierCount: pageRes.earlierCount,
        assistantCount: assistants.length,
        cancelVisible,
        systems,
        lastAssistant: last
          ? {
              id: last.id,
              content: last.content || '',
              isStreaming: Boolean(last.isStreaming),
              completedAt: last.completedAt || null,
              sendFailed: Boolean(last.sendFailed),
              turnStopCode: last.turnStop?.code || null,
              toolCallsCount: (last.toolCalls || []).length,
            }
          : null,
      };
    }, sessionId);
    lastState = state;

    for (const sysMsg of state.systems) {
      assertNoRiskControlText(limiter, sysMsg, 'system-message');
    }
    if (
      state.lastAssistant?.turnStopCode &&
      ['rate_limited_429', 'permission_denied_403', 'auth_required_401'].includes(state.lastAssistant.turnStopCode)
    ) {
      limiter.abortOnRiskControl(`Assistant turn stopped with ${state.lastAssistant.turnStopCode}`);
    }
    if (
      state.assistantCount >= 1 &&
      state.lastAssistant &&
      !state.lastAssistant.isStreaming &&
      state.lastAssistant.completedAt &&
      !state.cancelVisible
    ) {
      if (state.lastAssistant.sendFailed) {
        assertNoRiskControlText(limiter, state.lastAssistant.content, 'failed-assistant');
        throw new Error(`Turn failed: ${state.lastAssistant.content.slice(0, 200)}`);
      }
      return state;
    }
    await delay(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for assistant reply. Last state: ${JSON.stringify(lastState)}`);
}

/* ============================================================================
 * 4. Main Execution (Minimal 1 Handshake + 1 No-Tools Short Q&A + Clean Close)
 * ========================================================================== */

async function runOnlineSmoke() {
  assert.equal(process.platform, 'win32', 'v0.3.4 Windows online smoke requires win32');
  fs.accessSync(OFFICIAL_AGY_PATH);
  const { chromium } = require('playwright-core');
  const executable = resolveReleaseExecutable();
  console.log(`[V034-ONLINE-SMOKE] Packaged binary: ${executable}`);
  console.log(`[V034-ONLINE-SMOKE] Official agy CLI: ${OFFICIAL_AGY_PATH}`);

  const limiter = new OutboundRateLimiter();
  const summary = {
    version: EXPECTED_VERSION,
    verdict: 'PENDING',
    binary: executable,
    agyPath: OFFICIAL_AGY_PATH,
    preFlightCompliance: null,
    handshake: null,
    minimalTurn: null,
    rateLimiterAudit: null,
    orphanCheck: {
      status: 'PENDING',
      rootPid: null,
      rootCreationDateIso: null,
      observedDescendantsCount: 0,
      survivingOrphans: [],
      error: null,
    },
  };

  // QA-02 Step 1: Strict pre-launch process snapshot (CIM error => BLOCKED, refuse sign-off)
  let preProcesses;
  try {
    preProcesses = await snapshotWindowsProcessesStrict();
  } catch (err) {
    summary.verdict = 'BLOCKED';
    summary.orphanCheck.status = 'BLOCKED';
    summary.orphanCheck.error = `Pre-launch CIM query failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[V034-ONLINE-SMOKE] BLOCKED (QA-02):', summary.orphanCheck.error);
    console.log('\n=== V034_ONLINE_SMOKE_SUMMARY_JSON ===');
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 2;
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'gravity-v034-online-'));
  const profile = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeFile(
    path.join(profile, 'preferences.json'),
    JSON.stringify(
      {
        locale: 'zh-CN',
        theme: 'claude-code-dark',
        appIcon: 'auto',
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

  let browser;
  let child;
  let exited;
  let page;
  let sessionId = null;
  let rootCreationDateUtcMs = 0;
  let launchEpochMs = Date.now();
  const observedDescendantsMap = new Map();

  const recordActiveDescendants = async () => {
    if (!child || !child.pid) return;
    const snap = await snapshotWindowsProcessesStrict();
    const rootRow = snap.find((p) => p.pid === child.pid);
    if (rootRow && rootRow.creationDateUtcMs > 0) {
      rootCreationDateUtcMs = rootRow.creationDateUtcMs;
      summary.orphanCheck.rootCreationDateIso = new Date(rootCreationDateUtcMs).toISOString();
    }
    for (const desc of collectDescendantTree(snap, child.pid, rootCreationDateUtcMs || launchEpochMs)) {
      observedDescendantsMap.set(processIdentityKey(desc), desc);
    }
    summary.orphanCheck.observedDescendantsCount = observedDescendantsMap.size;
  };

  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const childEnv = {
      ...process.env,
      AGY_BINARY_PATH: OFFICIAL_AGY_PATH,
      AGY_RENDERER_URL: '',
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.NODE_OPTIONS;
    delete childEnv.GEMINI_HOME;
    delete childEnv.AGY_ACP_FORCE_FILE_STORAGE;
    delete childEnv.AGY_CLI_DISABLE_AUTO_UPDATE;
    for (const key of Object.keys(childEnv)) {
      if (/^(?:ANTIGRAVITY_|T3_|T3CODE_)/i.test(key)) delete childEnv[key];
    }

    launchEpochMs = Date.now();
    // Meter Request #1: startup handshake (initialize + bootstrap) at process launch boundary
    limiter.recordOutboundBoundaryEvent('acp:startup', 'initialize+handshake', launchEpochMs, { enforceSpacing: false });

    child = spawn(
      executable,
      ['--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
      { cwd: workspace, env: childEnv, windowsHide: true, stdio: 'ignore' }
    );
    summary.orphanCheck.rootPid = child.pid ?? null;
    exited = new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', reject);
    });

    const deadline = Date.now() + 45_000;
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
    page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 15_000 }));
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // QA-01: Install outbound write-boundary metering proxy on all active bridge RPC/CLI methods
    await page.exposeFunction('__gravityQaRecordOutbound', (methodName) => {
      limiter.recordOutboundBoundaryEvent('ipc:bridge', methodName);
    });

    await page.locator('[data-testid="agy-app-root"], [data-testid="app-bootstrap-error"]').first().waitFor({ timeout: 90_000 });
    const bootErr = page.getByTestId('app-bootstrap-error');
    if (await bootErr.count()) throw new Error('Bootstrap error: ' + (await bootErr.innerText()));

    await page.evaluate((methods) => {
      if (!window.gravityDesktop) return;
      const original = window.gravityDesktop;
      const wrapped = {};
      for (const key of Object.keys(original)) {
        const val = original[key];
        if (typeof val === 'function' && methods.includes(key)) {
          wrapped[key] = async (...args) => {
            await window.__gravityQaRecordOutbound(key);
            return val(...args);
          };
        } else {
          wrapped[key] = val;
        }
      }
      window.__gravityMeteredBridge = wrapped;
    }, METERED_BRIDGE_METHODS);

    // ========================================================================
    // 1. Pre-Flight Compliance Checks (0 outbound ACP RPCs)
    // ========================================================================
    const compliance = await page.evaluate(async () => {
      const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const csp = cspMeta ? cspMeta.getAttribute('content') || '' : '';
      const trnCfg = await window.gravityDesktop.getTranslationConfig();
      return {
        hasGravityDesktop: Boolean(window.gravityDesktop),
        hasLegacyAgyDesktop: 'agyDesktop' in window && window.agyDesktop !== undefined,
        hasCopyText: typeof window.gravityDesktop?.copyText === 'function',
        hasGetSessionMessagePage: typeof window.gravityDesktop?.getSessionMessagePage === 'function',
        translatorPlaintextKeyPresent: Boolean(trnCfg?.externalTranslator?.apiKey),
        csp,
      };
    });
    assert.equal(compliance.hasGravityDesktop, true, 'Missing window.gravityDesktop');
    assert.equal(compliance.hasLegacyAgyDesktop, false, 'Legacy window.agyDesktop must be absent');
    assert.equal(compliance.hasCopyText, true, 'U-01: window.gravityDesktop.copyText missing');
    assert.equal(compliance.hasGetSessionMessagePage, true, 'getSessionMessagePage missing');
    assert.equal(compliance.translatorPlaintextKeyPresent, false, 'D4: plaintext translator key leaked');
    assert.ok(compliance.csp.includes("object-src 'none'"), 'D2-A CSP missing object-src none');
    assert.ok(compliance.csp.includes("base-uri 'none'"), 'D2-A CSP missing base-uri none');
    assert.ok(compliance.csp.includes("connect-src 'self'"), 'D2-A CSP missing connect-src self');
    assert.equal(/\b(?:file|http|https):/i.test(compliance.csp), false, 'D2-A CSP must not allow external/file schemes');
    summary.preFlightCompliance = compliance;

    // ========================================================================
    // 2. Verify Handshake (Request #1 already metered at launch) & Sample Tree
    // ========================================================================
    const conn = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
    assertNoRiskControlText(limiter, conn.lastError || '', 'connection-status');
    if (conn.lastErrorCode && ['rate_limited_429', 'permission_denied_403', 'auth_required_401'].includes(conn.lastErrorCode)) {
      limiter.abortOnRiskControl(`Connection status signaled ${conn.lastErrorCode}`);
    }
    assert.equal(conn.connected, true, `Official agy ACP failed to connect: ${conn.lastError || 'unknown'}`);
    assert.equal(conn.activeProfileId, 'default', 'Must stay on manually selected default profile');
    summary.handshake = {
      connected: conn.connected,
      agyVersion: conn.agyVersion,
      availableModelsCount: (conn.availableModels || []).length,
      activeProfileId: conn.activeProfileId,
    };

    // Sample descendant tree while ACP process is active (for QA-02 exact PID+CreationTime tracking)
    await recordActiveDescendants();

    // ========================================================================
    // 3. Create 1 Minimal Session (Request #2, spacing >= 15s)
    // ========================================================================
    await limiter.waitForNextSlot('createSession');
    limiter.assertSessionCapBeforeCreate();
    const created = await page.evaluate(
      ({ cwd }) => window.__gravityMeteredBridge.createSession({ cwd, title: 'v0.3.4 Minimal Online Smoke' }),
      { cwd: workspace }
    );
    sessionId = created.sessionId;
    limiter.registerSession(sessionId);
    await recordActiveDescendants();

    // ========================================================================
    // 4. Send 1 Short No-Tools Prompt (Request #3, spacing >= 15s)
    // ========================================================================
    await limiter.waitForNextSlot('sendPrompt');
    await page.evaluate(
      ({ sid }) =>
        window.__gravityMeteredBridge.sendPrompt({
          sessionId: sid,
          text: 'Reply with V034_LIVE_OK and one concise sentence. Do not invoke any tools.',
        }),
      { sid: sessionId }
    );

    const turnState = await waitForMinimalAssistantTurn(page, limiter, sessionId);
    assert.ok(
      turnState.lastAssistant.content.includes('V034_LIVE_OK'),
      `Minimal live reply missing V034_LIVE_OK: ${turnState.lastAssistant.content.slice(0, 180)}`
    );
    assert.equal(turnState.lastAssistant.toolCallsCount, 0, 'Expected 0 tool calls for no-tools short prompt');

    const tele = await page.evaluate(() => window.gravityDesktop.getTelemetryDashboard());
    const connAfterTurn = await page.evaluate(() => window.gravityDesktop.getConnectionStatus());
    assert.equal(connAfterTurn.activeProfileId, 'default', 'Auto account rotation detected!');

    summary.minimalTurn = {
      ok: true,
      sessionId,
      replyPreview: turnState.lastAssistant.content.replace(/\s+/g, ' ').slice(0, 160),
      pageMessageCount: turnState.messageCount,
      totalTokens: tele.activeSessions?.[sessionId]?.costSummary?.totalTokens ?? 0,
    };

    // ========================================================================
    // 5. Close Session Cleanly (Request #4, spacing >= 15s)
    // ========================================================================
    await limiter.waitForNextSlot('closeSession');
    await page.evaluate((sid) => window.__gravityMeteredBridge.closeSession(sid), sessionId);
    limiter.unregisterSession(sessionId);
    sessionId = null;

    assert.deepEqual(pageErrors, [], `Unexpected renderer pageerrors: ${JSON.stringify(pageErrors)}`);
  } finally {
    if (page && !page.isClosed() && sessionId) {
      await limiter.waitForNextSlot('finally:closeSession').catch(() => {});
      await page.evaluate((sid) => window.__gravityMeteredBridge?.closeSession(sid) ?? window.gravityDesktop?.closeSession(sid), sessionId).catch(() => {});
      limiter.unregisterSession(sessionId);
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
              reject(new Error('Gravity.exe did not exit cleanly within 12s'));
            }, 12_000);
          }),
        ]);
      } catch (err) {
        console.error('[V034-ONLINE-SMOKE] Exit warning:', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        clearTimeout(timer);
      }
    }

    // QA-02 Step 3: Strict post-exit zero-orphan check (CIM failure => BLOCKED, refuse sign-off!)
    await delay(1500);
    try {
      const postProcesses = await snapshotWindowsProcessesStrict();
      const orphans = classifyOrphanProcesses({
        preProcesses,
        observedDescendants: [...observedDescendantsMap.values()],
        postProcesses,
        rootPid: child?.pid ?? -1,
        rootCreationDateUtcMs,
        launchEpochMs,
      });
      summary.orphanCheck.survivingOrphans = orphans;
      summary.orphanCheck.status = orphans.length === 0 ? 'PASS' : 'FAIL';
      if (orphans.length > 0) {
        console.error('[V034-ONLINE-SMOKE] ORPHAN PROCESSES DETECTED:', JSON.stringify(orphans));
        process.exitCode = 1;
      }
    } catch (err) {
      summary.orphanCheck.status = 'BLOCKED';
      summary.orphanCheck.error = `Post-exit CIM query failed: ${err instanceof Error ? err.message : String(err)}`;
      summary.verdict = 'BLOCKED';
      console.error('[V034-ONLINE-SMOKE] BLOCKED (QA-02):', summary.orphanCheck.error);
      process.exitCode = 2;
    }

    summary.rateLimiterAudit = limiter.auditSummary();
    if (!summary.rateLimiterAudit.compliant) {
      console.error('[V034-ONLINE-SMOKE] RATE LIMITER VIOLATION:', JSON.stringify(summary.rateLimiterAudit.violations));
      process.exitCode = 1;
    }

    if (summary.verdict === 'PENDING') {
      summary.verdict =
        summary.orphanCheck.status === 'BLOCKED'
          ? 'BLOCKED'
          : !process.exitCode && summary.minimalTurn?.ok && summary.rateLimiterAudit.compliant && summary.orphanCheck.status === 'PASS'
            ? 'PASS'
            : 'FAIL';
    }

    console.log('\n=== V034_ONLINE_SMOKE_SUMMARY_JSON ===');
    console.log(JSON.stringify(summary, null, 2));

    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }).catch(() => {});
  }
}

module.exports = {
  OutboundRateLimiter,
  METERED_BRIDGE_METHODS,
  RISK_CONTROL_RE,
  classifyOrphanProcesses,
  collectDescendantTree,
};

if (require.main === module) {
  runOnlineSmoke().catch((err) => {
    console.error('\n[V034-ONLINE-SMOKE] FAILED:', err);
    if (!process.exitCode) process.exitCode = 1;
  });
}
