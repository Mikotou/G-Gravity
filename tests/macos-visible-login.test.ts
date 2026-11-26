// @vitest-environment node
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMacTerminalLogin } from '../src/main/accounts/macos-login';

let tempDir: string;
beforeEach(async () => { tempDir = await fs.mkdtemp(join(tmpdir(), "gravity-login-test-'")); });
afterEach(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

type Options = Parameters<typeof runMacTerminalLogin>[2];
const run = (options: Partial<Options>) => runMacTerminalLogin('/fake official/agy', ['acp', '--login'], {
  tempDir, signal: new AbortController().signal, pollMs: 4, ...options,
});
function writeState(script: string, state: string) {
  return fs.writeFile(join(dirname(script), 'state'), state);
}

describe('macOS 可见登录与临时状态回收', () => {
  it('终端启动器先退出时继续等待官方退出码，完成后只清除本次临时目录', async () => {
    let complete!: () => Promise<void>;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let completed = false;
    const login = run({ openTerminal: async script => {
      await writeState(script, `running ${process.pid}`);
      complete = () => writeState(script, 'exit 0');
      ready();
    } }).then(() => { completed = true; });
    await started;
    await delay(15);
    expect(completed).toBe(false);
    await complete();
    await login;
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it.each([
    ['cancelled', /已取消/], ['exit 7', /退出码 7/], ['running 2000000000', /终端已关闭/],
  ] as const)('区分状态 %s 后清理临时文件', async (state, expected) => {
    await expect(run({ openTerminal: script => writeState(script, state) })).rejects.toThrow(expected);
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('区分打开 Terminal 失败、Terminal 启动超时和官方等待超时', async () => {
    await expect(run({ openTerminal: async () => { throw Error('fixture'); } })).rejects.toThrow('无法打开官方登录终端');
    await expect(run({ openTerminal: async () => {}, startupTimeoutMs: 12 })).rejects.toThrow('登录终端启动超时');
    await expect(run({ openTerminal: s => writeState(s, `running ${process.pid}`), loginTimeoutMs: 12, locale: 'en-US' })).rejects.toThrow('Official login timed out');
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('应用退出时停止等待，回收资料并允许下一次登录', async () => {
    const control = new AbortController();
    const login = run({ signal: control.signal, openTerminal: async s => {
      await writeState(s, `running ${process.pid}`);
      control.abort();
    } });
    await expect(login).rejects.toThrow('官方登录已取消');
    await run({ openTerminal: script => writeState(script, 'exit 0') });
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  // Git Bash also exercises the generated script on Windows without starting Terminal or using a real account.
  const shellPath = process.platform === 'win32'
    ? (process.env.PATH || '').split(delimiter).filter(p => existsSync(join(p, 'git.exe')))
      .map(p => join(p, '../usr/bin/bash.exe')).find(p => existsSync(p))
    : '/bin/sh';
  it.skipIf(!shellPath)('运行真实 shell，验证路径及参数原样传递、终端输入和失败退出码', async () => {
    const binary = join(tempDir, "agy's test").replace(/\\/g, '/');
    const result = join(tempDir, 'arguments');
    await fs.writeFile(binary, '#!/bin/sh\nIFS= read -r line\nprintf "%s\\n" "$@" "$line" > "$GRAVITY_TEST_LOGIN_ARGS"\nexit 6\n', { mode: 0o700 });
    let mode: number | undefined;
    await expect(runMacTerminalLogin(binary, ['acp', '--app-data-dir', "/test folder/it's safe", '--login'], {
      tempDir, signal: new AbortController().signal, startupTimeoutMs: 15_000, openTerminal: async script => {
        mode = (await fs.stat(script)).mode & 0o777;
        await new Promise<void>((resolve, reject) => {
          // Preserve a literal apostrophe even with Git for Windows' command-line parsing.
          const child = spawn(shellPath!, ['-c', '. "$GRAVITY_TEST_LOGIN_SCRIPT"'], { env: {
            ...process.env, GRAVITY_TEST_LOGIN_SCRIPT: script.replace(/\\/g, '/'), GRAVITY_TEST_LOGIN_ARGS: result.replace(/\\/g, '/'),
          }, stdio: ['pipe', 'ignore', 'ignore'], timeout: 15_000 });
          child.once('error', reject);
          child.once('exit', code => code === 6 ? resolve() : reject(Error(`Fixture exited with ${code}`)));
          child.stdin.end('typed in the terminal\n');
        });
      },
    })).rejects.toThrow('退出码 6');
    if (process.platform !== 'win32') expect(mode).toBe(0o700);
    expect((await fs.readFile(result, 'utf8')).trimEnd().split('\n')).toEqual(['acp', '--app-data-dir', "/test folder/it's safe", '--login', 'typed in the terminal']);
    expect(await fs.readdir(tempDir)).not.toContain('Login.command');
  }, 20_000);
});
