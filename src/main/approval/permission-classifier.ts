import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AcpRequestPermissionParams } from '../../shared/acp-protocol';
import {
  type ApprovalFloorTier, type ApprovalMode, type ApproveForMeConfig, type PendingApprovalRequest,
} from '../../shared/approval-contract';
import { redactSecretsForReviewer } from '../security/redaction';
import {
  assessShellHighRiskFloor, compileSafePattern, credentialInspectionText, downloadUsesCredentials,
  networkTargetFloor, isCatastrophicSystemCommand, inspectGeminiPathPolicy,
  isDestructiveOrPrivilegedToolName, isMutatingShellCommand, isPureReadOnlyLookupTool,
  isReadOnlyScriptReviewCandidate, isShellToolName, isWorkspaceMaintenanceCommand, parseShellCommand,
  readOnlySearchScope, readonlyWriteReason, screenCommand, sensitiveTarget,
} from './shell-screening';
import { EXECUTABLE_OR_SCRIPT_EXT_RE } from '../../shared/media-contract';

// A proposed write may create its final directories. Resolve the nearest existing
// ancestor, and fail closed on inaccessible paths and dangling links.
function realPathForWrite(path: string): string {
  if (sensitiveTarget(path)) throw new Error('受保护路径');
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    try { return join(realpathSync(current), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || lstatSync(current, { throwIfNoEntry: false })) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function isPathWithinWorkspace(targetPath: string, workspaceCwd: string, baseCwd = workspaceCwd): boolean {
  if (!targetPath || !isAbsolute(workspaceCwd) || targetPath.split(/[\\/]/).includes('..')) return false;
  try {
    const workspace = realPathForWrite(resolve(workspaceCwd));
    const target = realPathForWrite(resolve(baseCwd, targetPath));
    const rel = relative(workspace, target);
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
  } catch { return false; }
}

/** Cross-workspace document edits in Turbo use resolved ordinary files in user-owned locations. */
function isUserDocument(target: string, cwd: string): boolean {
  const document = /\.(?:txt|md|rst|adoc|csv)$/i;
  if (!document.test(target)) return false;
  try {
    const path = realPathForWrite(resolve(cwd, target));
    if (!document.test(path)) return false;
    return [tmpdir(), homedir()].some(root => {
      const rel = relative(realPathForWrite(root), path);
      return rel && !isAbsolute(rel) && !rel.split(sep).some(p =>
        p.startsWith('.') || /^(?:Library|AppData|Application Data|Startup|Start Menu)$/i.test(p));
    });
  } catch { return false; }
}

function collectCandidatePaths(rawObj?: Record<string, unknown>, locations?: Array<{ path: string }>): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, pathField = false): void => {
    if (typeof value === 'string') {
      if (pathField && value.trim()) paths.push(value.trim());
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:content|codecontent|replacement|targetcontent|oldtext|newtext|old_string|new_string|body)$/i.test(key)) continue;
      visit(child, pathField || /(?:paths?|files?|directory|directories|cwd|source|destination|workingdirectory|filepath|filename)$/i.test(key));
    }
  };
  visit(rawObj);
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      if (loc && typeof loc.path === 'string' && loc.path.trim()) paths.push(loc.path.trim());
    }
  }
  return paths;
}

/** 提取真实工具标识：当 ACP 仅标注笼统的 other/fetch 时优先使用 title 或 MCP Server/Tool 名，避免丢失工具身份。 */
function resolveToolName(params: AcpRequestPermissionParams, rawObj?: Record<string, unknown>): string {
  if (rawObj && typeof rawObj.toolName === 'string' && rawObj.toolName.trim()) {
    return rawObj.toolName.trim();
  }
  const declaredKind = (params.toolCall.kind || '').trim().toLowerCase();
  const rawTitle = (params.toolCall.title || '').trim();
  if (!declaredKind || declaredKind === 'other' || declaredKind === 'fetch') {
    if (
      rawObj &&
      typeof rawObj.ServerName === 'string' &&
      rawObj.ServerName.trim() &&
      typeof rawObj.ToolName === 'string' &&
      rawObj.ToolName.trim()
    ) {
      return `mcp_${rawObj.ServerName.trim()}_${rawObj.ToolName.trim()}`;
    }
    if (rawTitle && rawTitle.toLowerCase() !== 'other' && rawTitle.toLowerCase() !== 'fetch') {
      return rawTitle;
    }
    return declaredKind || '未知工具';
  }
  return params.toolCall.kind || rawTitle || '未知工具';
}

/** 为明确的非 Shell 扩展工具构造安全的会话前缀；匿名 other 或自然语言标题不授予宽泛前缀。 */
function buildSafeToolPrefix(toolName: string, declaredKind: string, isReadOnlyLookup: boolean): string | undefined {
  const trimmed = (toolName || '').trim();
  const lower = trimmed.toLowerCase();
  if (
    trimmed &&
    lower !== 'other' &&
    lower !== 'fetch' &&
    lower !== '未知工具' &&
    /^[a-zA-Z0-9._:/-]{2,80}$/.test(trimmed)
  ) {
    return `tool:${trimmed}`;
  }
  if (isReadOnlyLookup) {
    return declaredKind === 'fetch' ? 'fetch_read' : 'search_docs';
  }
  return undefined;
}

function parameterStrings(values: unknown[]): string[] {
  const result: string[] = [];
  const pending = [...values];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') result.push(current);
    else if (current && typeof current === 'object') for (const value of Object.values(current)) pending.push(value);
  }
  return result;
}

const allowedMetaKeys = new Set([
  'command', 'cmd', 'CommandLine', 'toolName', 'description', 'Description', 'toolSummary', 'ToolSummary',
  'NotificationTimeoutSeconds', 'SafeToAutoRun', 'Blocking', 'OutputCharacterCount', 'WaitForPreviousTools',
  'WaitMsBeforeAsync', 'IsDaemon', 'cwd', 'Cwd', 'DirectoryPath', 'WorkingDirectory', 'timeout', 'timeoutMs',
]);

export function classifyPermission(params: AcpRequestPermissionParams, cwd: string, config: ApproveForMeConfig,
  mode: ApprovalMode, now: number) {
  const raw = params.toolCall.rawInput;
  const rawObj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const declaredKind = (params.toolCall.kind || '').toLowerCase();
  const rawTitle = (params.toolCall.title || '').trim();
  const toolName = resolveToolName(params, rawObj);

  // 同时兼容标准 command/cmd 与官方 agy acp 的 PascalCase CommandLine / Path / Query
  const candidatePaths = collectCandidatePaths(rawObj, params.toolCall.locations);
  if (typeof raw === 'string' && ['read', 'search'].includes(declaredKind)) candidatePaths.push(raw);
  const commandKind = declaredKind === 'execute' || isShellToolName(toolName);
  const commandField = [rawObj?.command, rawObj?.cmd, rawObj?.CommandLine].find(value => typeof value === 'string');
  const location = ['read', 'search'].includes(declaredKind) ? params.toolCall.locations?.[0]?.path : undefined;
  const pathField = [rawObj?.Path, rawObj?.path, rawObj?.DirectoryPath, rawObj?.SearchPath, location || undefined]
    .find(value => typeof value === 'string');
  let command = [toolName, ...candidatePaths].join(' ');
  if (typeof raw === 'string') {
    if (commandKind) command = raw;
  } else if (commandField !== undefined) {
    command = commandField;
  } else if (pathField !== undefined) {
    command = `${toolName} ${pathField}`;
  } else if (commandKind) {
    command = JSON.stringify(raw || {});
  }

  const parsed = parseShellCommand(command.slice(0, 32_768));
  const screening = screenCommand(command, cwd, { ...config, mode: mode === 'manual' ? 'rules-only' : mode }, toolName, raw, parsed);

  // 只读工具也要检查参数的实际用途。含命令或修改字段的请求会进入更严格的分支。
  const hasMutationFields = Boolean(
    rawObj &&
      Object.keys(rawObj).some((k) =>
        /^(Content|content|CodeContent|Replacement|ReplacementChunks|newText|new_string|Target|oldText|old_string|CommandLine|command|cmd|Overwrite|Append)$/.test(k)
      )
  );

  const isPureReadOrSearchTool =
    !['edit', 'delete', 'move', 'execute'].includes(declaredKind) &&
    !hasMutationFields &&
    (declaredKind === 'read' ||
      declaredKind === 'search' ||
      (Boolean(rawObj) &&
        /^(read|read_file|view_file|view_file_outline|view_code_item|list_dir|glob|find_by_name|grep|grep_search|search)$/i.test(
          toolName
        )));

  const isPureReadOnlyWebOrMcpTool =
    !isPureReadOrSearchTool && !hasMutationFields && isPureReadOnlyLookupTool(toolName, declaredKind, rawObj);

  const isEditOrWriteTool =
    declaredKind === 'edit' ||
    (Boolean(rawObj) && /^(edit|edit_file|replace|replace_file_content|multi_replace_file_content|write|write_file|write_to_file|create_file)$/i.test(toolName));

  const isDeleteOrMoveTool =
    declaredKind === 'delete' ||
    declaredKind === 'move' ||
    /^(delete|remove|rm|unlink|move|rename)/i.test(toolName);

  const scope = commandKind && command.length <= 32_768 ? readOnlySearchScope(command, cwd, parsed, raw) : undefined;
  const policyOperands = (scope?.operands ?? parsed.segmentTokens?.flat() ?? []);
  const rawSerialized = [commandKind ? policyOperands.join(' ') : '', ...candidatePaths].join(' ');
  const explicitCwd = rawObj && (rawObj.cwd ?? rawObj.Cwd ?? rawObj.WorkingDirectory);
  const customCwd = explicitCwd ?? rawObj?.DirectoryPath;
  const fileBase = commandKind ? customCwd : explicitCwd;
  const baseCwd = typeof fileBase === 'string' && fileBase.trim() ? resolve(cwd, fileBase) : cwd;
  const hasOutOfScopeCwd =
    typeof customCwd === 'string' && customCwd.trim() !== '' && !isPathWithinWorkspace(customCwd, cwd);
  const hasOutOfScopeLocations = Boolean(
    params.toolCall.locations?.some((loc) => !loc?.path || !isPathWithinWorkspace(loc.path, cwd, baseCwd))
  );
  let escapedCredentialLink = false;
  const realTargets = [...new Set([baseCwd, ...candidatePaths.map(path => resolve(baseCwd, path))])].flatMap(path => {
    try {
      const actual = realPathForWrite(path);
      // A workspace link cannot grant its credential-named external destination a source-file exemption.
      if (relative(path, actual) && !isPathWithinWorkspace(actual, cwd) &&
          isForbiddenCredentialOrStatePath(actual.replace(/\.[a-z\d]+$/i, ''))) escapedCredentialLink = true;
      return [actual];
    } catch { return []; }
  });
  const geminiPolicy = inspectGeminiPathPolicy(rawSerialized, [...candidatePaths, ...realTargets], cwd);
  const isMutatingToolOperation =
    isEditOrWriteTool ||
    isDeleteOrMoveTool ||
    (hasMutationFields && !commandKind) ||
    (commandKind && !scope && isMutatingShellCommand(command, parsed));

  const withinWorkspace =
    !hasOutOfScopeCwd &&
    !hasOutOfScopeLocations &&
    candidatePaths.every((p) => isPathWithinWorkspace(p, cwd, baseCwd));

  const hasUserRules = config.denyPatterns.length || config.askPatterns.length;
  const ruleTargets = hasUserRules ? [command, ...candidatePaths, ...parameterStrings(rawObj ? Object.values(rawObj) : [])] : [];
  const matchRule = (patterns: string[]) => patterns.find(pattern => {
    const regex = compileSafePattern(pattern);
    return ruleTargets.some(value => regex.test(value));
  });
  const explicitDenyRule = matchRule(config.denyPatterns);
  const explicitAskRule = Boolean(matchRule(config.askPatterns));
  let floorTier: ApprovalFloorTier = 'standard';
  let readOnly = false;
  let turboEligible = false;
  let turboBlocked = false;
  let explicitToolPrefix: string | undefined;
  let toolArguments: string | undefined;
  const gate = (tier: Exclude<ApprovalFloorTier, 'standard'>, reason: string, blockTurbo = tier === 'tier_a_immutable') => {
    if (blockTurbo) turboBlocked = true;
    if (floorTier === 'tier_a_immutable') return;
    floorTier = tier;
    screening.verdict = 'force_ask';
    screening.riskLevel = 'high';
    screening.commandPrefix = undefined;
    screening.explanation.risk = reason;
  };
  const deny = (reason: string) => {
    floorTier = 'tier_a_immutable';
    turboBlocked = true;
    screening.verdict = 'deny';
    screening.riskLevel = 'critical';
    screening.commandPrefix = undefined;
    screening.explanation.risk = reason;
  };
  const extras = commandKind && rawObj ? Object.entries(rawObj).filter(([key]) => !allowedMetaKeys.has(key)) : [];
  const extraStrings = parameterStrings(extras.map(([, value]) => value));
  const authenticatedDownload = (commandKind && downloadUsesCredentials(command)) || extraStrings.some(downloadUsesCredentials);
  const credentialInputs = [...(commandKind ? [command] : []), ...extraStrings];
  if (explicitDenyRule) {
    screening.matchedRule = explicitDenyRule;
    deny('命中用户拒绝规则');
  } else if (escapedCredentialLink || credentialInputs.some(value => sensitiveTarget(authenticatedDownload ? credentialInspectionText(value) : value)) ||
      [...candidatePaths, ...realTargets].some(sensitiveTarget) || geminiPolicy.tier === 'forbidden') {
    deny(geminiPolicy.reason && geminiPolicy.tier === 'forbidden' ? geminiPolicy.reason : '完整工具参数涉及敏感凭据、密钥或私有认证状态文件，客户端硬性拒绝');
  } else if ((geminiPolicy.tier === 'readonly_official' || geminiPolicy.tier === 'unknown_gemini') &&
      (isMutatingToolOperation || extras.length > 0 || (!isPureReadOrSearchTool && !commandKind))) {
    deny(readonlyWriteReason(geminiPolicy));
  } else if (screening.verdict === 'deny') {
    floorTier = 'tier_a_immutable';
    turboBlocked = true;
  } else if (extraStrings.some(isCatastrophicSystemCommand)) {
    deny('附加工具参数涉及系统级不可逆操作');
  } else if (explicitAskRule) {
    gate('tier_a_immutable', '命中用户要求人工确认的规则', true);
  } else if (geminiPolicy.tier === 'unknown_gemini') {
    gate('tier_a_immutable', '目标位于 .gemini 未分类子目录，请人工核对后读取', true);
  } else if (geminiPolicy.tier === 'user_custom' && isMutatingToolOperation) {
    gate('tier_a_immutable', '修改 .gemini 用户自定义配置，需要人工确认', true);
  } else {
    const network = networkTargetFloor(rawObj, isEditOrWriteTool);
    if (network !== 'standard') {
      gate(
        network,
        network === 'tier_a_immutable'
          ? '工具指向云元数据、内嵌凭据或受限 Google 内部服务（SSRF），必须人工确认'
          : '工具指向本机或内网目标，需核对用户意图',
        network === 'tier_a_immutable'
      );
    }
    if (commandKind) {
      const floor = assessShellHighRiskFloor(command, parsed, config.enableSafeDownloadAutoApprove && screening.verdict !== 'auto_approve', !scope, baseCwd);
      const commands = rawObj && ['command', 'cmd', 'CommandLine'].filter(key => key in rawObj);
      const conflicting = rawObj && (commands?.some(key => rawObj[key] !== command) ||
        ['cwd', 'Cwd', 'DirectoryPath', 'WorkingDirectory'].some(key => key in rawObj && (typeof rawObj[key] !== 'string' || rawObj[key] !== customCwd)));
      if ((typeof raw !== 'string' && !commands?.length) || conflicting) {
        gate('tier_b_intent_gated', '命令或工作目录不明确，需核对实际执行参数', true);
      } else if (floor.floorTier !== 'standard') {
        gate(floor.floorTier, floor.reason!, floor.hardFloor);
      }
      for (const detail of extraStrings) {
        if (!detail) continue;
        const detailFloor = assessShellHighRiskFloor(detail, parseShellCommand(detail.slice(0, 32_768)));
        if (detailFloor.floorTier === 'tier_a_immutable') {
          gate('tier_a_immutable', detailFloor.reason || '附加参数触及账号安全或凭据红线，必须人工确认', true);
          break;
        }
        if (detailFloor.hardFloor) {
          gate('tier_b_intent_gated', '附加参数包含高风险载荷，需结合用户意图复核', true);
          break;
        }
      }
      if (hasOutOfScopeCwd || hasOutOfScopeLocations || (scope && !scope.insideWorkspace)) {
        gate('tier_b_intent_gated', '终端执行目录或搜索目标超出当前工作区，需核对用户意图', true);
      } else if (extras.length) {
        gate('tier_b_intent_gated', '终端命令携带额外参数，需结合实际载荷复核', false);
      }
      readOnly = isReadOnlyScriptReviewCandidate(command, parsed) || Boolean(scope?.insideWorkspace);
      turboEligible = withinWorkspace && !extras.length && !screening.matchedRule && !floor.hardFloor &&
        (screening.verdict === 'auto_approve' || isWorkspaceMaintenanceCommand(parsed, baseCwd));
      if (floorTier === 'standard' && screening.verdict === 'force_ask' && readOnly) {
        screening.verdict = 'grey_zone';
        screening.explanation.risk = '只读脚本需复核其用途与用户意图';
      }
    } else if (isPureReadOrSearchTool || isPureReadOnlyWebOrMcpTool) {
      readOnly = true;
      turboEligible = withinWorkspace && network === 'standard';
      if ((hasOutOfScopeCwd || hasOutOfScopeLocations) && isPureReadOnlyWebOrMcpTool) {
        gate('tier_b_intent_gated', '工具携带工作区外位置，需核对用户意图', true);
      }
      if (floorTier === 'standard') {
        screening.verdict = 'auto_approve';
        screening.riskLevel = 'safe';
        screening.commandPrefix = isPureReadOrSearchTool ? (declaredKind === 'search' ? 'search' : 'read') : buildSafeToolPrefix(toolName, declaredKind, true);
        screening.explanation.risk = geminiPolicy.tier === 'readonly_official' ? '纯只读查阅官方资料，不含凭据且零写入'
          : geminiPolicy.tier === 'user_custom' ? '纯只读查阅 .gemini 用户自定义文件' : '纯只读查询，不含写入或凭据访问';
      }
    } else if (isEditOrWriteTool || isDeleteOrMoveTool) {
      const targets = [...candidatePaths, ...realTargets];
      const embeddedCommand = rawObj && ['command', 'cmd', 'CommandLine'].some(key => key in rawObj);
      const wholeWorkspace = isDeleteOrMoveTool && candidatePaths.some(path => !relative(resolve(cwd), resolve(baseCwd, path)));
      const dangerousTarget = embeddedCommand || wholeWorkspace || !candidatePaths.length ||
        targets.some(p => EXECUTABLE_OR_SCRIPT_EXT_RE.test(p) && !/\.(?:[cm]?js|ps1|sh|bash|cmd|bat|zsh|command)$/i.test(p) || /(?:^|[\\/])\.git(?:[\\/]|$)|\.(?:exe|vbs|vbe|wsf|wsh|msi|dll|sys|reg|pkg|dmg|app|dylib|plist)$/i.test(p));
      turboEligible = !dangerousTarget && candidatePaths.length > 0 && network === 'standard' && (withinWorkspace ||
        (isEditOrWriteTool && !isDeleteOrMoveTool && candidatePaths.every(p => isUserDocument(p, baseCwd))));
      if (dangerousTarget) {
        gate('tier_b_intent_gated', '涉及受控可执行文件、仓库内部状态或缺少明确路径，需核对用户意图', true);
      } else if (!withinWorkspace || isDeleteOrMoveTool || targets.some(p => /\.(?:sh|ps1|bat|cmd|bash|zsh|command)$/i.test(p))) {
        gate('tier_b_intent_gated', '脚本编辑、文件移动删除或跨工作区修改，需核对用户指定的目标', false);
      } else if (floorTier === 'standard') {
        screening.verdict = 'grey_zone';
        screening.riskLevel = 'medium';
        screening.commandPrefix = /^(?:write|write_file|write_to_file|create_file)$/i.test(rawTitle) || /^(?:write|write_file|write_to_file|create_file)$/i.test(toolName)
          ? 'write_file (当前工作区)' : 'edit_file (当前工作区)';
        screening.explanation.risk = '修改当前工作区内的源码或文档';
      }
    } else {
      const actualTool = typeof rawObj?.ToolName === 'string' ? rawObj.ToolName : toolName;
      const privileged = /(?:^|[_:/.-])(?:sudo|su|shell|bash|powershell|grant|revoke|exec|execute|format|shutdown|reboot)(?:$|[_:/.-])/i.test(actualTool);
      const hiddenCommand = [rawObj, rawObj?.Arguments].some(obj => obj && typeof obj === 'object' && ['command', 'cmd', 'CommandLine'].some(key => key in obj));
      const projectRecord = /^mcp_[\w.-]+_(?:create|update|edit|archive|close|delete|remove)_(?:issue|ticket|task|note|card|page)$/i.test(toolName) &&
        network === 'standard' && !hiddenCommand && !privileged && rawObj !== undefined &&
        Object.keys((rawObj.Arguments && typeof rawObj.Arguments === 'object' ? rawObj.Arguments : rawObj)).every(key =>
          /^(?:id|[\w]+Id|title|[\w]+Title|name|description|body|text|content|section|status|labels|priority|assignee|project|team|toolSummary)$/i.test(key));
      turboEligible = projectRecord;
      const needsHuman = privileged || hiddenCommand || (!projectRecord && isDestructiveOrPrivilegedToolName(actualTool));
      gate(
        'tier_b_intent_gated',
        needsHuman ? '扩展工具涉及破坏性操作、提权或隐藏的终端执行，需核对用户意图' : '扩展工具可能修改状态，需核对具体参数与用户意图',
        needsHuman
      );
      if (!needsHuman && network === 'standard') {
        screening.riskLevel = 'medium';
        if (withinWorkspace && !isDestructiveOrPrivilegedToolName(actualTool) && /^mcp_/i.test(toolName)) explicitToolPrefix = buildSafeToolPrefix(toolName, declaredKind, false);
      }
    }
    if ((extras.length || !commandKind) && !authenticatedDownload) {
      // The reviewer needs the actual arguments even when the card only shows a filename.
      toolArguments = redactSecretsForReviewer(JSON.stringify({ rawInput: raw, locations: params.toolCall.locations }));
    }
    if (command.length > 16_384 || (toolArguments && toolArguments.length > 16_384)) {
      gate('tier_a_immutable', '完整载荷超出复核上下文预算，AI 无法完整审查，请人工确认', true);
    }
  }
  if (authenticatedDownload) {
    screening.explanation.meaning = '下载资源（认证参数已省略）';
    screening.explanation.target = '下载请求的认证参数已省略';
  }

  const card: PendingApprovalRequest & { floorTier: ApprovalFloorTier } = {
    requestId: randomUUID(),
    sessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    toolName,
    commandOrSummary: authenticatedDownload ? '下载命令（认证参数已省略）' : redactSecretsForReviewer(command),
    cwd,
    createdAt: new Date(now).toISOString(),
    riskLevel: screening.riskLevel,
    floorTier,
    commandPrefix: floorTier === 'tier_a_immutable' ? undefined : explicitToolPrefix ??
      (floorTier === 'standard' && screening.verdict !== 'force_ask' ? screening.commandPrefix : undefined),
    explanation: screening.explanation,
    screeningSource:
      mode === 'manual' ? 'manual-mode' : screening.matchedRule ? 'regex-rule' : 'local-ast',
  };

  return { card, screen: screening, withinWorkspace, explicitAskRule, readOnly, toolArguments,
    turboEligible: turboEligible && !turboBlocked && floorTier !== 'tier_a_immutable' && !explicitAskRule };
}
