import { app, shell } from 'electron';
import { accessSync, constants, existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { posixSingleQuote } from '../accounts/macos-login';
import { verifyFile, type DownloadReceipt } from './update-integrity';
import { windowsUpdateScript } from './windows-installer';
import type { AppUpdateState } from '../../shared/ipc-channels';

const execFileAsync = promisify(execFile);

function canWriteDirectory(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveMacAppBundlePath(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  const marker = '.app/Contents/MacOS/';
  const idx = process.execPath.indexOf(marker);
  if (idx < 0) return null;
  const bundlePath = process.execPath.slice(0, idx + 4);
  if (bundlePath.includes('/AppTranslocation/')) return null;
  return bundlePath;
}

export function canInstallUpdateDirectly(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
    return Boolean(portableExe && existsSync(portableExe) && canWriteDirectory(dirname(portableExe)));
  }
  if (process.platform === 'darwin') {
    const appBundle = resolveMacAppBundlePath();
    return Boolean(appBundle && existsSync(appBundle) && canWriteDirectory(dirname(appBundle)));
  }
  return false;
}

export async function installDownloadedUpdate(
  filePath: string,
  _state: AppUpdateState,
  receipt: DownloadReceipt
): Promise<{ launched: boolean; message: string }> {
  const updatesDir = dirname(filePath);
  if (process.platform === 'win32') {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
    if (app.isPackaged && portableExe && existsSync(portableExe) && canWriteDirectory(dirname(portableExe))) {
      const scriptPath = join(updatesDir, 'apply-update.ps1');
      const stage = `${portableExe}.${randomUUID()}`;
      const backupPath = `${stage}.bak`;
      await fs.copyFile(filePath, stage, constants.COPYFILE_EXCL);
      const psScript = windowsUpdateScript(process.pid, portableExe, stage, backupPath, filePath);
      try {
        await verifyFile(stage, receipt.size, receipt.sha256);
        await fs.writeFile(scriptPath, `\uFEFF${psScript}`, 'utf8');
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          { detached: true, windowsHide: true, shell: false, stdio: 'ignore' });
        await once(child, 'spawn');
        child.unref();
      } catch (error) {
        await fs.unlink(stage).catch(() => {});
        throw error;
      }
      setTimeout(() => app.quit(), 150);
      return { launched: true, message: '正在退出并替换为新版本，随后自动重启 Gravity...' };
    }
    shell.showItemInFolder(filePath);
    return { launched: false, message: '已打开更新文件所在目录，请关闭当前窗口后运行新版 Gravity.exe。' };
  }

  if (process.platform === 'darwin') {
    const lower = filePath.toLowerCase();
    const appBundle = resolveMacAppBundlePath();
    if (lower.endsWith('.zip') && appBundle && existsSync(appBundle) && canWriteDirectory(dirname(appBundle))) {
      // Both renames must stay on the installed bundle's filesystem.
      const stagingDir = await fs.mkdtemp(join(dirname(appBundle), '.gravity-update-'));
      try {
        const archive = join(stagingDir, 'download.zip');
        await fs.copyFile(filePath, archive, constants.COPYFILE_EXCL);
        await verifyFile(archive, receipt.size, receipt.sha256);
        await execFileAsync('/usr/bin/ditto', ['-xk', archive, stagingDir], { timeout: 120_000, shell: false });
        const entries = await fs.readdir(stagingDir, { withFileTypes: true });
        const bundle = entries.find(entry => entry.isDirectory() && entry.name.toLowerCase() === 'gravity.app');
        if (!bundle) throw new Error('更新压缩包中未找到 Gravity.app');
        const stagedApp = join(stagingDir, bundle.name);
        await execFileAsync('/usr/bin/xattr', ['-cr', stagedApp], { timeout: 30_000, shell: false }).catch(() => undefined);
        const backupApp = appBundle + '.' + randomUUID() + '.bak';
        const scriptPath = join(stagingDir, 'apply-update.sh');
        const shScript = [
          '#!/bin/sh',
          'set -eu',
          'TARGET_PID=' + process.pid,
          'TARGET_APP=' + posixSingleQuote(appBundle),
          'STAGED_APP=' + posixSingleQuote(stagedApp),
          'BACKUP_APP=' + posixSingleQuote(backupApp),
          'STAGING_DIR=' + posixSingleQuote(stagingDir),
          'ARCHIVE_FILE=' + posixSingleQuote(filePath),
          'cleanup() {',
          '  if [ -d "$BACKUP_APP" ] && [ ! -e "$TARGET_APP" ]; then mv "$BACKUP_APP" "$TARGET_APP"; fi',
          '  rm -rf "$STAGING_DIR"',
          '}',
          'trap cleanup EXIT',
          'trap "exit 1" HUP INT TERM',
          'i=0',
          'while [ "$i" -lt 100 ] && kill -0 "$TARGET_PID" 2>/dev/null; do',
          '  sleep 0.3',
          '  i=$((i + 1))',
          'done',
          'if kill -0 "$TARGET_PID" 2>/dev/null; then exit 1; fi',
          'mv "$TARGET_APP" "$BACKUP_APP"',
          'mv "$STAGED_APP" "$TARGET_APP"',
          'if open -a "$TARGET_APP"; then',
          '  rm -rf "$BACKUP_APP"',
          '  rm -f "$ARCHIVE_FILE"',
          'else',
          '  mv "$TARGET_APP" "$STAGED_APP"',
          '  mv "$BACKUP_APP" "$TARGET_APP"',
          '  open -a "$TARGET_APP"',
          '  exit 1',
          'fi',
        ].join('\n');
        await fs.writeFile(scriptPath, shScript, { encoding: 'utf8', mode: 0o700, flag: 'wx' });
        const child = spawn('/bin/sh', [scriptPath], { detached: true, shell: false, stdio: 'ignore' });
        await once(child, 'spawn');
        child.unref();
      } catch (error) {
        await fs.rm(stagingDir, { recursive: true, force: true });
        throw error;
      }
      setTimeout(() => app.quit(), 150);
      return { launched: true, message: '正在替换 Gravity.app 并自动重启...' };
    }
    if (lower.endsWith('.dmg')) {
      const openErr = await shell.openPath(filePath).catch(() => '无法打开镜像');
      if (openErr) {
        shell.showItemInFolder(filePath);
        return { launched: false, message: '安装镜像未能打开，已在 Finder 显示 .dmg 文件，请手动打开。' };
      }
      return { launched: false, message: '已打开新版 .dmg 安装镜像，请将 Gravity.app 拖入“应用程序”完成覆盖。' };
    }
    shell.showItemInFolder(filePath);
    return { launched: false, message: '已打开更新包目录，请解压后替换应用程序中的 Gravity.app。' };
  }

  shell.showItemInFolder(filePath);
  return { launched: false, message: '已打开更新包目录，请手动完成版本替换。' };
}
