import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AccountProfile, AccountQuota, QuotaBucket } from '../../shared/accounts-history-contract';
import { discoverAgyBinary } from '../acp/acp-client';

const exec = promisify(execFile);
const statusCommand = [
  "$ErrorActionPreference='Stop'",
  '$j=([Console]::In.ReadToEnd() | ConvertFrom-Json)',
  "$ready = @($j.quota.PSObject.Properties | Where-Object { $null -ne $_.Value.remaining_fraction -or $null -ne $_.Value.remaining_amount -or $_.Value.disabled -eq $true }).Count -gt 0",
  "if ($ready) { [IO.File]::WriteAllText($env:GRAVITY_QUOTA_RESULT, (@{quota=$j.quota;plan=$j.plan_tier} | ConvertTo-Json -Compress -Depth 6)) }",
  "Write-Output 'Gravity'",
].join('; ');
function windowsArg(value: string) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function parseQuota(data: { quota?: unknown; plan?: unknown }, profileId: string, now = new Date()): AccountQuota {
  const buckets: QuotaBucket[] = [];
  for (const [id, raw] of Object.entries(data?.quota || {})) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const remainingFraction = finite(v.remaining_fraction) && v.remaining_fraction >= 0 && v.remaining_fraction <= 1 ? v.remaining_fraction : undefined;
    const remainingAmount = finite(v.remaining_amount) && v.remaining_amount >= 0 ? v.remaining_amount : undefined;
    const resetMs = typeof v.reset_time === 'string' ? Date.parse(v.reset_time) : NaN;
    const reset = Number.isFinite(resetMs) ? resetMs : finite(v.reset_in_seconds) && v.reset_in_seconds >= 0 ? now.getTime() + 1000 * v.reset_in_seconds : NaN;
    if (remainingFraction === undefined && remainingAmount === undefined && !v.disabled) continue;
    buckets.push({ id, remainingFraction, remainingAmount, disabled: v.disabled === true,
      resetAt: Number.isFinite(new Date(reset).getTime()) ? new Date(reset).toISOString() : undefined });
  }
  if (!buckets.length) throw new Error('官方客户端未返回可用额度，请检查登录状态后刷新。');
  return { profileId, buckets, checkedAt: now.toISOString(), plan: typeof data.plan === 'string' ? data.plan : undefined };
}

export async function readAccountQuota(profile: AccountProfile, configured?: string): Promise<AccountQuota> {
  if (process.platform !== 'win32') throw new Error('当前官方额度自动读取仅支持 Windows 客户端，macOS 请在终端运行 agy 查看额度。');
  if (!profile.isDefault) throw new Error('当前官方 CLI 的额度入口只支持默认登录资料，暂无法查询此独立资料。');
  const binary = discoverAgyBinary(configured);
  const dir = await mkdtemp(join(tmpdir(), 'gravity-quota-'));
  const result = join(dir, 'quota.json');
  const script = resolve(__dirname, '../../../assets/quota/read-quota.ps1');
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(statusCommand, 'utf16le').toString('base64');
  const flags = ['--settings', JSON.stringify({ statusLine: { type: 'command', command, enabled: true } })];
  try {
    const read = (seconds: number) => exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', script], {
      windowsHide: true, cwd: dir, timeout: (seconds + 14) * 1000, maxBuffer: 64 * 1024,
      env: { ...process.env, GRAVITY_QUOTA_WAIT: String(seconds), GRAVITY_QUOTA_BINARY: binary, GRAVITY_QUOTA_RESULT: result, GRAVITY_QUOTA_CWD: dir,
        GRAVITY_QUOTA_COMMAND: [binary, ...flags].map(windowsArg).join(' ') },
    });
    try { await read(14); }
    catch (error) {
      // The status line may not publish a snapshot during the first launch after sign-in.
      if ((error as { code?: number }).code !== 2) throw error;
      await read(24);
    }
    return parseQuota(JSON.parse(await readFile(result, 'utf8')), profile.profileId);
  } catch {
    throw new Error('当前账号未返回额度。请确认已登录官方 agy，再点击刷新。');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
}
