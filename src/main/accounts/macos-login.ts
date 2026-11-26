import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { buildAgyEnvironment } from '../acp/agy-environment';
import { createAccountTempDirectory, readAccountTempFile } from './account-temp';
import { LocalFileChangedError } from '../workspace/local-path-safety';
import type { ClientLocale } from '../../shared/theme-i18n-contract';

const execFileAsync = promisify(execFile);

export function posixSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

interface MacLoginOptions {
  tempDir: string;
  signal: AbortSignal;
  locale?: ClientLocale;
  openTerminal?: (scriptPath: string, signal: AbortSignal, timeout: number) => Promise<void>;
  startupTimeoutMs?: number;
  loginTimeoutMs?: number;
  pollMs?: number;
}

function loginScript(dir: string, binary: string, args: string[]): string {
  const env = buildAgyEnvironment(binary);
  const hostAlive = process.platform === 'darwin' ? `kill -0 ${process.pid} 2>/dev/null` : 'true';
  return [
    '#!/bin/sh',
    'umask 077',
    `dir=${posixSingleQuote(dir)}`,
    'cd "$dir" || exit 1',
    'export PATH=' + posixSingleQuote(env.PATH || '') + '${PATH:+":$PATH"}',
    'owner=$$',
    'child=',
    'guard=',
    `host_alive() { ${hostAlive}; }`,
    'active() { [ -f Login.command ] && host_alive; }',
    'trap \'if ! host_alive; then /bin/rm -f Login.command state.tmp state; /bin/rmdir "$dir" 2>/dev/null; fi\' 0',
    'record() { printf "%s\\n" "$1" > state.tmp && /bin/mv -f state.tmp state; }',
    'owned_child() {',
    '  [ -n "$child" ] && [ "$(/bin/ps -o ppid= -p "$child" 2>/dev/null)" -eq "$owner" ] 2>/dev/null',
    '}',
    'stop_child() {',
    '  if owned_child; then',
    '    kill -TERM "$child" 2>/dev/null',
    '    /bin/sleep 1',
    '    if owned_child; then kill -KILL "$child" 2>/dev/null; fi',
    '  fi',
    '}',
    'stop_guard() { if [ -n "$guard" ]; then kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null; fi; }',
    'cancel() { trap "" HUP INT TERM; stop_guard; stop_child; record cancelled; exit 130; }',
    'trap cancel HUP INT TERM',
    'record "running $owner" || exit 1',
    'active || { record cancelled; exit 130; }',
    // Explicitly inherit the terminal input for the asynchronous child (POSIX sh otherwise uses /dev/null).
    'exec 3<&0',
    [binary, ...args].map(posixSingleQuote).join(' ') + ' <&3 3<&- &',
    'child=$!',
    'exec 3<&-',
    // Removing the command cancels a pending launch and tells an active guard to stop its own CLI.
    '( while active && kill -0 "$owner" 2>/dev/null; do /bin/sleep 1; done; stop_child ) &',
    'guard=$!',
    'wait "$child"',
    'code=$?',
    'child=',
    'stop_guard',
    'case "$code" in 129|130|143) record cancelled ;; *) record "exit $code" ;; esac',
    'exit "$code"',
    '',
  ].join('\n');
}

async function readState(file: string): Promise<string> {
  try { return (await readAccountTempFile(file, 64)).trim(); }
  catch (error) {
    // The wrapper publishes its exit state by atomically renaming over the running state.
    if (error instanceof LocalFileChangedError || (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function cancelLoginCommand(scriptPath: string, stateFile: string): Promise<void> {
  await fs.rm(scriptPath, { force: true });
  const state = await readState(stateFile);
  const running = /^running ([1-9]\d*)$/.exec(state);
  if (!running) return;
  const pid = Number(running[1]);
  if (pid === process.pid || pid <= 1 || !Number.isSafeInteger(pid)) return;
  // Keep the private status file available until the wrapper has reaped the CLI.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && isRunning(pid)) {
    if (await readState(stateFile) !== state) return;
    await delay(50);
  }
}

/** The macOS open helper only acknowledges launching Terminal. The command itself reports the CLI's exit status. */
export async function runMacTerminalLogin(binary: string, args: string[], options: MacLoginOptions): Promise<void> {
  const english = options.locale === 'en-US';
  const cancelled = () => new Error(english ? 'Official login was cancelled or the Terminal window was closed.' : '官方登录已取消，或登录终端已关闭。');
  const startupTimeout = () => new Error(english ? 'Terminal did not start the official login in time. Open Terminal and try again.' : '登录终端启动超时。请确认“终端”能够打开后重试。');
  const tempFailure = () => {
    throw new Error(english ? 'Could not access the temporary login files. Check the temporary directory permissions.' : '无法访问官方登录临时文件，请检查临时目录权限。');
  };
  const signal = options.signal;
  if (signal.aborted) throw cancelled();
  const startupMs = options.startupTimeoutMs ?? 60_000;
  const directory = await createAccountTempDirectory(options.tempDir, 'gravity-login-').catch(tempFailure);
  const scriptPath = join(directory, 'Login.command');
  const stateFile = join(directory, 'state');
  const status = () => readState(stateFile).catch(tempFailure);
  const open = options.openTerminal ?? (async (script: string, abort: AbortSignal, timeout: number) => {
    await execFileAsync('/usr/bin/open', ['-a', 'Terminal', script], { signal: abort, timeout, shell: false });
  });
  try {
    await fs.writeFile(scriptPath, loginScript(directory, binary, args), { mode: 0o700, flag: 'wx' }).catch(tempFailure);
    if (signal.aborted) throw cancelled();
    let deadline = Date.now() + startupMs;
    try { await open(scriptPath, signal, startupMs); }
    catch (error) {
      const launch = error as { code?: unknown; killed?: boolean; stderr?: string; name?: string } | null;
      if (signal.aborted || launch?.name === 'AbortError' || launch?.code === 'ABORT_ERR' ||
          /user cancel(?:l)?ed|cancel(?:l)?ed by (?:the )?user|\(-128\)/i.test(launch?.stderr || '')) throw cancelled();
      if (launch?.killed || launch?.code === 'ETIMEDOUT') throw startupTimeout();
      throw new Error(english ? 'Could not open Terminal for official login. Check that Terminal is available.' : '无法打开官方登录终端。请确认 macOS“终端”可用。');
    }

    let started = false;
    for (;;) {
      if (signal.aborted) throw cancelled();
      const state = await status();
      if (state === 'exit 0') return;
      if (state === 'cancelled') throw cancelled();
      if (state === 'exit 126' || state === 'exit 127') {
        throw new Error(english ? 'Could not run official agy. Check AGY_BINARY_PATH and its execution permissions.' : '无法启动官方 agy，请检查 AGY_BINARY_PATH 和执行权限。');
      }
      const exit = /^exit (\d{1,3})$/.exec(state);
      if (exit) throw new Error(english ? `Official login failed with exit code ${exit[1]}.` : `官方登录失败，退出码 ${exit[1]}。`);
      const running = /^running ([1-9]\d*)$/.exec(state);
      if (running) {
        if (!isRunning(Number(running[1]))) {
          if (await status() !== state) continue;
          throw cancelled();
        }
        if (!started) {
          started = true;
          deadline = Date.now() + (options.loginTimeoutMs ?? 15 * 60_000);
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (!started) throw startupTimeout();
        throw new Error(english ? 'Official login timed out. Start login again to retry.' : '官方登录等待超时。请重新发起登录。');
      }
      await delay(Math.min(options.pollMs ?? 200, remaining), undefined, { signal });
    }
  } catch (error) {
    await cancelLoginCommand(scriptPath, stateFile).catch(() => {});
    if (signal.aborted) throw cancelled();
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 }).catch(() => {});
  }
}
