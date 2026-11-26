import { ShellAnalysis, parseShellCommand } from './shell-lexer';


/** Used by protected-path checks, deterministic screening and the human approval floor. */
export function mutatingFilterReason([program, ...args]: string[]): string | undefined {
  const exec = program?.toLowerCase().replace(/\.exe$/, '');
  if (exec === 'find' && args.some(arg => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/i.test(arg))) {
    return '`find` 包含写入、删除或执行动作，请人工确认';
  }
  if (exec === 'sort' && args.some(arg => {
    const option = arg.split('=', 1)[0];
    return /^-[a-zA-Z]*o/.test(arg) || /^\/o(?:utput)?(?::|$)/i.test(arg) ||
      (option.startsWith('--') && option.length > 2 && '--output'.startsWith(option));
  })) {
    return '`sort` 包含文件输出参数，请人工确认';
  }
  if (exec === 'uniq') {
    let optionsEnded = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!optionsEnded && arg === '--') {
        optionsEnded = true;
      } else if (!optionsEnded && arg !== '-' && arg.startsWith('-')) {
        // These options consume a numeric value. A lone '-' is a stream operand.
        if (/^(?:-[cduiDz]*[fsw]|--(?:skip-fields|skip-chars|check-chars))$/.test(arg) && /^\d+$/.test(args[i + 1])) i++;
      } else if (i + 1 < args.length) {
        return '`uniq` 的第二个文件参数可能写入输出文件，请人工确认';
      }
    }
  }
}

/**
 * 检测 Shell / PowerShell / macOS zsh 命令是否包含文件写入、覆盖、删除、重定向、属性修改或数据库写操作意图，
 * 用于在 `.gemini` 与 macOS `Application Support/Antigravity` 只读保护区准确区分“安全查阅”与“禁止篡改”。
 */
export function isMutatingShellCommand(command: string, parsed?: ShellAnalysis): boolean {
  if (!command) return false;
  if (/\b(?:find|sort|uniq)\b/i.test(command) && (parsed ?? parseShellCommand(command)).segmentTokens?.some(mutatingFilterReason)) return true;
  // 剥离引号内字面量以检测真实的重定向符号（避开 `->`、`=>` 及字符串内的 `>`）
  const unquoted = command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/(?:^|[^-=!<>])(?:[12*&]?)>{1,2}(?!\s*&)/.test(unquoted)) {
    return true;
  }
  return (
    /(?:^|[\s;|&(])(?:rm|rmdir|rd|del|erase|mv|move|ren|rename|cp|copy|ln|install|rsync|ditto|mkdir|mktemp|touch|truncate|chmod|chown|chflags|icacls|takeown|tee|dd|shred|remove-item|ri|set-content|sc|add-content|ac|out-file|clear-content|clc|new-item|ni|move-item|mi|rename-item|rni|copy-item|cpi)(?=$|[\s;|&)])/i.test(
      unquoted
    ) ||
    /\bfind\s[^;&|]*?-(?:exec(?:dir)?|ok(?:dir)?|delete|fprint0?|fprintf|fls)\b/i.test(unquoted) ||
    /\bsort\s[^;&|]*?(?:-o\b|--output\b)/i.test(unquoted) ||
    /\bxattr\s+(?:-[a-z]*[wdcr]|--(?:write|delete|clear))\b/i.test(unquoted) ||
    /\bplutil\s+-(?:replace|insert|remove|convert|create)\b/i.test(unquoted) ||
    /\bdefaults\s+(?:write|delete|import|rename)\b/i.test(unquoted) ||
    /\blaunchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|remove)\b/i.test(unquoted) ||
    /\bsed\s+-[a-z]*i\b|\bperl\s+-[a-z]*i\b/i.test(unquoted) ||
    /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rmSync|rmdirSync|renameSync|truncateSync|copyFile(?:Sync)?)\b/i.test(
      command
    ) ||
    /\b(?:shutil\.(?:copy\w*|rmtree|move)|os\.(?:remove|unlink|rename|replace|mkdir)|write_text|write_bytes|mkdirSync|createWriteStream)\b|open\s*\([^)]*,\s*['"][^'"]*[wax+]/i.test(command) ||
    /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|VACUUM)\b/i.test(command)
  );
}

export function isShellToolName(toolName: string): boolean {
  return /^(?:execute|run_command|bash|zsh|sh|powershell|pwsh|command|terminal)$/i.test((toolName || '').trim());
}
