// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { readAccountQuota, runMacQuotaProbe, waitForMacQuotaProbe } from '../src/main/accounts/account-quota';
import * as quotaReader from '../src/main/accounts/account-quota';
import { CoreService } from '../src/main/core-service';

const sample = { product: 'unused', email: 'private@example.invalid', cwd: '/private/workspace', plan_tier: 'Fixture',
  quota: { 'gemini-weekly': { remaining_fraction: 0, reset_in_seconds: 60, extra: 'private' },
    amount: { remaining_amount: 5 }, off: { disabled: true }, waiting: {}, invalid: { remaining_fraction: 2 } } };
const projected = { plan: 'Fixture', quota: { 'gemini-weekly': { remaining_fraction: 0, reset_in_seconds: 60 },
  amount: { remaining_amount: 5 }, off: { disabled: true } } };

it('the shipped status-line callback extracts only usable public quota fields from a partial or complete payload', async () => {
  const source = await readFile(resolve('assets/quota/status-line-macos.js'), 'utf8');
  const select = runInNewContext(source + '\nquotaSnapshot', { ObjC: { import() {} } });
  expect(select({ quota: { starting: { remaining_amount: null } } })).toBeNull();
  expect(JSON.parse(JSON.stringify(select(sample)))).toEqual(projected);
});

it('preserves helper-unavailable, timeout and explicit cancellation as distinct outcomes across the process boundary', async () => {
  const start = (code: number) => spawn(process.execPath, ['-e', 'process.exit(' + code + ')'], { stdio: 'ignore', windowsHide: true });
  await expect(waitForMacQuotaProbe(start(0), 2)).resolves.toBeUndefined();
  await expect(waitForMacQuotaProbe(start(3), 2)).rejects.toMatchObject({ reason: 'helper' });
  await expect(waitForMacQuotaProbe(start(2), 2)).rejects.toMatchObject({ code: 2 });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const controller = new AbortController();
  const done = waitForMacQuotaProbe(child, 2, controller.signal);
  controller.abort();
  await expect(done).rejects.toThrow('额度查询已取消');
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it.each(['switch', 'quit'])('waits for one shared in-flight quota query to release its resources on %s', async action => {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-quota-core-'));
  const service = new CoreService({ dataDir: directory, homeDir: join(directory, 'home') });
  let released = false;
  const probe = vi.spyOn(quotaReader, 'readAccountQuota').mockImplementation(async (profile, _, signal) => {
    if (!profile.isDefault) throw new quotaReader.AccountQuotaUnavailable('profile');
    return new Promise((_, reject) => signal!.addEventListener('abort', () => {
      setTimeout(() => { released = true; reject(new Error('cancelled probe')); }, 15);
    }, { once: true }));
  });
  vi.spyOn(service.client, 'start').mockResolvedValue({ protocolVersion: 1, agentInfo: { name: 'fixture', version: '1' }, agentCapabilities: {} });
  let disposed = false;
  try {
    const results = Promise.allSettled([service.getAccountQuota(), service.getAccountQuota()]);
    expect(probe).toHaveBeenCalledTimes(1);
    if (action === 'quit') {
      await service.dispose();
      disposed = true;
    } else {
      const accounts = await service.createAccountProfile({ name: 'Other' });
      const other = accounts.profiles.find(profile => !profile.isDefault)!;
      await service.switchAccountProfile(other.profileId);
      expect(await service.getAccountQuota()).toEqual({ profileId: other.profileId, unavailable: 'profile' });
    }
    expect(released).toBe(true);
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
  } finally {
    if (!disposed) await service.dispose();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const groupAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
};

async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for the test process');
}

// Uses Darwin's real /usr/bin/script PTY and Foundation callback, with a local fake named agy.
// The fixture checks the argument vector and the terminal; no sign-in, network, or model is used.
it.runIf(process.platform === 'darwin').each(['success', 'timeout', 'cancel', 'supervisor-exit'])(
  'macOS PTY quota query — %s', async scenario => {
    const dir = await mkdtemp(join(tmpdir(), "Gravity quota's fixture-"));
    const binary = join(dir, 'agy');
    const idsFile = join(dir, 'owned-pids.json');
    const script = join(dir, 'fake-cli.cjs');
    const saved = join(dir, 'callback.json');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const unrelatedDone = new Promise<void>(done => unrelated.once('close', () => done()));
    const controller = new AbortController();
    try {
      await writeFile(binary, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' "$@"\n');
      await chmod(binary, 0o700);
      await writeFile(script, [
        "const fs = require('node:fs'), cp = require('node:child_process');",
        "if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv[2] !== '--settings') process.exit(1);",
        "const worker = cp.spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"], {stdio:'ignore'});",
        "const ids = {cli:process.pid, worker:worker.pid, supervisor:Number(process.env.GRAVITY_QUOTA_SUPERVISOR)};",
        'fs.writeFileSync(' + JSON.stringify(idsFile + '.tmp') + ', JSON.stringify(ids)); fs.renameSync(' +
          JSON.stringify(idsFile + '.tmp') + ', ' + JSON.stringify(idsFile) + ');',
        "const command = JSON.parse(process.argv[3]).statusLine.command;",
        "function callback(data) { return cp.execFileSync('/bin/sh', ['-c',command], {input:JSON.stringify(data),encoding:'utf8'}).trim(); }",
        "if (callback({quota:{starting:{}}}) !== 'Gravity' || fs.existsSync(process.env.GRAVITY_QUOTA_RESULT)) process.exit(1);",
        ...(scenario === 'success' ? ['if (callback(' + JSON.stringify(sample) + ") !== 'Gravity') process.exit(1);"] : []),
        'setInterval(()=>{},1000);',
      ].join('\n'));
      const work = scenario === 'success'
        ? readAccountQuota({ profileId: 'default', name: 'Fixture', isDefault: true, createdAt: '', lastActivatedAt: '' }, binary, controller.signal)
        : runMacQuotaProbe(binary, dir, join(dir, 'quota.json'), scenario === 'timeout' ? 3 : 15, controller.signal);
      // Attach a handler before waiting for the fixture to publish its PID.
      let earlyOutcome: { value: unknown; error: Error | undefined } | undefined;
      const complete = work.then(
        value => (earlyOutcome = { value, error: undefined }),
        (error: Error) => (earlyOutcome = { value: undefined, error })
      );
      await until(async () => {
        try { await readFile(idsFile); return true; }
        catch {
          if (earlyOutcome) throw earlyOutcome.error ?? new Error('Quota probe exited before writing fixture PIDs');
          return false;
        }
      });
      const ids = JSON.parse(await readFile(idsFile, 'utf8')) as { cli: number; worker: number; supervisor: number };
      if (scenario === 'cancel') controller.abort();
      if (scenario === 'supervisor-exit') process.kill(ids.supervisor, 'SIGKILL');
      const { value, error } = await complete;
      if (scenario === 'success') {
        expect(error).toBeUndefined();
        expect(value).toMatchObject({ profileId: 'default', plan: 'Fixture', buckets: expect.arrayContaining([
          expect.objectContaining({ id: 'gemini-weekly', remainingFraction: 0 })]) });
        const callback = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', resolve('assets/quota/status-line-macos.js'), saved], {
          input: JSON.stringify(sample), encoding: 'utf8', timeout: 5000,
        });
        expect(callback.status, callback.stderr).toBe(0);
        expect(JSON.parse(await readFile(saved, 'utf8'))).toEqual(projected);
      } else if (scenario === 'timeout') expect(error).toMatchObject({ code: 2 });
      else expect(error).toBeInstanceOf(Error);
      await until(async () => !groupAlive(ids.cli) && !groupAlive(ids.worker));
      expect(groupAlive(unrelated.pid!)).toBe(true);
    } finally {
      controller.abort();
      unrelated.kill();
      await unrelatedDone;
      await rm(dir, { recursive: true, force: true });
    }
  }, 25_000);
