import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { runMacTerminalLogin } from './macos-login';
import { buildAgyEnvironment } from '../acp/agy-environment';
import { type ClientLocale } from '../../shared/theme-i18n-contract';

const execFileAsync = promisify(execFile);
let loginProcess: ChildProcess | undefined;
let macLogin: { controller: AbortController; done: Promise<void> } | undefined;
/** 启动可见的官方登录程序。Promise 跟随进程退出，调用方据此解除登录互斥并刷新账号状态。 */
export async function launchLogin(binary: string, args: string[], locale?: ClientLocale): Promise<void> {
  if (loginProcess || macLogin) throw new Error('官方登录窗口已打开');
  if (process.platform === 'darwin') {
    const controller = new AbortController();
    const done = runMacTerminalLogin(binary, args, {
      tempDir: app.getPath('temp'), signal: controller.signal, locale,
    });
    macLogin = { controller, done };
    try { await done; } finally { macLogin = undefined; }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const quotedArgs = args.map(arg => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`).join(' ');
    const command = `$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath '${binary.replace(/'/g, "''")}' -ArgumentList '${quotedArgs.replace(/'/g, "''")}' -WindowStyle Normal -PassThru; if ($null -eq $p) { exit 1 }; $p.WaitForExit(); exit $p.ExitCode`;
    const env = buildAgyEnvironment(binary);
    loginProcess = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env, windowsHide: true, shell: false, stdio: 'ignore' })
      : spawn(binary, args, { env, stdio: 'inherit', shell: false });
    loginProcess.once('error', () => { loginProcess = undefined; reject(new Error('无法打开官方登录终端')); });
    loginProcess.once('close', code => { loginProcess = undefined; code === 0 ? resolve() : reject(new Error('官方登录取消或未成功完成')); });
  });
}

export async function stopLoginProcesses(): Promise<void> {
  if (macLogin) {
    const { controller, done } = macLogin;
    controller.abort();
    await done.catch(() => {});
    return;
  }
  const child = loginProcess;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close').catch(() => {});
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, shell: false, timeout: 3_000,
    }).catch(() => child.kill());
  } else child.kill();
  const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
  let timeout: NodeJS.Timeout | undefined;
  try { await Promise.race([closed, new Promise<void>(resolve => { timeout = setTimeout(resolve, 4000); })]); }
  finally { clearTimeout(force); clearTimeout(timeout); }
}
