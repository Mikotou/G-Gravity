import { type ApprovalFloorTier } from '../../shared/approval-contract';
import { isMutatingShellCommand, mutatingFilterReason } from './shell-mutation-policy';
import { sensitiveTarget } from './path-and-gemini-policy';
import { ShellAnalysis } from './shell-lexer';
import {
  downloadUsesCredentials, hasSearchExclusions, isFileDownload, searchRootInsideWorkspace,
} from './shell-workspace-scope';
import { urlFloor } from './mcp-network-policy';


export const HIGH_RISK_EXECUTABLES = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri',
  'mv', 'move', 'move-item', 'mi', 'ren', 'rename-item', 'rni',
  'cp', 'copy', 'copy-item', 'cpi',
  'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc',
  'out-file', 'tee-object', 'tee', 'new-item', 'ni',
  'sudo', 'su', 'runas', 'gsudo',
  'format', 'mkfs', 'diskpart', 'bcdedit', 'mountvol',
  'shutdown', 'reboot', 'restart-computer', 'stop-computer', 'logoff',
  'reg', 'regedit', 'chmod', 'chown', 'icacls', 'takeown', 'set-acl', 'set-executionpolicy',
  'kill', 'taskkill', 'stop-process', 'spps', 'pkill', 'killall',
  'curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'certutil', 'bitsadmin',
  'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'nc', 'ncat', 'netcat', 'telnet',
  'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'wsl', 'cscript', 'wscript', 'mshta', 'rundll32',
  'iex', 'invoke-expression', 'start-process', 'saps', 'start', 'invoke-command', 'icm', 'xargs',
  'python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua',
]);

export const READ_ONLY_FS_OR_TEXT_CMDLETS = new Set([
  'pwd', 'get-location', 'gl', 'whoami', 'hostname', 'uname', 'ver',
  'echo', 'printf', 'write-output', 'write-host',
  'get-childitem', 'gci', 'dir', 'ls', 'get-item', 'gi',
  'test-path', 'resolve-path', 'split-path', 'join-path', 'get-filehash',
  'get-content', 'gc', 'cat', 'type', 'head', 'tail', 'wc', 'nl', 'stat', 'file',
  'select-string', 'sls', 'rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'findstr',
  'which', 'where.exe', 'get-command', 'gcm', 'get-process', 'gps', 'tasklist',
]);

export const READ_ONLY_MEMORY_FILTERS = new Set([
  'select-object', 'select', 'where-object', 'where', 'sort-object', 'sort',
  'group-object', 'group', 'measure-object', 'measure',
  'format-table', 'ft', 'format-list', 'fl', 'out-string',
  'convertto-json', 'convertfrom-json', 'get-unique', 'compare-object',
]);

const PWSH_READ_ONLY_ANALYSIS_CMDLET_RE =
  /\b(?:get-content|get-childitem|select-string|import-csv|convertfrom-json|where-object|foreach-object|select-object|group-object|measure-object|sort-object|format-table|format-list|write-host|test-path|get-item|get-process)\b/i;

const DANGEROUS_SCRIPT_API_RE =
  /\b(?:invoke-expression|iex|invoke-webrequest|iwr|invoke-restmethod|irm|invoke-command|icm|start-process|saps|remove-item|set-content|add-content|out-file|new-item|move-item|copy-item|clear-content|stop-process|set-acl|set-executionpolicy|add-type|register-scheduledtask|start-bitstransfer|downloadstring|downloadfile|webclient|httpclient|net\.sockets|process\]::start|file\]::write|file\]::delete|file\]::move|file\]::copy|directory\]::delete)\b/i;

const DANGEROUS_INLINE_INTERPRETER_API_RE =
  /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|unlink(?:Sync)?|rmSync|rmdir(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?|copyFile(?:Sync)?|cpSync|mkdir(?:Sync)?|chmod(?:Sync)?|chown(?:Sync)?|child_process|execSync|execFile(?:Sync)?|spawn(?:Sync)?|fork\s*\(|subprocess|os\.(?:system|popen|exec\w*|spawn\w*|remove|unlink|rmdir|rename|replace|chmod|chown|environ)|shutil\.(?:rmtree|move|copy\w*)|\.write_text\b|\.write_bytes\b|process\.env|process\.kill|\beval\s*\(|\bnew\s+Function\b|\bvm\.|\bexec\s*\(|__import__|ctypes|pickle\.loads|\bfetch\s*\(|\b(?:require\s*\(\s*['"](?:https?|net|tls|dgram|dns|child_process|vm)['"]\s*\))|\bimport\s+(?:urllib|requests|httpx|http\.client|socket|ftplib|smtplib|subprocess|ctypes)\b|\bfrom\s+(?:urllib|requests|httpx|http|socket|subprocess)\b|WebSocket|XMLHttpRequest|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|VACUUM)\b|open\s*\([^)]*,\s*['"][^'"]*[wax+]/i;

const CATASTROPHIC_SYSTEM_WIPE_RE =
  /(?:^|[\s;|&(])(?:format-volume|diskpart|bcdedit|mkfs(?:\.[a-z0-9]+)?|shutdown|reboot|restart-computer|stop-computer)\b|(?:^|[\s;|&(])rm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force|--force\s+--recursive)\s+(?:\/(?:\s|$|\*)|~(?:\/|\s|$)|C:\\(?:Windows|Users)?(?:\s|$|"|'))|(?:^|[\s;|&(])dd\s+[^\r\n]*\bof=\/dev\/(?:sd|nvme|disk|hd)/i;

/** 检测极端不可逆的系统级毁灭命令（Stage 1A 硬拒绝，不送审也不执行）。 */
export function isCatastrophicSystemCommand(command: string): boolean {
  if (!command) return false;
  return CATASTROPHIC_SYSTEM_WIPE_RE.test(command);
}

export function hasShellCommandSubstitution(command: string): boolean {
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === quote) quote = '';
    } else if (ch === '\\') {
      // Consume the escaped character so even and odd runs of backslashes differ.
      i++;
    } else if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
      return true;
    } else if (ch === quote) {
      quote = '';
    } else if (!quote && (ch === '"' || ch === "'")) {
      quote = ch;
    }
  }
  return false;
}

/**
 * 判断一段内联 `node -e` / `python -c` 脚本是否属于纯只读统计/分析脚本（零写入、零删除、零子进程、零网络、零环境变量读取）。
 */
function isReadOnlyInlineInterpreterScript(command: string, parsed?: ShellAnalysis): boolean {
  if (!command || !command.trim() || command.length > 32_768) return false;
  if (isMutatingShellCommand(command, parsed) || sensitiveTarget(command)) return false;

  const trimmed = command.trim();
  // 允许前面仅带 `cd <dir> &&` 或 `Set-Location <dir> ;`，主体为单个 node -e / python -c 调用
  const unwrapped = trimmed.replace(
    /^(?:(?:cd|set-location|sl)\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|]+)\s*(?:&&|;)\s*)+/i,
    ''
  );
  if (!/^(?:node|python|python3|py)(?:\.exe)?\s+(?:-e|--eval|-c)\s+/i.test(unwrapped)) {
    return false;
  }

  const unquoted = unwrapped.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  // 排除命令串接、管道、真实重定向、反引号、POSIX 命令替换与路径穿越
  if (hasShellCommandSubstitution(command) || /[|;&]|(?:^|[^-=!<>])(?:[12*&]?)>{1,2}(?!\s*&)|(?:^|[^-=!<>])<(?![=<])/.test(unquoted)) {
    return false;
  }
  if (/(?:^|[\\/\s"'])\.\.(?:[\\/\s"']|$)|hk(?:lm|cu|cr|u|cc):/i.test(command)) return false;
  if (DANGEROUS_INLINE_INTERPRETER_API_RE.test(unwrapped)) return false;
  return true;
}

/**
 * 判断一段脚本命令是否属于「纯只读内存分析脚本候选」（覆盖 PowerShell 分析脚本及 `node -e` / `python -c` 只读脚本）：
 * 严格排除一切写入、重定向、反引号、POSIX 命令替换 `$(cmd)`、高危 API、目录穿越与敏感目标。
 */
export function isReadOnlyScriptReviewCandidate(command: string, parsed?: ShellAnalysis): boolean {
  if (!command || !command.trim() || command.length > 32_768) return false;
  if (isMutatingShellCommand(command, parsed) || sensitiveTarget(command)) return false;
  if (isReadOnlyInlineInterpreterScript(command, parsed)) return true;

  const unquoted = command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  // 排除反引号、文件输入/输出重定向、PowerShell `&` 动态调用运算符、跨级 `..` 及注册表驱动器
  if (hasShellCommandSubstitution(command)) return false;
  if (/(?:^|[^-=!<>])(?:[12*&]?)>{1,2}(?!\s*&)|(?:^|[^-=!<>])<(?![=<])/.test(unquoted)) return false;
  if (/(?:^|[\s;|{(=])&(?!&)/.test(unquoted)) return false;
  if (/(?:^|[\\/\s"'])\.\.(?:[\\/\s"']|$)|hk(?:lm|cu|cr|u|cc):/i.test(command)) return false;

  // 必须至少包含一个明确的 PowerShell 只读分析 cmdlet
  if (!PWSH_READ_ONLY_ANALYSIS_CMDLET_RE.test(unquoted)) return false;
  // 禁止脚本内任意位置出现高危 cmdlet / .NET 写入或网络执行 API
  if (DANGEROUS_SCRIPT_API_RE.test(unquoted)) return false;

  // 扫描每个语句/管道/脚本块起始位置的可执行名，命中 HIGH_RISK_EXECUTABLES 一律拒绝降级
  const cmdPosRe = /(?:^|[;|{\r\n]|&&|=\s*)\s*([A-Za-z][A-Za-z0-9_.-]*)/g;
  for (const m of unquoted.matchAll(cmdPosRe)) {
    const exec = (m[1] || '').toLowerCase().replace(/\.exe$/i, '');
    if (HIGH_RISK_EXECUTABLES.has(exec)) return false;
  }

  return true;
}

const PRIVILEGE_OR_SYSTEM_EXECS = new Set([
  'sudo', 'su', 'runas', 'gsudo', 'chmod', 'chown', 'chflags', 'icacls', 'takeown',
  'set-acl', 'set-executionpolicy', 'reg', 'regedit', 'launchctl', 'format', 'mkfs',
  'diskpart', 'bcdedit', 'mountvol', 'shutdown', 'reboot', 'restart-computer', 'stop-computer',
]);

const PIPE_INJECTION_SINKS = new Set([
  'sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'iex', 'invoke-expression',
  'node', 'python', 'python3', 'py', 'perl', 'ruby', 'php', 'xargs', 'eval',
]);

interface ShellFloor {
  floorTier: ApprovalFloorTier;
  /** Kept for callers of the pre-v0.3.2 screening API. */
  hardFloor: boolean;
  reason?: string;
}

const immutable = (reason: string): ShellFloor => ({ floorTier: 'tier_a_immutable', hardFloor: true, reason });

/** 检测上游是否为 PowerShell 静态单引号 here-string（完整脚本明文可见，区别于远端 curl|sh 盲执行）。 */
function isStaticHereStringLiteral(segment: string | undefined): boolean {
  if (!segment) return false;
  return /^@'\r?\n[\s\S]*?\r?\n'@$/u.test(segment.trim());
}

/**
 * 评估本地命令的高风险地板层级：
 * - `tier_a_immutable`：仅保留可能导致封号/泄露凭据的绝对红线（凭据下载、云元数据 SSRF、Google 私有域 cloudcode-pa）；
 * - `tier_b_intent_gated`：所有本地高风险启发式（在 AI 代审模式下作为参考信息交由 AI 独立裁决；在无 AI 的「仅规则」模式下严格拦截转人工）；
 * - `hardFloor`：标记无 AI 复核/Turbo 模式下不得盲放行的高危结构。
 */
export function assessShellHighRiskFloor(
  command: string, parsed: ShellAnalysis, requireBoundedDownload = false,
  unverifiedSearchExclusions = false, cwd?: string,
): ShellFloor {
  // 1. 先检查不可变防封号 / 凭据安全红线（优先级最高）
  if (downloadUsesCredentials(command)) return immutable('下载携带认证参数，请人工确认');
  if (/169\.254\.(?:169\.254|170\.2)|metadata\.goog(?:le\.internal)?|cloudcode-pa/i.test(command)) {
    return immutable('网络请求指向云元数据或受限 Google 内部服务，必须人工确认');
  }

  let intentReason: string | undefined;
  let hardFloor = false;
  const markAdvisory = (reason: string, hard = false) => {
    if (hard) hardFloor = true;
    if (!intentReason) intentReason = reason;
  };

  if (!command.trim() || command.length > 32_768 || parsed.malformed) {
    markAdvisory('无法完整解析命令语法，需核对完整载荷', true);
  }
  if (unverifiedSearchExclusions && hasSearchExclusions(parsed)) {
    markAdvisory('无法本地验证搜索范围或下游管道，需核对实际范围', true);
  }
  if (/\bhk(?:lm|cu|cr|u|cc):|(?:^|[\s;|&(])(?:sudo|gsudo|runas)(?:\.exe)?\s|\s-verb\s+runas\b/i.test(command)) {
    markAdvisory('命令涉及系统提权或注册表修改，需核对用户意图', true);
  }
  if (hasShellCommandSubstitution(command)) {
    markAdvisory('包含动态命令替换，需核对完整载荷与意图', true);
  }

  const unquoted = command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const segments = parsed.segmentTokens ?? [];
  for (const [idx, toks] of segments.entries()) {
    if (!toks.length) continue;
    const exec = toks[0].toLowerCase().split(/[\\/]/).at(-1)!.replace(/\.exe$/, '');
    const args = toks.slice(1);
    if (idx && parsed.operators?.[idx - 1] === '|' && PIPE_INJECTION_SINKS.has(exec)) {
      if (isStaticHereStringLiteral(parsed.segments[idx - 1])) {
        markAdvisory('静态多行脚本通过管道交由本地解释器执行，需核对完整代码与用户意图', false);
      } else {
        markAdvisory('管道下游接入解释器或 Shell，无 AI 复核时必须人工确认', true);
      }
    }
    if (/^(?:bash|sh|zsh|dash|ksh|cmd|powershell|pwsh)$/.test(exec) &&
        args.some(a => /^(?:-[a-z]*c|\/[ck]|-enc(?:odedcommand)?|-command)$/i.test(a))) {
      markAdvisory('嵌套解释器动态执行命令，需核对完整载荷与意图', true);
    }
    if (PRIVILEGE_OR_SYSTEM_EXECS.has(exec) ||
        /^(?:iex|invoke-expression|invoke-command|mshta|rundll32|certutil|bitsadmin|ssh|scp|sftp|ncat|nc|netcat|telnet)$/.test(exec)) {
      markAdvisory('涉及系统权限、动态求值或远程连接执行，需核对用户意图', true);
    }
    const filterRisk = mutatingFilterReason(toks);
    if (filterRisk) markAdvisory(filterRisk, true);
    if (requireBoundedDownload && isFileDownload(toks)) {
      markAdvisory('无法本地验证下载大小或目标文件，需核对来源与目标', true);
    }
    if (/^(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)$/.test(exec)) {
      for (const arg of args.filter(arg => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg))) {
        const target = urlFloor(arg);
        if (target === 'tier_a_immutable') return immutable('网络地址涉及云元数据、内嵌凭据或受限 Google 内部服务，必须人工确认');
        if (target === 'tier_b_intent_gated') markAdvisory('本地或内网网络请求，需核对目标服务与用户意图', false);
      }
    }
    if (/^(?:rm|remove-item|ri|del|erase|rmdir|rd|shred|mv|move|move-item|rename-item)$/.test(exec)) {
      const operands = args.filter(a => !a.startsWith('-') && !/^\/[sqf]$/i.test(a));
      if (cwd && (!operands.length || operands.some(p => p === '.' || !searchRootInsideWorkspace(cwd, p)))) {
        markAdvisory('删除或移动目标超出当前工作区范围，需核对目标路径', true);
      } else {
        markAdvisory('删除或移动工作区文件，需核对用户指定的目标', false);
      }
    }
    if (exec === 'git' && args.some(a => /^(?:push|reset|clean)$/.test(a))) {
      markAdvisory('Git 操作可能改写文件、历史或远端引用', false);
    }
    if (/^(?:node|python|python3|py)$/.test(exec) && args.some(a => /^(?:-c|-e|--eval)$/.test(a))) {
      const privilegedInline = /\b(?:child_process|subprocess|os\.(?:system|popen|environ)|process\.env|__import__|ctypes|eval|execSync|spawnSync)\b/i.test(command);
      markAdvisory(
        privilegedInline
          ? '内联脚本涉及子进程、环境变量或动态执行能力，需核对完整代码与意图'
          : '本地内联脚本，需核对代码及用户指定的作用范围',
        privilegedInline
      );
    }
    if (/^(?:set-content|add-content|clear-content|out-file|copy-item|sc|ac|cpi)$/.test(exec)) {
      markAdvisory('PowerShell 文件操作，需核对目标和改动范围', false);
    }
  }
  if (/\b(?:invoke-expression|iex|invoke-command|icm|start-process|saps|add-type|register-scheduledtask|start-bitstransfer|downloadstring|webclient|httpclient|net\.sockets|process\]::start)\b/i.test(unquoted)) {
    markAdvisory('脚本涉及系统、网络或动态执行 API，需核对完整代码与意图', true);
  }
  if (/(?:^|[\\/\s"'])\.\.(?:[\\/\s"']|$)/.test(command)) {
    markAdvisory('路径含跨级相对目录，需核对实际作用范围', true);
  }
  return intentReason ? { floorTier: 'tier_b_intent_gated', hardFloor, reason: intentReason }
    : { floorTier: 'standard', hardFloor: false };
}
