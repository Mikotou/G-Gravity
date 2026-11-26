import { isShellToolName } from './shell-mutation-policy';
import { isPureReadOnlyLookupTool } from './mcp-network-policy';
import { SAFE_PWSH_EXIT_GUARD_RE } from './shell-lexer';


/**
 * 为转交人工审理或审计的命令/工具调用生成清晰的人类可读「代码明确用意」与「作用范围」说明。
 */
export function describeOperationIntent(
  command: string,
  cwd: string,
  toolName = 'run_command',
  rawInput?: unknown,
  segments: string[] = []
): { meaning: string; target: string } {
  const rec = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  const declaredSummary =
    typeof rec.toolSummary === 'string' && rec.toolSummary.trim()
      ? rec.toolSummary.trim()
      : typeof rec.description === 'string' && rec.description.trim()
        ? rec.description.trim()
        : '';

  const filePath =
    typeof rec.Path === 'string'
      ? rec.Path
      : typeof rec.path === 'string'
        ? rec.path
        : typeof rec.file_path === 'string'
          ? rec.file_path
          : typeof rec.filePath === 'string'
            ? rec.filePath
            : typeof rec.DirectoryPath === 'string'
              ? rec.DirectoryPath
              : typeof rec.SearchPath === 'string'
                ? rec.SearchPath
                : '';

  // 0. 只读文件读取 / 目录列举 / 代码搜索工具的精确用意解析
  if (/^(read|read_file|view_file|view_file_outline|view_code_item|list_dir|glob|find_by_name|grep|grep_search|search)$/i.test(toolName)) {
    const isSearch = /^(grep|grep_search|search|glob|find_by_name)$/i.test(toolName);
    const queryHint =
      typeof rec.Query === 'string'
        ? `（检索词：\`${rec.Query.slice(0, 48)}\`）`
        : typeof rec.Pattern === 'string'
          ? `（匹配模式：\`${rec.Pattern.slice(0, 48)}\`）`
          : '';
    const targetDisplay = filePath || command.replace(/^\S+\s+/, '').trim() || cwd;
    const summaryPart = declaredSummary ? `（目的：${declaredSummary}）` : '';
    return {
      meaning: isSearch
        ? `只读检索目录或代码内容 \`${targetDisplay}\`${queryHint}${summaryPart}，不修改任何文件`
        : `只读读取本地文件或目录 \`${targetDisplay}\`${summaryPart}，不修改任何文件内容`,
      target: `读取目标：${targetDisplay}`,
    };
  }

  // 1. 文件编辑 / 创建类工具的精确代码用意解析
  if (/^(edit|edit_file|replace)$/i.test(toolName) || (filePath && ('Target' in rec || 'oldText' in rec || 'old_string' in rec))) {
    const oldStr = String(rec.Target ?? rec.oldText ?? rec.old_string ?? '');
    const newStr = String(rec.Replacement ?? rec.newText ?? rec.new_string ?? '');
    const oldLines = oldStr ? oldStr.split(/\r?\n/).length : 0;
    const newLines = newStr ? newStr.split(/\r?\n/).length : 0;
    const symMatch = /(?:function|class|interface|type|const|export\s+(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/.exec(
      `${newStr}\n${oldStr}`
    );
    const symDesc = symMatch ? `（涉及符号 \`${symMatch[1]}\`）` : '';
    const summaryPart = declaredSummary ? `（任务目标：${declaredSummary}）` : '';
    return {
      meaning: `修改源码文件 ${filePath || '目标文件'}：将 ${oldLines} 行旧代码替换为 ${newLines} 行新代码${symDesc}${summaryPart}`,
      target: `目标文件：${filePath || cwd}`,
    };
  }

  if (/^(write|write_file|create_file)$/i.test(toolName) || (filePath && ('Content' in rec || 'content' in rec))) {
    const content = String(rec.Content ?? rec.content ?? '');
    const lineCount = content ? content.split(/\r?\n/).length : 0;
    const modeLabel = rec.Append ? '向文件末尾追加内容' : rec.Overwrite ? '覆写/更新整份文件' : '新建并写入文件';
    return {
      meaning: `${modeLabel} ${filePath || '目标文件'}（共 ${lineCount} 行代码/文本）${declaredSummary ? `，用于：${declaredSummary}` : ''}`,
      target: `目标文件：${filePath || cwd}`,
    };
  }

  // 1.5 删除 / 移动类工具的精确用意解析
  if (/^(?:delete|remove|rm|unlink|move|rename)/i.test(toolName)) {
    const targetDisplay = filePath || command.replace(/^\S+\s+/, '').trim() || cwd;
    const summaryPart = declaredSummary ? `（任务目标：${declaredSummary}）` : '';
    return {
      meaning: `删除或移动文件/资源 \`${targetDisplay}\`${summaryPart}`,
      target: `目标路径：${targetDisplay}`,
    };
  }

  // 1.8 非 Shell 结构化 / MCP / 文档与网络检索工具（绝不再误报为“在终端执行命令”）
  const hasShellCommandField =
    typeof rec.command === 'string' || typeof rec.cmd === 'string' || typeof rec.CommandLine === 'string';
  if (!isShellToolName(toolName) && !hasShellCommandField) {
    const queryVal =
      typeof rec.query === 'string'
        ? rec.query
        : typeof rec.q === 'string'
          ? rec.q
          : Array.isArray(rec.queries)
            ? rec.queries.map(String).join(', ')
            : typeof rec.chunk_id === 'string'
              ? rec.chunk_id
              : typeof rec.url === 'string'
                ? rec.url
                : typeof rec.uri === 'string'
                  ? rec.uri
                  : typeof rec.Uri === 'string'
                    ? rec.Uri
                    : typeof rec.domain === 'string'
                      ? rec.domain
                      : '';
    const summaryPrefix = declaredSummary ? `【任务目标：${declaredSummary}】` : '';
    if (isPureReadOnlyLookupTool(toolName, toolName === 'other' || toolName === 'fetch' ? toolName : 'other', rec)) {
      const paramHint = queryVal ? `（检索目标：\`${queryVal.slice(0, 72)}\`）` : '';
      return {
        meaning: `${summaryPrefix}只读调用文档/检索工具 \`${toolName}\`${paramHint}，不修改本地文件`,
        target: `工具目标：${queryVal ? queryVal.slice(0, 120) : toolName}`,
      };
    }
    const argPairs = Object.entries(rec)
      .filter(([k]) => k !== 'toolSummary' && k !== 'description' && k !== 'toolName')
      .slice(0, 3)
      .map(([k, v]) => {
        const str = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}=${(str || '').slice(0, 40)}`;
      });
    const argHint = argPairs.length > 0 ? `（参数：${argPairs.join(', ')}）` : '';
    return {
      meaning: `${summaryPrefix}调用外部/扩展工具 \`${toolName}\`${argHint}`,
      target: `扩展工具：${toolName} · 工作目录：${cwd}`,
    };
  }

  // 2. Shell / PowerShell / 脚本命令的分步语义解析
  const parts = segments.length > 0 ? segments : [command.trim()];
  const stepDescriptions: string[] = [];

  for (const seg of parts.slice(0, 4)) {
    const rawClean = seg.trim();
    if (!rawClean) continue;
    const unwrapped = SAFE_PWSH_EXIT_GUARD_RE.exec(rawClean)?.[1]?.trim();
    const clean = unwrapped || rawClean;
    const prefixGuard = unwrapped ? '前序成功后' : '';
    const lower = clean.toLowerCase();

    if (/^(?:pwd|get-location|gl)\s*$/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}查询当前终端所在工作目录路径`);
    } else if (/^git\s+status\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}只读检查 Git 仓库未提交变更状态`);
    } else if (/^git\s+(?:diff|log|show|branch|rev-parse|ls-files|blame)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}只读查看 Git 版本库信息（${clean.slice(0, 48)}）`);
    } else if (/^git\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|clean|stash)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}执行 Git 仓库状态修改或远端同步（${clean.slice(0, 60)}）`);
    } else if (/^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|uninstall|update)\b/i.test(clean) || /^pip3?\s+install\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}安装/变更项目依赖包并更新锁文件（${clean.slice(0, 64)}）`);
    } else if (/^(?:npm|pnpm|yarn|npx)\s+(?:run\s+)?(?:test|vitest|jest|playwright)\b/i.test(clean) || /^(?:pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}运行自动化单元测试校验代码逻辑（${clean.slice(0, 60)}）`);
    } else if (/^(?:npm|pnpm|yarn|npx)\s+(?:run\s+)?(?:build|typecheck|tsc|vite|dist|electron-builder|lint|check)\b/i.test(clean) || /^tsc\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}执行类型检查或编译打包构建产物（${clean.slice(0, 64)}）`);
    } else if (/^(?:rm|rmdir|rd|del|erase|remove-item|ri)\b/i.test(clean)) {
      const recursive = /(?:-rf|-r|-recurse|--force|\/s)/i.test(clean);
      stepDescriptions.push(`${prefixGuard}${recursive ? '递归强制删除' : '删除'}本地文件或目录（${clean.slice(0, 72)}）`);
    } else if (/^(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}向外部服务发起 HTTP 网络请求获取或提交数据（${clean.slice(0, 72)}）`);
    } else if (/^(?:node|python|python3|py)\s+(?:-e|--eval|-c)\b/i.test(clean)) {
      const capabilities: string[] = [];
      const hasFileWriteOrDelete =
        /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|unlink(?:Sync)?|rmSync|rmdir(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?|copyFile(?:Sync)?|cpSync|mkdir(?:Sync)?|shutil\.(?:rmtree|move|copy)|os\.(?:remove|unlink|rmdir|rename|replace)|\.write_text\b|\.write_bytes\b)\b|open\s*\([^)]*,\s*['"][^'"]*[wax+]/i.test(
          clean
        );
      const hasFileRead =
        /\b(?:readFile(?:Sync)?|readdir(?:Sync)?|stat(?:Sync)?|existsSync|createReadStream|pathlib|\bfs\b)\b|\bopen\s*\(/i.test(
          clean
        );
      if (hasFileWriteOrDelete) capabilities.push('写入/删除本地文件');
      else if (hasFileRead) capabilities.push('只读本地文件');
      if (/sqlite|DatabaseSync/i.test(clean)) capabilities.push('访问 SQLite 数据库');
      if (/child_process|spawn|execSync|execFile|subprocess|os\.system|os\.popen/i.test(clean)) capabilities.push('拉起外部子进程');
      if (/\bfetch\s*\(|\b(?:https?|urllib|requests|httpx|socket)\b/i.test(clean)) capabilities.push('发起网络请求');
      const capStr = capabilities.length ? `（脚本内含：${capabilities.join('、')}）` : '';
      stepDescriptions.push(`${prefixGuard}直接执行内联脚本代码${capStr}`);
    } else if (/^(?:node|python|python3|ts-node|tsx)\s+\S+/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}运行本地脚本文件（${clean.slice(0, 72)}）`);
    } else if (/^(?:get-childitem|gci|dir|ls|get-item|gi|test-path|resolve-path|select-string|sls|rg|grep|findstr|cat|get-content|gc|type|head|tail|wc|stat)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}只读枚举本地目录或检索文本内容（${clean.slice(0, 64)}）`);
    } else if (/^\$[A-Za-z_]\w*\s*=\s*(?:get-content|gc|get-childitem|gci|import-csv|select-string|get-item)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}只读读取本地文件并存入变量用于内存分析（${clean.slice(0, 64)}）`);
    } else if (/^(?:select-object|select|where-object|where|sort-object|sort|group-object|measure-object|format-table|format-list|out-string|foreach-object|convertfrom-json|convertto-json|write-host|write-output)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}在内存中筛选/统计/格式化输出字段（${clean.slice(0, 56)}）`);
    } else if (/^(?:get-process|gps|stop-process|taskkill|kill)\b/i.test(clean)) {
      stepDescriptions.push(lower.startsWith('get-process') || lower === 'gps' ? '只读查询当前运行中的系统进程状态' : `终止指定系统进程（${clean.slice(0, 60)}）`);
    } else {
      stepDescriptions.push(`${prefixGuard}在终端执行命令 \`${clean.slice(0, 72)}\``);
    }
  }

  if (parts.length > 4) {
    stepDescriptions.push(`等共 ${parts.length} 步串联操作`);
  }

  // 剥离引号内字面量后再检测真实 Shell 重定向，避免把 JS 箭头函数 `=>` 或比较符 `> 1000` 误判为重定向写入
  const unquotedForRedirect = command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const hasRealRedirect = /(?:^|[^-=!<>])(?:[12*&]?)>{1,2}(?!\s*&)/.test(unquotedForRedirect);
  const redirectNote = hasRealRedirect && !/\$LASTEXITCODE\s*-eq/.test(command) ? '（含输出重定向写入）' : '';
  const pipeNote = parts.length > 1 && command.includes('|') ? '（管道传递处理）' : '';
  const summaryPrefix = declaredSummary ? `【任务目标：${declaredSummary}】` : '';
  const meaning =
    stepDescriptions.length > 0
      ? `${summaryPrefix}${stepDescriptions.join(' → ')}${pipeNote}${redirectNote}`
      : `${summaryPrefix}请求调用 ${toolName}：${command.slice(0, 140)}`;

  return {
    meaning,
    target: `工作目录：${cwd}`,
  };
}
