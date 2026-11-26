import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  AccountProfile, AccountQuota, AccountQuotaUnavailableReason, QuotaBucket,
} from '../../shared/accounts-history-contract';
import { discoverAgyBinary } from '../acp/acp-client';
import { buildAgyEnvironment } from '../acp/agy-environment';
import { createAccountTempDirectory, readAccountTempFile } from './account-temp';

const exec = promisify(execFile);
export class AccountQuotaUnavailable extends Error {
  constructor(readonly reason: AccountQuotaUnavailableReason) { super('Account quota is unavailable: ' + reason); }
}

/** The public status line can lack a reading for reasons other than an expired login. */
export class MacQuotaNotReported extends Error {
  constructor(readonly code: 1 | 2) {
    super(code === 2 ? '等待官方状态栏返回额度超时，请稍后刷新。' : '当前账号未返回额度。请检查官方 agy 登录状态后刷新。');
  }
}
const statusCommand = [
  "$ErrorActionPreference='Stop'",
  '$j=([Console]::In.ReadToEnd() | ConvertFrom-Json)',
  `function Test-QuotaNumber($value) {
    ($value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [decimal]) -and
      ![double]::IsNaN([double]$value) -and ![double]::IsInfinity([double]$value)
  }`,
  `$buckets = @(foreach ($prop in $j.quota.PSObject.Properties) {
    $v = $prop.Value
    $bucket = @{ id=$prop.Name; disabled=($v.disabled -is [bool] -and $v.disabled) }
    if ((Test-QuotaNumber $v.remaining_fraction) -and $v.remaining_fraction -ge 0 -and $v.remaining_fraction -le 1) { $bucket.remainingFraction=$v.remaining_fraction }
    if ((Test-QuotaNumber $v.remaining_amount) -and $v.remaining_amount -ge 0) { $bucket.remainingAmount=$v.remaining_amount }
    if (!$bucket.disabled -and !$bucket.ContainsKey('remainingAmount') -and !$bucket.ContainsKey('remainingFraction')) { continue }
    $reset=[DateTimeOffset]::MinValue
    if ($v.reset_time -is [string] -and [DateTimeOffset]::TryParse($v.reset_time,[ref]$reset)) { $bucket.resetAt=$reset.UtcDateTime.ToString('o') }
    elseif ((Test-QuotaNumber $v.reset_in_seconds) -and $v.reset_in_seconds -ge 0) { try { $bucket.resetAt=[DateTime]::UtcNow.AddSeconds($v.reset_in_seconds).ToString('o') } catch {} }
    $bucket
  })`,
  `if ($buckets.Count -gt 0 -and ![IO.File]::Exists($env:GRAVITY_QUOTA_RESULT)) {
    $stage = $env:GRAVITY_QUOTA_RESULT + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
      $snapshot=@{buckets=$buckets}
      if ($j.plan_tier -is [string]) { $snapshot.plan=$j.plan_tier }
      [IO.File]::WriteAllText($stage, ($snapshot | ConvertTo-Json -Compress -Depth 4))
      try { [IO.File]::Move($stage, $env:GRAVITY_QUOTA_RESULT) }
      catch [IO.IOException] { if (![IO.File]::Exists($env:GRAVITY_QUOTA_RESULT)) { throw } }
    } finally { [IO.File]::Delete($stage) }
  }`,
  "Write-Output 'Gravity'",
].join('; ');
const macStatusCallback = 'exec /usr/bin/osascript -l JavaScript "$GRAVITY_QUOTA_CALLBACK" "$GRAVITY_QUOTA_RESULT"';
const windowsStatusCallback = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(statusCommand, 'utf16le').toString('base64');

function quotaSettings(callback: string): string {
  return JSON.stringify({ statusLine: { type: 'command', command: callback, enabled: true } });
}

/** This is the public status-line CLI, not an ACP invocation. Only the bundled callback is allowed. */
function validateQuotaArgs(args: readonly string[]): string[] {
  const callback = process.platform === 'darwin' ? macStatusCallback : windowsStatusCallback;
  if (args.length !== 2 || args[0] !== '--settings' || args[1] !== quotaSettings(callback)) throw new Error('不支持的官方额度查询参数');
  return [...args];
}

function windowsArg(value: string) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function parseQuota(data: { quota?: unknown; buckets?: unknown; plan?: unknown }, profileId: string, now = new Date()): AccountQuota {
  const buckets: QuotaBucket[] = [];
  const entries = Array.isArray(data?.buckets) ? data.buckets.flatMap(b => typeof b?.id === 'string'
    ? [[b.id, { remaining_fraction: b.remainingFraction, remaining_amount: b.remainingAmount, reset_time: b.resetAt, disabled: b.disabled }] as const] : [])
    : Object.entries(data?.quota || {});
  for (const [id, raw] of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const remainingFraction = finite(v.remaining_fraction) && v.remaining_fraction >= 0 && v.remaining_fraction <= 1 ? v.remaining_fraction : undefined;
    const remainingAmount = finite(v.remaining_amount) && v.remaining_amount >= 0 ? v.remaining_amount : undefined;
    const resetMs = typeof v.reset_time === 'string' ? Date.parse(v.reset_time) : NaN;
    const reset = Number.isFinite(resetMs) ? resetMs : finite(v.reset_in_seconds) && v.reset_in_seconds >= 0 ? now.getTime() + 1000 * v.reset_in_seconds : NaN;
    if (remainingFraction === undefined && remainingAmount === undefined && v.disabled !== true) continue;
    buckets.push({ id, remainingFraction, remainingAmount, disabled: v.disabled === true,
      resetAt: Number.isFinite(new Date(reset).getTime()) ? new Date(reset).toISOString() : undefined });
  }
  if (!buckets.length) throw new Error('官方客户端未返回可用额度，请检查登录状态后刷新。');
  return { profileId, buckets, checkedAt: now.toISOString(), plan: typeof data.plan === 'string' ? data.plan : undefined };
}

const cleanupDelaysMs = [200, 800, 2_000, 5_000, 12_000];
const transientCleanupErrors = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** A status-line process or a file scanner can briefly hold this private directory on Windows. */
async function removeQuotaWorkspace(directory: string, identity: BigIntStats, attempt = 0): Promise<void> {
  try {
    const current = await lstat(directory, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev
      || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) return;
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    const delay = cleanupDelaysMs[attempt];
    if (delay === undefined || !transientCleanupErrors.has((error as NodeJS.ErrnoException).code || '')) return;
    setTimeout(() => { void removeQuotaWorkspace(directory, identity, attempt + 1); }, delay).unref();
  }
}

type QuotaProbe = (directory: string, result: string, seconds: number) => Promise<unknown>;

/** Each query owns one fresh workspace. Only the public status-line timeout is retried. */
export async function queryQuotaSnapshot(profileId: string, temporaryRoot: string, probe: QuotaProbe): Promise<AccountQuota> {
  const temporaryFailure = () => { throw new Error('无法准备额度查询临时目录，请检查临时目录权限。'); };
  const directory = await createAccountTempDirectory(temporaryRoot, 'gravity-quota-').catch(temporaryFailure);
  const identity = await lstat(directory, { bigint: true }).catch(async () => {
    await rmdir(directory).catch(() => {});
    return temporaryFailure();
  });
  const result = join(directory, 'quota.json');
  try {
    try { await probe(directory, result, 14); }
    catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 2) throw error;
      await probe(directory, result, 24);
    }
    let record: { quota?: unknown; plan?: unknown };
    try { record = JSON.parse(await readAccountTempFile(result, 1024 * 1024)); }
    catch { throw new Error('官方额度记录未能读取，请稍后刷新。'); }
    return parseQuota(record, profileId);
  } finally {
    // Normal quit can exit the process as soon as this query settles.
    await removeQuotaWorkspace(directory, identity);
  }
}

/** Wait for the supervisor's cleanup before returning from an abort or a timeout. */
export function waitForMacQuotaProbe(child: ChildProcess, seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveProbe, reject) => {
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      force = setTimeout(() => child.kill('SIGKILL'), 3_000);
      force.unref();
      child.kill('SIGTERM');
    };
    const abort = () => stop(new Error('额度查询已取消。'));
    const deadline = setTimeout(() => stop(new Error('额度读取超时，请稍后刷新。')), (seconds + 6) * 1000);
    const onError = () => settle(null, new Error('无法启动 macOS 额度查询脚本，请检查安装后再试。'));
    const onClose = (code: number | null) => settle(code);
    const settle = (code: number | null, error?: Error) => {
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      clearTimeout(deadline);
      clearTimeout(force);
      signal?.removeEventListener('abort', abort);
      child.stdin?.destroy();
      if (failure || error) reject(failure ?? error);
      else if (code === 0) resolveProbe();
      else if (code === 1 || code === 2) reject(new MacQuotaNotReported(code));
      else if (code === 3) reject(new AccountQuotaUnavailable('helper'));
      else if (code === 4) reject(new Error('无法启动官方 agy，请检查 AGY_BINARY_PATH 和执行权限。'));
      else reject(new Error('macOS 额度查询脚本未能完成，请检查终端工具后刷新。'));
    };
    child.once('error', onError);
    child.once('close', onClose);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function runMacQuotaProbe(binary: string, directory: string, result: string, seconds: number, signal?: AbortSignal, assertAllowed?: () => void): Promise<void> {
  const assets = resolve(__dirname, '../../../assets/quota');
  const supervisor = join(assets, 'read-quota-macos.sh');
  try { await access(supervisor, constants.R_OK); }
  catch { throw new AccountQuotaUnavailable('helper'); }
  if (signal?.aborted) throw new Error('额度查询已取消。');
  const flags = validateQuotaArgs(['--settings', quotaSettings(macStatusCallback)]);
  assertAllowed?.();
  const child = spawn('/bin/sh', [supervisor, binary, ...flags], {
    shell: false, cwd: directory, stdio: 'ignore',
    env: { ...buildAgyEnvironment(binary), GRAVITY_QUOTA_CALLBACK: join(assets, 'status-line-macos.js'), GRAVITY_QUOTA_CWD: directory,
      GRAVITY_QUOTA_RESULT: result, GRAVITY_QUOTA_WAIT: String(seconds) },
  });
  return waitForMacQuotaProbe(child, seconds, signal);
}

export async function readAccountQuota(profile: AccountProfile, configured?: string, signal?: AbortSignal, assertAllowed?: () => void): Promise<AccountQuota> {
  assertAllowed?.();
  if (!profile.isDefault) throw new AccountQuotaUnavailable('profile');
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw new AccountQuotaUnavailable('platform');
  if (signal?.aborted) throw new Error('额度查询已取消。');
  const binary = discoverAgyBinary(configured);
  if (process.platform === 'darwin') {
    return queryQuotaSnapshot(profile.profileId, tmpdir(), (directory, result, seconds) =>
      runMacQuotaProbe(binary, directory, result, seconds, signal, assertAllowed));
  }
  const script = resolve(__dirname, '../../../assets/quota/read-quota.ps1');
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const flags = validateQuotaArgs(['--settings', quotaSettings(windowsStatusCallback)]);
  return queryQuotaSnapshot(profile.profileId, tmpdir(), async (directory, result, seconds) => {
    assertAllowed?.();
    try {
      await exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true, shell: false, signal, cwd: dirname(script), timeout: (seconds + 14) * 1000, maxBuffer: 64 * 1024,
        env: { ...buildAgyEnvironment(binary), GRAVITY_QUOTA_WAIT: String(seconds), GRAVITY_QUOTA_BINARY: binary, GRAVITY_QUOTA_RESULT: result, GRAVITY_QUOTA_CWD: directory,
          GRAVITY_QUOTA_COMMAND: [binary, ...flags].map(windowsArg).join(' ') },
      });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
      if (signal?.aborted || failure.name === 'AbortError' || failure.code === 'ABORT_ERR') throw new Error('额度查询已取消。');
      if (failure.killed || failure.code === 'ETIMEDOUT') throw new Error('额度查询超时，请稍后刷新。');
      const detail = [failure.stderr, failure.message].join(' ');
      if (/PSSecurityException|UnauthorizedAccess|execution polic|running scripts is disabled|执行策略|禁止运行脚本/i.test(detail)) {
        throw new Error('Windows 安全策略阻止了官方额度查询脚本，请检查 PowerShell 执行策略。');
      }
      if (/\b(?:unauthenticated|not logged in|login required|401)\b|未登录/i.test(detail)) throw new Error('官方 agy 尚未登录，请完成官方登录后刷新。');
      if (Number(failure.code) === 2) throw Object.assign(new Error('等待官方状态栏返回额度超时，请稍后刷新。'), { code: 2 });
      throw new Error('无法运行官方额度查询程序，请检查 agy 和 PowerShell 是否可用。');
    }
  });
}
