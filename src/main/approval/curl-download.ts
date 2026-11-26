import { execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

const versionKey = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
const versions = new Map<string, { modified: number; size: number; bounded: boolean }>();

function localDirectory(directory: string): boolean {
  return isAbsolute(directory) && !directory.startsWith('\\\\') &&
    !/(?:^|[\\/])(?:\.gemini|antigravity-cli)(?:[\\/]|$)/i.test(directory);
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function hasWorkspaceCurlShadow(cwd: string, workspace: string): boolean {
  const shadowNames = ['curl', 'curl.exe', 'curl.bat', 'curl.cmd', 'curl.com', 'curl.sh'];
  for (const dir of new Set([cwd, workspace])) {
    if (!dir) continue;
    for (const name of shadowNames) {
      if (lstatSync(join(dir, name), { throwIfNoEntry: false })) return true;
    }
  }
  return false;
}

/** Resolve only an installed executable. A command or wrapper supplied by the workspace requires review. */
function windowsCurl(program: string, cwd: string, workspace: string): string | undefined {
  const extensions = program.toLowerCase().endsWith('.exe') ? ['.exe'] :
    (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean);
  if (!extensions.every(ext => /^\.[a-z0-9]+$/.test(ext))) return;
  for (const raw of [cwd, ...(process.env.PATH || '').split(delimiter).filter(Boolean)]) {
    const dir = raw.replace(/^"|"$/g, '');
    if (!localDirectory(dir)) continue;
    for (const ext of extensions) {
      const candidate = join(dir, 'curl' + ext);
      if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
      if (ext !== '.exe' || inside(workspace, candidate)) return;
      const binary = realpathSync(candidate);
      return localDirectory(dirname(binary)) && !inside(workspace, binary) ? binary : undefined;
    }
  }
}

/** Resolve an installed POSIX curl outside the workspace (never executing workspace-local scripts). */
function posixCurl(program: string, cwd: string, workspace: string): string | undefined {
  if (program.toLowerCase() !== 'curl') return;
  if (hasWorkspaceCurlShadow(cwd, workspace)) return;
  let realWorkspace: string | undefined;
  try { realWorkspace = realpathSync(workspace); } catch { realWorkspace = undefined; }
  for (const raw of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const dir = raw.replace(/^"|"$/g, '');
    if (!localDirectory(dir)) continue;
    const candidate = join(dir, 'curl');
    if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
    try {
      accessSync(candidate, constants.X_OK);
      const binary = realpathSync(candidate);
      if (inside(workspace, candidate) || inside(workspace, binary)) return;
      if (realWorkspace && (inside(realWorkspace, candidate) || inside(realWorkspace, binary))) return;
      return localDirectory(dirname(binary)) ? binary : undefined;
    } catch { continue; }
  }
}

/** Read Windows file-version metadata without launching a process from the agent's PATH. */
function supportsStreamingLimit(binary: string): boolean {
  const stat = statSync(binary);
  if (!stat.isFile() || stat.size < 64 || stat.size > 16 * 1024 * 1024) return false;
  const cachedVersion = versions.get(binary);
  if (cachedVersion && cachedVersion.modified === stat.mtimeMs && cachedVersion.size === stat.size) {
    return cachedVersion.bounded;
  }
  let bounded = false;
  if (process.platform === 'win32') {
    const file = readFileSync(binary);
    const key = file.indexOf(versionKey);
    const start = (key + versionKey.length + 3) & ~3;
    if (file.toString('ascii', 0, 2) === 'MZ' && key >= 0 && start + 12 <= file.length &&
        file.readUInt32LE(start) === 0xfeef04bd && file.readUInt32LE(start + 4) === 0x10000) {
      const version = file.readUInt32LE(start + 8); // VS_FIXEDFILEINFO.dwFileVersionMS = major:minor
      bounded = version >= 0x00080004;
    }
  } else {
    try {
      const output = execFileSync(binary, ['--version'], { shell: false, encoding: 'utf8', timeout: 1500, maxBuffer: 8192 });
      const match = /^curl\s+(\d+)\.(\d+)/i.exec(output.trim());
      if (match) {
        const major = Number(match[1]);
        const minor = Number(match[2]);
        bounded = major > 8 || (major === 8 && minor >= 4);
      }
    } catch { bounded = false; }
  }
  if (versions.size >= 16) versions.clear();
  versions.set(binary, { modified: stat.mtimeMs, size: stat.size, bounded });
  return bounded;
}

function hasDefaultConfig(binaries: ReadonlySet<string>): boolean {
  const env = process.env;
  const dirs = [env.CURL_HOME, env.HOME, homedir(), env.XDG_CONFIG_HOME, env.USERPROFILE, env.APPDATA,
    env.USERPROFILE && join(env.USERPROFILE, 'Application Data'), ...[...binaries].map(file => dirname(file))];
  for (const dir of new Set(dirs)) {
    if (!dir) continue;
    if (!localDirectory(dir)) return true;
    const names = dir === env.XDG_CONFIG_HOME ? ['curlrc', '.curlrc', '_curlrc'] : ['.curlrc', '_curlrc'];
    if (names.some(name => lstatSync(join(dir, name), { throwIfNoEntry: false }))) return true;
  }
  return false;
}

/** curl before 8.4 cannot enforce --max-filesize on a response with an unknown length. */
export function canEnforceCurlLimit(program: string, args: readonly string[], cwd: string, workspace: string): boolean {
  try {
    const windows = process.platform === 'win32';
    const binary = windows ? windowsCurl(program, cwd, workspace) : posixCurl(program, cwd, workspace);
    if (!binary) return false;
    const binaries = new Set<string>([binary]);
    // Some Windows shells resolve the inbox executable before consulting PATH.
    if (windows && process.env.SystemRoot) {
      const inbox = join(process.env.SystemRoot, 'System32', 'curl.exe');
      if (lstatSync(inbox, { throwIfNoEntry: false })) binaries.add(inbox);
    }
    // A default config can add transfers, credentials, or redirects. Only inspect its existence.
    if (args[0] !== '-q' && args[0] !== '--disable' && hasDefaultConfig(binaries)) return false;
    // --skip-existing was added in 8.10. Older executables reject it before starting a transfer.
    return args.includes('--skip-existing') || (binaries.size > 0 && [...binaries].every(supportsStreamingLimit));
  } catch { return false; }
}
