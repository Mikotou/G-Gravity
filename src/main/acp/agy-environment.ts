import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

export function commonUnixToolDirectories(home: string): string[] {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin'];
  if (posix.isAbsolute(home)) dirs.push(posix.join(home, '.local/bin'), posix.join(home, '.npm-global/bin'), posix.join(home, 'bin'));
  return dirs;
}

function safePathEntry(entry: string): boolean {
  return posix.isAbsolute(entry) && !/[:\0\r\n]/.test(entry);
}

function existingDirectory(entry: string): boolean {
  if (!safePathEntry(entry)) return false;
  // A trailing slash requires a directory on macOS, including a symlink to one.
  try { return existsSync(entry + '/'); }
  catch { return false; }
}

function discoveredMacToolDirectories(home: string): string[] {
  const brewSbin = '/opt/homebrew/sbin';
  if (!safePathEntry(home)) return [brewSbin].filter(existingDirectory);
  const userBins = ['.volta/bin', '.bun/bin', '.cargo/bin', '.pyenv/shims', '.local/share/mise/shims',
    '.asdf/shims', '.fnm/current/bin', 'Library/pnpm'];
  const directories = [...userBins.map(dir => posix.join(home, dir)), brewSbin, posix.join(home, '.nvm/current/bin')]
    .filter(existingDirectory);

  const root = posix.join(home, '.nvm/versions/node');
  if (!existingDirectory(root)) return directories;
  try {
    const versions = readdirSync(root).flatMap(name => {
      const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(name);
      return match ? [{ name, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }] : [];
    });
    versions.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch || a.name.localeCompare(b.name));
    const latestBin = versions.map(({ name }) => posix.join(root, name, 'bin')).find(existingDirectory);
    if (latestBin) directories.push(latestBin);
  } catch { /* An unreadable NVM tree does not affect the other toolchains. */ }
  return directories;
}

/** Finder may supply only system directories. Extend the child environment without running shell startup files. */
export function buildAgyEnvironment(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  delete next.ELECTRON_RUN_AS_NODE;
  if (platform === 'win32') {
    for (const key of Object.keys(next)) if (/^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete next[key];
  }
  if (platform !== 'darwin') return next;
  const directories = new Set(env.PATH ? env.PATH.split(':') : []);
  const siblingDir = posix.isAbsolute(binary) ? posix.dirname(binary) : '';
  const entries = [siblingDir, ...commonUnixToolDirectories(home), ...discoveredMacToolDirectories(home),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  for (const entry of entries) {
    if (safePathEntry(entry)) directories.add(entry);
  }
  return { ...next, PATH: [...directories].join(':') };
}
