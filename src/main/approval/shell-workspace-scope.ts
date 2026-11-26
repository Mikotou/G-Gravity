import { lstatSync } from 'node:fs';
import { canEnforceCurlLimit } from './curl-download';
import { posix, win32 } from 'node:path';
import { isBlockedExternalEndpointHost } from '../../shared/approval-contract';
import { sensitiveTarget } from './path-and-gemini-policy';
import { parseShellCommand, stripMatchingQuotes, ShellAnalysis } from './shell-lexer';


// Recognize only stdin filters. Both sort and uniq also have forms that write files.
const READ_ONLY_PIPE = /^(?:(?:head|tail)(?:\s+(?:-\d+|-n\s+\d+))?|wc(?:\s+-[clmw]+)?|sort(?:\s+-[nru]+)*|uniq(?:\s+-[cdu]+)*|Select-Object\s+-First\s+\d+)$/i;

export function searchRootInsideWorkspace(cwd: string, root: string): boolean {
  if (!cwd || !root || sensitiveTarget(root) || /^[~]|[\[\]*?$%'"\x60]/.test(root) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(root)) return false;
  const path = /^[A-Z]:[\\/]|^\\\\/i.test(cwd) ? win32 : posix;
  if (/^[\w-]+:/.test(root) && !(path === win32 && /^[a-z]:[\\/]/i.test(root))) return false;
  const resolvedCwd = path.resolve(cwd);
  const resolvedTarget = path.resolve(resolvedCwd, root);
  const relative = path.relative(resolvedCwd, resolvedTarget);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  try {
    // Only check symlinks from target up to resolvedCwd itself so OS ancestor symlinks
    // like macOS /var -> /private/var or /tmp -> /private/tmp do not reject valid workspaces.
    for (let part = resolvedTarget; part !== resolvedCwd; part = path.dirname(part)) {
      if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
      const parent = path.dirname(part);
      if (parent === part) break;
    }
    if (lstatSync(resolvedCwd, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  } catch { return false; }
  return true;
}

export function commandWorkspaceCwd(cwd: string, rawInput: unknown): string | undefined {
  const raw = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {};
  const overrides = [raw.cwd, raw.Cwd, raw.DirectoryPath, raw.WorkingDirectory].filter(v => v !== undefined);
  if (!overrides.length) return cwd;
  const first = overrides[0];
  if (typeof first !== 'string' || overrides.some(value => value !== first) || !searchRootInsideWorkspace(cwd, first)) return;
  return (/^[A-Z]:[\\/]|^\\\\/i.test(cwd) ? win32 : posix).resolve(cwd, first);
}

/** Remove only literal exclusions from a completely understood search; keep real roots and positive predicates. */
export function readOnlySearchScope(command: string, cwd: string, parsed = parseShellCommand(command), rawInput?: unknown) {
  if (parsed.tokens[0] === 'find' && parsed.hasUnsafeSyntax) {
    const first = parsed.segments[0];
    const groups = parsed.tokens.slice(0, parsed.segmentTokens?.[0]?.length).filter(t => t === '\\(' || t === '\\)');
    let depth = 0;
    for (const group of groups) {
      depth += group === '\\(' ? 1 : -1;
      if (depth < 0) return;
    }
    const standalone = /(?<!\S)\\[()](?=\s|$)/g;
    if (!groups.length || depth || first.match(standalone)?.length !== groups.length) return;
    command = command.replace(first, () => first.replace(standalone, ' '));
    parsed = parseShellCommand(command);
  }
  if (parsed.malformed || parsed.hasUnsafeSyntax || /[\r\n;&<>\x60$%^(){}]/.test(command) ||
      /^\s*\||\|\s*$|\|\s*\|/.test(command) ||
      parsed.operators?.some(op => op !== '|') || !parsed.segments.slice(1).every(part => READ_ONLY_PIPE.test(part))) return;
  const tokens = parsed.segmentTokens?.[0];
  if (!tokens?.length) return;
  const cmd = tokens[0].toLowerCase();
  const roots: string[] = [];
  const operands = [cmd];
  let excluded = false;
  // Quotes must enclose a whole literal (or the value of --exclude=). No expansion or shell escapes.
  const literal = /^[\p{L}\p{N}_.:/\\!*=~?, -]+$/u;
  const validPattern = (v?: string) => !!v && !v.startsWith('-') && literal.test(v);
  const rawTokens = parsed.tokens.slice(0, tokens.length);
  if (rawTokens.some(raw => {
    const value = raw.replace(/^--(?:exclude(?:-dir)?|glob)=/, '');
    const unquoted = stripMatchingQuotes(value);
    return !literal.test(unquoted) || (unquoted === value && /[*?]/.test(value) && !value.startsWith('!') && cmd !== 'get-childitem');
  })) return;

  if (cmd === 'find') {
    let i = 1;
    while (i < tokens.length && !/^[-!]/.test(tokens[i])) roots.push(tokens[i++]);
    while (i < tokens.length) {
      const flag = tokens[i++];
      if ((flag === '-not' || flag === '!') && /^-i?path$/.test(tokens[i]) && validPattern(tokens[i + 1])) {
        i += 2;
        excluded = true;
      } else if (/^-i?path$/.test(flag) && validPattern(tokens[i]) && tokens[i + 1] === '-prune') {
        i += 2;
        excluded = true;
      } else if (/^-(?:maxdepth|mindepth)$/.test(flag) && /^\d+$/.test(tokens[i])) {
        operands.push(flag, tokens[i++]);
      } else if (flag === '-type' && /^[bcdflps]$/.test(tokens[i])) {
        operands.push(flag, tokens[i++]);
      } else if (/^-i?(?:name|path)$/.test(flag) && validPattern(tokens[i])) {
        operands.push(flag, tokens[i++]);
      } else if (/^-(?:a|and|o|or|print|print0|ls)$/.test(flag)) {
        operands.push(flag);
      } else return;
    }
  } else if (cmd === 'rg' || cmd === 'grep') {
    const positional: string[] = [];
    let filesOnly = false;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      const option = token.split('=', 1)[0];
      if (cmd === 'rg' ? option === '--glob' || option === '-g' : /^--exclude(?:-dir)?$/.test(option)) {
        const pattern = token.includes('=') ? stripMatchingQuotes(token.slice(option.length + 1)) : tokens[++i];
        if (!validPattern(pattern) || (cmd === 'rg' && (!pattern.startsWith('!') || pattern.length === 1))) return;
        excluded = true;
      } else if (cmd === 'rg' && token === '--files') filesOnly = true;
      else if (cmd === 'rg' && token === '--hidden') operands.push(token);
      else if (/^-[inlHhFswxc]+$/.test(token) || (cmd === 'grep' && /^-[rinlHhFEswxc]+$/.test(token))) operands.push(token);
      else if (token.startsWith('-')) return;
      else positional.push(token);
    }
    if (!filesOnly) {
      if (!positional.length) return;
      operands.push(positional.shift()!);
    }
    roots.push(...positional);
  } else if (cmd === 'get-childitem' || cmd === 'gci') {
    for (let i = 1; i < tokens.length; i++) {
      const flag = tokens[i].toLowerCase();
      if (flag === '-exclude' && validPattern(tokens[i + 1])) { i++; excluded = true; }
      else if (/^-(?:recurse|file|directory|name|force|hidden)$/.test(flag)) operands.push(flag);
      else if (flag === '-depth' && /^\d+$/.test(tokens[i + 1])) operands.push(flag, tokens[++i]);
      else if (/^-(?:path|literalpath)$/.test(flag) && validPattern(tokens[i + 1])) roots.push(tokens[++i]);
      else if (flag.startsWith('-')) return;
      else roots.push(tokens[i]);
    }
    // PowerShell interprets commas as multiple path operands.
    if (roots.some(root => root.includes(','))) return;
  } else return;
  if (!excluded) return;
  operands.push(...roots);
  const base = commandWorkspaceCwd(cwd, rawInput);
  const path = /^[A-Z]:[\\/]|^\\\\/i.test(cwd) ? win32 : posix;
  const insideWorkspace = Boolean(base && (roots.length ? roots : ['.']).every(root =>
    searchRootInsideWorkspace(cwd, root) && (base === cwd || searchRootInsideWorkspace(cwd, path.resolve(base, root)))));
  return { operands, insideWorkspace };
}

export function hasSearchExclusions(parsed: ShellAnalysis): boolean {
  const [program, ...args] = parsed.segmentTokens?.[0] ?? [];
  switch (program?.toLowerCase()) {
    case 'find': return args.some(a => a === '-prune' || a === '-not' || a === '!');
    case 'rg': return args.some((a, i) => (/^(?:-g|--glob)$/.test(a) && args[i + 1]?.startsWith('!')) || /^--glob=["']?!/.test(a));
    case 'grep': return args.some(a => /^--exclude(?:-dir)?(?:=|$)/.test(a));
    case 'gci':
    case 'get-childitem': return args.some(a => a.toLowerCase() === '-exclude');
    default: return false;
  }
}

/** Keep authenticated download commands, including their literal arguments, out of external review and the audit log. */
export function downloadUsesCredentials(command: string): boolean {
  if (!/(?:^|[\s|;&])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?\s/i.test(command)) return false;
  return /https?:\/\/[^/\s"']+@/i.test(command) ||
    /(?:^|\s)--(?:user|proxy-user|password|http-user|http-password|oauth2-bearer|cookie|cookie-jar|netrc(?:-optional|-file)?|load-cookies|save-cookies|header(?=\s+["']?(?:authorization|cookie|x-api-key)\s*:))(?:[=\s]|$)/i.test(command) ||
    /(?:^|\s)-[fsSLq]*[uUb]/.test(command) || /(?:^|\s)-(?:credential|websession|usedefaultcredentials)\b/i.test(command) ||
    /(?:^|[\s"'?&])(?:authorization|proxy-authorization|cookie|x-api-key|api[_-]?key|access_token|signature)\s*[:=]/i.test(command);
}

/** A supplied HTTP header is a separate case from opening a stored credential. Keep paths and values intact. */
export function credentialInspectionText(text: string): string {
  return text.replace(/(^|[\s"'?&])(?:cookie|access_token)(?=\s*[:=])/gi, '$1auth-header');
}

export function isFileDownload(tokens: string[]): boolean {
  const [program, ...args] = tokens;
  if (/^wget(?:\.exe)?$/i.test(program)) return true;
  if (/^(?:invoke-webrequest|iwr)$/i.test(program)) return args.some(arg => /^-outfile\b/i.test(arg));
  return /^curl(?:\.exe)?$/i.test(program) && args.some(arg => /^--(?:output|remote-name)(?:=|$)|^-[a-zA-Z]*[oO]/.test(arg));
}

/** curl's --max-filesize caps the response body. A rate limit, Range header or wget quota cannot cap one file. */
export function isBoundedWorkspaceDownload(parsed: ShellAnalysis, cwd: string, maxMB: number, rawInput: unknown): boolean {
  if (!Number.isFinite(maxMB) || maxMB <= 0 || parsed.malformed || parsed.hasUnsafeSyntax || parsed.segments.length !== 1 || parsed.operators?.length ||
      parsed.tokens.some(raw => !/^[\p{L}\p{N}._:/\\= -]+$/u.test(stripMatchingQuotes(raw)))) return false;
  const [program, ...args] = parsed.segmentTokens?.[0] ?? [];
  if (!/^curl(?:\.exe)?$/i.test(program)) return false;
  let output: string | undefined, address: string | undefined, bytes: number | undefined;
  let followsRedirects = false, zeroRedirects = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--max-redirs') {
      if (args[++i] !== '0') return false;
      zeroRedirects = true;
      continue;
    }
    if (token === '--location' || (/^-[fsSqL]+$/.test(token) && token.includes('L'))) {
      followsRedirects = true;
      continue;
    }
    if (/^-[fsSq]+$/.test(token) || ['--fail', '--silent', '--show-error', '--disable', '--skip-existing'].includes(token)) continue;
    if (token === '--max-filesize' || token.startsWith('--max-filesize=')) {
      const size = /^(\d+)([kmg]?)$/i.exec(token.includes('=') ? token.slice('--max-filesize='.length) : args[++i] ?? '');
      if (bytes !== undefined || !size) return false;
      bytes = Number(size[1]) * 1024 ** ['', 'k', 'm', 'g'].indexOf(size[2].toLowerCase());
    } else if (token === '-o' || token === '--output') {
      if (output !== undefined) return false;
      output = args[++i];
    } else if (/^https:\/\//i.test(token) && !address) address = token;
    else return false;
  }
  if ((followsRedirects && !zeroRedirects) || !address || !output || !bytes || !Number.isSafeInteger(bytes) || bytes > maxMB * 1024 ** 2 ||
      !searchRootInsideWorkspace(cwd, output)) return false;
  try {
    const url = new URL(address);
    if (url.username || url.password || url.search || url.hash || isBlockedExternalEndpointHost(url.hostname)) return false;
    const path = /^[A-Z]:[\\/]|^\\\\/i.test(cwd) ? win32 : posix;
    const base = commandWorkspaceCwd(cwd, rawInput);
    if (!base) return false;
    const target = path.resolve(base, output);
    const relative = path.relative(cwd, target);
    if (!searchRootInsideWorkspace(cwd, target) || sensitiveTarget(target) ||
        /(?:^|[\\/])\.[^.\\/][^\\/]*(?:[\\/]|$)/.test(relative) ||
        /(?:^|[\\/])(?:\.git|\.gemini|antigravity-cli|node_modules)(?:[\\/]|$)/i.test(target) ||
        output.startsWith('-') || /[\\/]$/.test(output) || output === '.') return false;
    if (relative.split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
    if (path === win32 && target.slice(3).split('\\').some(part => /:|[. ]$/.test(part))) return false;
    return lstatSync(target, { throwIfNoEntry: false }) === undefined && canEnforceCurlLimit(program, args, base, cwd);
  } catch { return false; }
}
