export interface ShellAnalysis {
  segments: string[];
  tokens: string[];
  complex: boolean;
  malformed: boolean;
  hasUnsafeSyntax?: boolean;
  segmentTokens?: string[][];
  operators?: Array<'|' | ';' | '&&'>;
}

export function stripMatchingQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

export const SAFE_PWSH_EXIT_GUARD_RE = /^if\s*\(\s*\$LASTEXITCODE\s*-eq\s*0\s*\)\s*\{\s*([\s\S]+?)\s*\}\s*$/i;

/** 在单个命令片段内保留引号包住的参数边界，同时记录未闭合引号和需要人工判断的动态语法。 */
function hereStringEnd(text: string, start: number): number | undefined {
  const quote = text[start + 1];
  if (text[start] !== '@' || (quote !== "'" && quote !== '"') || !/^\r?\n/.test(text.slice(start + 2, start + 4))) return;
  const marker = '\n' + quote + '@';
  const end = text.indexOf(marker, start + 2);
  return end < 0 ? -1 : end + marker.length;
}

function tokenizeSimpleSegment(rawSegment: string): { tokens: string[]; hasUnsafeSyntax: boolean; malformed: boolean } {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let hasUnsafeSyntax = false;
  let malformed = false;

  const flush = () => {
    if (token) {
      tokens.push(stripMatchingQuotes(token));
      token = '';
    }
  };

  for (let i = 0; i < rawSegment.length; i++) {
    const c = rawSegment[i];
    const next = rawSegment[i + 1] || '';
    if (!quote && c === '@') {
      const end = hereStringEnd(rawSegment, i);
      if (end === -1) { malformed = true; break; }
      if (end !== undefined) {
        const literal = rawSegment.slice(i, end);
        token += literal;

        if (next === '"' || literal.includes('\0')) hasUnsafeSyntax = true;
        i = end - 1;
        continue;
      }
    }
    if (quote) {
      token += c;
      if (c === quote) {
        quote = '';
      } else if (quote === '"' && (c === '`' || c === '$')) {
        hasUnsafeSyntax = true;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      token += c;
      continue;
    }
    if (c === '\0') {
      malformed = true;
      continue;
    }
    if (c === '$' || c === '`' || c === '>' || c === '<' || c === '(' || c === ')' || c === '{' || c === '}') {
      hasUnsafeSyntax = true;
    }
    if (c === '%' && /%[A-Za-z_][\w]*%/.test(rawSegment.slice(i))) {
      hasUnsafeSyntax = true;
    }
    if (c === '&' && next !== '&') {
      hasUnsafeSyntax = true;
    }
    if (/\s/.test(c)) {
      flush();
    } else {
      token += c;
    }
  }
  flush();
  if (quote) malformed = true;
  return { tokens, hasUnsafeSyntax, malformed };
}

/**
 * 词法与多段管道切分器：
 * - 正确识别单双引号内的管道符 `|`、分号 `;`、反斜杠路径与正则模式（如 `Select-String -Pattern "A|B"`）；
 * - 对命令替换 `$()` / `` ` ``、变量展开 `$VAR`、输出重定向 `>` / `<`、任意脚本块 `{...}` 严格标记 `hasUnsafeSyntax = true` 转交人工。
 */
export function parseShellCommand(command: string): ShellAnalysis {
  const segments: string[] = [];
  const tokens: string[] = [];
  const segmentTokens: string[][] = [];
  const operators: Array<'|' | ';' | '&&'> = [];

  let segment = '';
  let token = '';
  let quote = '';
  let complex = false;
  let hasUnsafeSyntax = false;
  let malformed = false;

  const flushToken = () => {
    if (token) {
      tokens.push(token);
      token = '';
    }
  };
  // 按出现顺序同时保存片段和连接符。后续分类需要知道某段是独立命令还是上一段的管道下游。
  const flushSegment = (op?: '|' | ';' | '&&') => {
    flushToken();
    const trimmed = segment.trim();
    if (trimmed) {
      segments.push(trimmed);
      if (op) operators.push(op);
      const unwrapped = SAFE_PWSH_EXIT_GUARD_RE.exec(trimmed)?.[1]?.trim() ?? trimmed;
      const sub = tokenizeSimpleSegment(unwrapped);
      if (sub.malformed) malformed = true;
      if (sub.hasUnsafeSyntax) hasUnsafeSyntax = true;
      segmentTokens.push(sub.tokens);
    }
    segment = '';
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1] || '';
    if (!quote && c === '@') {
      const end = hereStringEnd(command, i);
      if (end === -1) { malformed = true; break; }
      if (end !== undefined) {
        const literal = command.slice(i, end);
        token += literal;
        segment += literal; complex = true;
        if (next === '"' || literal.includes('\0')) hasUnsafeSyntax = true;
        i = end - 1;
        continue;
      }
    }

    if (quote) {
      segment += c;
      token += c;
      if (c === quote) {
        quote = '';
      } else if (quote === '"' && (c === '`' || c === '$')) {
        complex = true;
        hasUnsafeSyntax = true;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      segment += c;
      token += c;
      continue;
    }

    if (c === '\0') {
      malformed = true;
      continue;
    }

    if (c === '&' && next === '&') {
      complex = true;
      flushSegment('&&');
      i++;
      continue;
    }

    if (c === '|' && next === '|') {
      complex = true;
      hasUnsafeSyntax = true;
      flushSegment(';');
      i++;
      continue;
    }

    if (c === '|') {
      complex = true;
      flushSegment('|');
      continue;
    }

    if (c === ';' || c === '\r' || c === '\n') {
      complex = true;
      flushSegment(';');
      continue;
    }

    if (c === '&') {
      complex = true;
      hasUnsafeSyntax = true;
      flushSegment(';');
      continue;
    }

    if ('$`><(){}[]%!*?^'.includes(c)) {
      complex = true;
      if ('`><'.includes(c)) {
        hasUnsafeSyntax = true;
      }
    }

    segment += c;
    if (/\s/.test(c)) flushToken();
    else token += c;
  }

  flushSegment();
  if (quote) malformed = true;

  return { segments, tokens, complex, malformed, hasUnsafeSyntax, segmentTokens, operators };
}
