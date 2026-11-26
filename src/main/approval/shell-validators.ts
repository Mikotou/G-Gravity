import { isBlockedExternalEndpointHost } from '../../shared/approval-contract';
import { ShellAnalysis } from './shell-lexer';
import { searchRootInsideWorkspace } from './shell-workspace-scope';
import { isUnsafeLookupUrl } from './mcp-network-policy';
import { sensitiveTarget } from './path-and-gemini-policy';


/** Isolated project maintenance with literal file targets or a configured Git remote name. */
export function isWorkspaceMaintenanceCommand(parsed: ShellAnalysis, cwd: string): boolean {
  if (parsed.complex || parsed.hasUnsafeSyntax || parsed.malformed || parsed.segmentTokens?.length !== 1) return false;
  const [program, ...args] = parsed.segmentTokens[0];
  if (/^git(?:\.exe)?$/i.test(program)) {
    const [action, ...rest] = args;
    if (action === 'push') {
      const refs = rest.filter(arg => !['--force', '--force-with-lease', '--set-upstream', '-u', '--tags'].includes(arg));
      return refs.length > 0 && /^[\w-]+$/.test(refs[0]) && !refs[0].startsWith('-') &&
        refs.slice(1).every(ref => /^[\w][\w./-]*$/.test(ref) && !ref.includes('..'));
    }
    if (action === 'reset') return rest.every(arg => /^(?:--hard|--soft|--mixed|HEAD(?:~\d+)?|[a-f0-9]{7,40})$/.test(arg));
    if (action === 'clean') return rest.length > 0 && rest.every(arg => /^-[ndfxX]+$/.test(arg));
    return false;
  }
  if (!/^(?:rm|rmdir|remove-item)$/i.test(program)) return false;
  const targets = args.filter(arg => !/^(?:-[rRf]+|--recursive|--force|-recurse|-force|--|\-literalpath)$/i.test(arg));
  return targets.length > 0 && targets.every(target =>
    /^(?:\.[\\/])?(?:dist|build|coverage|\.gravity-scratch|\.pytest_cache)(?:[\\/][\p{L}\p{N}._-]+)*[\\/]?$/u.test(target) &&
    searchRootInsideWorkspace(cwd, target));
}

/** 纯只读公共 HTTPS HEAD 连通性检查：严禁文件输出、上传、认证头、私网/SSRF 地址。 */
export function isSafePublicHttpsHeadProbe(tokens: string[]): boolean {
  const [program, ...args] = tokens;
  if (!/^curl(?:\.exe)?$/i.test(program) || args.length < 2) return false;
  let hasHead = false;
  let address: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--head') {
      hasHead = true;
      continue;
    }
    if (/^-[fsSqI]+$/.test(tok)) {
      if (tok.includes('I')) hasHead = true;
      continue;
    }
    if (['--silent', '--show-error', '--fail'].includes(tok)) continue;
    if ((tok === '-m' || tok === '--max-time' || tok === '--connect-timeout') && /^\d+(?:\.\d+)?$/.test(args[i + 1] || '')) {
      i++;
      continue;
    }
    if (/^https:\/\//i.test(tok) && !address) {
      address = tok;
      continue;
    }
    return false;
  }
  if (!hasHead || !address || isUnsafeLookupUrl(address)) return false;
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && !url.username && !url.password && !isBlockedExternalEndpointHost(url.hostname);
  } catch {
    return false;
  }
}

/** Only simple workspace arguments qualify for the zero-API build/test path. */
export function cleanDevelopmentCommand(tokens: string[], cwd: string): boolean {
  const [program, ...args] = tokens;
  if (!program) return false;
  const exec = program.toLowerCase().replace(/\.exe$/, '');
  const safePath = (value: string) =>
    /^[\p{L}\p{N}._ /\\-]+$/u.test(value) &&
    !value.startsWith('-') &&
    searchRootInsideWorkspace(cwd, value) &&
    !sensitiveTarget(value);
  const safeDirCreateTarget = (value: string) =>
    safePath(value) && !/(?:^|[\\/])(?:\.git|\.gemini|antigravity-cli)(?:[\\/]|$)/i.test(value);

  // 工作区内目录切换（仅限单路径且位于工作区内）
  if (/^(?:cd|set-location|sl)$/.test(exec)) {
    return args.length === 1 && safePath(args[0]);
  }
  // 工作区内创建空目录
  if (/^(?:mkdir|md)$/.test(exec)) {
    const targets = args.filter(a => a !== '-p' && a !== '--parents');
    return targets.length > 0 && targets.every(safeDirCreateTarget);
  }
  if (/^(?:new-item|ni)$/.test(exec)) {
    let isDir = false;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if ((a === '-itemtype' || a === '-type') && /^directory$/i.test(args[i + 1] || '')) {
        isDir = true;
        i++;
      } else if (a === '-force') {
        continue;
      } else if ((a === '-path' || a === '-literalpath') && args[i + 1]) {
        targets.push(args[++i]);
      } else if (a.startsWith('-')) {
        return false;
      } else {
        targets.push(args[i]);
      }
    }
    return isDir && targets.length > 0 && targets.every(safeDirCreateTarget);
  }
  // 版本号查询
  if (/^(?:node|npm|pnpm|yarn|bun|npx|python|python3|py|git|tsc|cargo|go|dotnet|rustc|java|uv)$/.test(exec) &&
      args.length === 1 && /^(?:--version|-v|-V)$/.test(args[0])) {
    return true;
  }
  if (exec === 'git') {
    const sub = args[0];
    if (!['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'ls-files', 'describe', 'shortlog', 'remote'].includes(sub)) {
      return false;
    }
    if (sub === 'remote') return args.length === 2 && args[1] === '-v';
    const separator = args.indexOf('--');
    const flags = args.slice(1, separator < 0 ? args.length : separator);
    const readFlag = /^(?:-[asbrvnl]+|-\d+|--(?:short|stat|numstat|oneline|show-current|all|remotes|list|cached|staged|name-only|name-status|no-color|graph|decorate|abbrev-commit|tags|always|abbrev-ref|is-inside-work-tree|show-toplevel|porcelain(?:=v[12])?)|--max-count=\d+)$/;
    const safeGitRef = (value: string) =>
      /^(?:HEAD(?:~\d+|\^\d*)?|[a-zA-Z0-9._/-]+)(?:\.\.(?:HEAD(?:~\d+|\^\d*)?|[a-zA-Z0-9._/-]+))?$/.test(value) &&
      !value.startsWith('-') &&
      !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value);
    for (let i = 0; i < flags.length; i++) {
      const a = flags[i];
      if (a === '-n' && /^\d+$/.test(flags[i + 1] || '')) {
        i++;
        continue;
      }
      if (readFlag.test(a)) continue;
      if ((sub !== 'branch' || flags.includes('--list')) && (safeGitRef(a) || safePath(a))) continue;
      return false;
    }
    return separator < 0 || args.slice(separator + 1).every(safePath);
  }
  let extra: string[];
  if (/^(?:npm|pnpm|yarn|bun)$/.test(exec)) {
    if (args[0] === 'run' && /^(?:test|unit|typecheck|lint|build|check|tsc|compile|format:check)(?::[a-z0-9_-]+)?$/.test(args[1] || '')) {
      extra = args.slice(2);
    } else if (/^(?:test|t|typecheck|lint|build|check)$/.test(args[0] || '')) {
      extra = args.slice(1);
    } else {
      return false;
    }
  } else if (exec === 'npx') {
    if (!['vitest', 'tsc', 'eslint', 'biome', 'prettier'].includes(args[0])) return false;
    if (args[0] === 'tsc' && !args.includes('--noEmit')) return false;
    if (args[0] === 'prettier' && (!args.includes('--check') || args.some(a => /^(?:-w|--write)$/.test(a)))) return false;
    if (args[0] === 'biome' && args[1] !== 'check' && args[1] !== 'lint') return false;
    extra = args.slice(1);
  } else if (exec === 'tsc' && args.includes('--noEmit')) {
    extra = args;
  } else if (exec === 'pytest') {
    extra = args;
  } else if (/^(?:python|python3|py)$/.test(exec) && args[0] === '-m' && /^(?:pytest|unittest)$/.test((args[1] || '').toLowerCase())) {
    extra = args.slice(2);
  } else if (exec === 'uv' && args[0] === 'run' && /^(?:pytest|ruff|mypy)$/.test((args[1] || '').toLowerCase())) {
    extra = args.slice(2);
  } else if (exec === 'node' && args[0] === '--check' && args.length === 2) {
    return safePath(args[1]);
  } else if (/^(?:cargo|go|dotnet)$/.test(exec) && /^(?:test|check|build|clippy|vet)$/.test(args[0] || '')) {
    extra = args.slice(1);
  } else {
    return false;
  }
  return extra.every(
    a =>
      /^(?:--|--run|run|check|lint|--check|--noEmit|--runInBand|--silent|-q|-v|-vv|--quiet|--verbose|--all-targets|--all-features|--watch=false|--reporter=(?:dot|default|verbose|basic)|-x|--maxfail=\d+)$/.test(a) ||
      safePath(a)
  );
}
