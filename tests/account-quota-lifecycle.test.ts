// @vitest-environment node
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { queryQuotaSnapshot, readAccountQuota } from '../src/main/accounts/account-quota';

const fraction = JSON.stringify({ quota: { five: { remaining_fraction: 0.5 } } });
const windows = process.platform === 'win32';
const helperPath = resolve('assets/quota/read-quota.ps1');
const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

async function withFixture(run: (root: string) => Promise<void>) {
  const repository = await realpath(process.cwd());
  const prefix = '.quota-lifecycle-test-';
  const root = await mkdtemp(join(repository, prefix));
  try {
    await run(root);
  } finally {
    const owned = await realpath(root);
    expect(dirname(owned)).toBe(repository);
    expect(basename(owned)).toMatch(/^\.quota-lifecycle-test-[a-z0-9]+$/i);
    await rm(owned, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
  }
}

function pause(ms: number): Promise<void> {
  // Timers used by the application are accelerated in the bounded-retry tests.
  return new Promise(done => {
    const interval = setInterval(() => { clearInterval(interval); done(); }, ms);
  });
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for quota fixture');
    await pause(15);
  }
}

// An ordinary Windows process holding the directory as its CWD produces EBUSY on rmdir.
async function holdDirectory(directory: string) {
  const child = spawn(process.execPath, ['-e', [
    "process.stdout.write('ready');",
    "process.stdin.on('end', () => process.exit(0)).resume();",
    'setTimeout(() => process.exit(0), 15000);',
  ].join('')], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = once(child, 'close');
  await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('Lock fixture exited early'); })]);
  return async () => { child.stdin.end(); await closed; };
}

describe('quota query result and cleanup', () => {
  it('retries only the public status timeout and preserves record-specific errors', async () => {
    await withFixture(async root => {
      const attempts: number[] = [];
      const snapshot = await queryQuotaSnapshot('test', root, async (_directory, result, seconds) => {
        attempts.push(seconds);
        if (attempts.length === 1) throw Object.assign(new Error('status timeout'), { code: 2 });
        await writeFile(result, fraction);
      });
      expect(attempts).toEqual([14, 24]);
      expect(snapshot.buckets[0].remainingFraction).toBe(0.5);
      await expect(queryQuotaSnapshot('test', root, async () => {})).rejects.toThrow('官方额度记录未能读取');
      await expect(queryQuotaSnapshot('test', root, async (_directory, result) => {
        await writeFile(result, '{"quota":{}}');
      })).rejects.toThrow('官方客户端未返回可用额度');
    });
  });

  it.runIf(windows).each(['success', 'failure'])('keeps %s while another process holds its Windows directory', async outcome => {
    await withFixture(async root => {
      const sibling = join(root, 'unrelated.txt');
      await writeFile(sibling, 'unrelated');
      const original = new Error('fixture login unavailable');
      let directory = '';
      let release: (() => Promise<void>) | undefined;
      try {
        const query = queryQuotaSnapshot('test', root, async (work, result) => {
          directory = work;
          release = await holdDirectory(work);
          if (outcome === 'failure') throw original;
          await writeFile(result, fraction);
        });
        if (outcome === 'success') expect((await query).buckets[0].remainingFraction).toBe(0.5);
        else await expect(query).rejects.toBe(original);
        await expect(rm(directory, { recursive: true })).rejects.toMatchObject({ code: 'EBUSY' });
      } finally {
        await release?.();
      }
      await until(() => !existsSync(directory));
      expect(await readFile(sibling, 'utf8')).toBe('unrelated');
    });
  });

  it.runIf(windows).each(['stays locked', 'is replaced'])('bounds cleanup when the directory %s', async scenario => {
    await withFixture(async root => {
      let directory = '';
      let release: (() => Promise<void>) | undefined;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await queryQuotaSnapshot('test', root, async (work, result) => {
          directory = work;
          release = await holdDirectory(work);
          await writeFile(result, fraction);
        });
        await until(() => vi.getTimerCount() === 1);
        if (scenario === 'is replaced') {
          await release?.();
          release = undefined;
          await rename(directory, join(root, 'original'));
          await mkdir(directory);
          const unrelated = join(directory, 'other-owner');
          await writeFile(unrelated, 'keep');
          await vi.advanceTimersByTimeAsync(200);
          await pause(120);
          expect(await readFile(unrelated, 'utf8')).toBe('keep');
        } else {
          for (const delay of [200, 800, 2_000, 5_000, 12_000]) {
            await until(() => vi.getTimerCount() === 1);
            await vi.advanceTimersByTimeAsync(delay);
          }
          await pause(120);
          expect(existsSync(directory)).toBe(true);
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        await release?.();
      }
    });
  });
});

const familyScript = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [control, role, mode] = process.argv.slice(2);
fs.writeFileSync(path.join(control, role + '.pid'), String(process.pid));
const next = { root: 'child', child: 'grandchild' }[role];
if (next) spawn(process.execPath, [__filename, control, next, mode], { stdio: 'ignore', windowsHide: true });
const deadline = Date.now() + 15000;
let published = false;
setInterval(() => {
  if (fs.existsSync(path.join(control, 'release')) || Date.now() > deadline) process.exit(0);
  if (role === 'root' && mode === 'success' && !published && fs.existsSync(path.join(control, 'grandchild.pid'))) {
    fs.writeFileSync(process.env.GRAVITY_QUOTA_RESULT, JSON.stringify({ quota: { five: { remaining_fraction: 0.5 } } }));
    published = true;
  }
}, 20);
`;

function running(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

// A private offline CLI feeds the genuine generated status-line command empty and repeated snapshots.
const statusLineFixture = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

class FixtureQuota {
  static int Main(string[] args) {
    if (args.Length != 2 || args[0] != "--settings") return 11;
    string encoded = Regex.Match(args[1], @"-EncodedCommand ([A-Za-z0-9+/=]+)").Groups[1].Value;
    if (encoded.Length == 0) return 12;
    string result = Environment.GetEnvironmentVariable("GRAVITY_QUOTA_RESULT");
    string captured = result + ".fixture";
    string shell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
    var inputs = new[] {
      @"{""quota"":{}}",
      @"{""quota"":{""five"":{""remaining_fraction"":1.5},""odd"":{""disabled"":""yes""}}}",
      @"{""plan_tier"":""Fixture"",""quota"":{""five"":{""remaining_fraction"":0.5}}}",
      @"{""plan_tier"":""Later"",""quota"":{""five"":{""remaining_fraction"":0.25}}}"
    };
    foreach (string input in inputs) {
      var start = new ProcessStartInfo(shell, "-NoProfile -NonInteractive -EncodedCommand " + encoded);
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      start.RedirectStandardInput = true;
      start.EnvironmentVariables["GRAVITY_QUOTA_RESULT"] = captured;
      using (var child = Process.Start(start)) {
        child.StandardInput.WriteLine(input);
        child.StandardInput.Close();
        if (!child.WaitForExit(7000) || child.ExitCode != 0) return 13;
      }
    }
    if (Directory.GetFiles(Path.GetDirectoryName(result), "*.tmp").Length != 0) return 14;
    File.Move(captured, result);
    return 0;
  }
}
`;

describe.runIf(windows)('Windows quota helper process lifetime', () => {
  it('reads the first usable public status line through the application entry point', async () => {
    await withFixture(async root => {
      const executable = join(root, 'agy.exe');
      const source = join(root, 'FixtureQuota.cs');
      await writeFile(source, statusLineFixture);
      await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:FIXTURE_SOURCE)) -OutputAssembly $env:FIXTURE_EXE -OutputType ConsoleApplication'], {
        cwd: root, windowsHide: true, timeout: 15_000,
        env: { ...process.env, TEMP: root, TMP: root, FIXTURE_SOURCE: source, FIXTURE_EXE: executable },
      });
      vi.stubEnv('TEMP', root);
      vi.stubEnv('TMP', root);
      try {
        const result = await readAccountQuota({ profileId: 'test', name: 'Fixture', isDefault: true,
          createdAt: '', lastActivatedAt: '' }, executable);
        expect(result).toMatchObject({ profileId: 'test', plan: 'Fixture', buckets: [{ id: 'five', remainingFraction: 0.5 }] });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  }, 25_000);

  it.each(['success', 'timeout', 'host-closed'])('releases only its own three-generation process tree on %s', async mode => {
    await withFixture(async root => {
      const work = join(root, 'owned-work');
      const result = join(work, 'quota.json');
      const fixture = join(root, 'family.cjs');
      await mkdir(work);
      await writeFile(fixture, familyScript);
      const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: root, windowsHide: true });
      const unrelatedClosed = once(unrelated, 'close');
      const host = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', helperPath], {
        cwd: dirname(helperPath), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, TEMP: root, TMP: root, GRAVITY_QUOTA_CWD: work, GRAVITY_QUOTA_RESULT: result,
          GRAVITY_QUOTA_BINARY: process.execPath, GRAVITY_QUOTA_WAIT: mode === 'timeout' ? '3' : '9',
          GRAVITY_QUOTA_COMMAND: [process.execPath, fixture, root, 'root', mode].map(part => '"' + part + '"').join(' ') },
      });
      const hostClosed = once(host, 'close');
      let stderr = '';
      host.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      try {
        await until(() => existsSync(join(root, 'grandchild.pid')));
        const pids = await Promise.all(['root', 'child', 'grandchild'].map(async role => Number(await readFile(join(root, role + '.pid'), 'utf8'))));
        expect(pids.every(pid => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
        if (mode === 'host-closed') expect(host.kill()).toBe(true);
        const [code] = await hostClosed;
        expect(stderr).toBe('');
        if (mode === 'success') {
          expect(code).toBe(0);
          expect(await readFile(result, 'utf8')).toBe(fraction);
        }
        if (mode === 'timeout') expect(code).toBe(2);
        await until(() => pids.every(pid => !running(pid)));
        expect(unrelated.pid && running(unrelated.pid)).toBe(true);
        await rm(work, { recursive: true, maxRetries: 15, retryDelay: 100 });
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill();
        await hostClosed;
        await writeFile(join(root, 'release'), '');
        unrelated.kill();
        await unrelatedClosed;
      }
    });
  }, 20_000);
});
