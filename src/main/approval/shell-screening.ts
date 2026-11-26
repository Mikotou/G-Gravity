import { performance } from 'node:perf_hooks';
import { posix, win32 } from 'node:path';
import { type ApproveForMeConfig, type DeterministicScreeningResult } from '../../shared/approval-contract';
import { parseShellCommand } from './shell-lexer';
import { describeOperationIntent } from './intent-describer';
import { compileSafePattern, inspectGeminiPathPolicy, sensitiveTarget, readonlyWriteReason } from './path-and-gemini-policy';
import {
  readOnlySearchScope, downloadUsesCredentials, isFileDownload, credentialInspectionText,
  hasSearchExclusions, isBoundedWorkspaceDownload, commandWorkspaceCwd,
} from './shell-workspace-scope';
import { isMutatingShellCommand } from './shell-mutation-policy';
import { isCatastrophicSystemCommand, hasShellCommandSubstitution } from './shell-risk-floor';
import { SegmentTier, classifySegment } from './shell-segments';
import { cleanDevelopmentCommand } from './shell-validators';


export function screenCommand(
  command: string,
  cwd: string,
  config: ApproveForMeConfig,
  toolName = 'run_command',
  rawInput?: unknown,
  parsed = parseShellCommand(command.slice(0, 32768)),
): DeterministicScreeningResult {
  const start = performance.now();
  // 解析、规则匹配和界面说明使用不同长度的输入。原命令超过解析上限时直接要求人工确认。
  const sliced = command.slice(0, 32768);
  const intent = describeOperationIntent(sliced.slice(0, 4096), cwd, toolName, rawInput, parsed.segments);

  const result: DeterministicScreeningResult = {
    verdict: 'grey_zone',
    riskLevel: 'medium',
    extractedSegments: parsed.segments,
    explanation: {
      meaning: intent.meaning,
      target: intent.target,
      risk: '未命中自动放行白名单，转交人工核对该代码/命令用意后确认执行',
    },
    latencyMs: 0,
  };
  const finish = () => {
    result.latencyMs = performance.now() - start;
    return result;
  };
  const match = (rules: string[]) => rules.find((rule) => compileSafePattern(rule).test(sliced.slice(0, 8192)));

  if (command.length > 32768 || parsed.malformed || !command.trim()) {
    result.verdict = 'force_ask';
    result.riskLevel = 'high';
    result.explanation.risk = '命令为空、过长或引号未闭合，转交人工核对完整代码用意';
    return finish();
  }

  // 先检查绝对禁区与用户拒绝规则，再对 .gemini 路径做分级保护（只读区禁写、未分类区禁写+读前询问、用户自定义区修改前询问）。
  const deny = match(config.denyPatterns);
  const scope = readOnlySearchScope(sliced, cwd, parsed, rawInput);
  const pathTokens = scope?.operands ?? (parsed.segmentTokens || []).flat();
  const pathText = scope ? pathTokens.join(' ') : sliced;
  const geminiPolicy = inspectGeminiPathPolicy(pathText, pathTokens, cwd);
  const credentials = downloadUsesCredentials(sliced);
  const download = parsed.segmentTokens?.some(isFileDownload);
  const mutatingShell = !scope && (download || isMutatingShellCommand(sliced, parsed));

  if (
    sensitiveTarget(credentials ? credentialInspectionText(sliced) : sliced) ||
    sensitiveTarget(cwd) ||
    pathTokens.some(token => sensitiveTarget(credentials ? credentialInspectionText(token) : token)) ||
    (credentials && /(?:^|\s)--(?:netrc(?:-optional|-file)?|load-cookies|save-cookies|cookie-jar)(?:[=\s]|$)/i.test(sliced)) ||
    geminiPolicy.tier === 'forbidden' ||
    isCatastrophicSystemCommand(sliced) ||
    deny
  ) {
    result.verdict = 'deny';
    result.riskLevel = 'critical';
    result.matchedRule = deny;
    result.explanation.risk = deny
      ? '命中用户拒绝规则'
      : isCatastrophicSystemCommand(sliced)
        ? '命中系统级不可逆毁灭操作红线（格式化/清盘/根目录递归删除/关机），客户端硬性拒绝'
        : geminiPolicy.tier === 'forbidden' && geminiPolicy.reason
          ? geminiPolicy.reason
          : '涉及凭据、密钥或私有认证状态，客户端拒绝自动授权';
    return finish();
  }

  if ((geminiPolicy.tier === 'readonly_official' || geminiPolicy.tier === 'unknown_gemini') && mutatingShell) {
    result.verdict = 'deny';
    result.riskLevel = 'critical';
    result.explanation.risk = readonlyWriteReason(geminiPolicy);
    return finish();
  }

  if (credentials) {
    result.verdict = 'force_ask';
    result.riskLevel = 'high';
    result.explanation.risk = '下载请求包含认证参数，请人工确认';
    return finish();
  }

  const ask = match(config.askPatterns);
  if (ask) {
    result.verdict = 'force_ask';
    result.matchedRule = ask;
    result.explanation.risk = '命中用户要求人工确认的规则';
    return finish();
  }

  if (geminiPolicy.tier === 'unknown_gemini') {
    result.verdict = 'force_ask';
    result.riskLevel = 'high';
    result.explanation.risk = geminiPolicy.reason || '目标位于 .gemini 未白名单目录，转交人工核对确认';
    return finish();
  }

  if ((scope && !scope.insideWorkspace) || (!scope && hasSearchExclusions(parsed))) {
    result.verdict = 'force_ask';
    result.riskLevel = 'high';
    result.explanation.risk = '无法验证搜索目录、排除条件或下游管道，请人工核对';
    return finish();
  }

  if (geminiPolicy.tier === 'user_custom' && mutatingShell) {
    result.verdict = 'force_ask';
    result.riskLevel = 'medium';
    result.explanation.risk = '正在修改 .gemini 用户自定义规则/技能/插件文件，转交人工确认改动用意';
    return finish();
  }

  if ((!scope && (parsed.hasUnsafeSyntax || hasShellCommandSubstitution(sliced))) || !parsed.segmentTokens?.length) {
    result.verdict = 'force_ask';
    result.riskLevel = 'high';
    result.explanation.risk = '含命令替换、变量展开、输出重定向或动态脚本块，AI 代审转交人工核对上述分步用意';
    return finish();
  }

  if (scope?.insideWorkspace) {
    result.verdict = 'auto_approve';
    result.riskLevel = 'low';
    result.explanation.risk = '已核验工作区内的只读搜索范围、排除条件与输出筛选';
    return finish();
  }
  if (download && config.enableSafeDownloadAutoApprove &&
      isBoundedWorkspaceDownload(parsed, cwd, config.maxDownloadSizeMB, rawInput)) {
    result.verdict = 'auto_approve';
    result.riskLevel = 'low';
    result.explanation.risk = '单个 HTTPS 资源下载到工作区新文件，命令已显式限制响应大小';
    return finish();
  }

  if (download) {
    result.verdict = 'force_ask';
    result.explanation.risk = config.enableSafeDownloadAutoApprove
      ? '无法验证 HTTPS 下载的体积上限、重定向或工作区目标'
      : '工作区安全下载自动审批已关闭';
    return finish();
  }

  // 逐段校验多命令串联与管道（如 `Get-ChildItem ... | Select-String ... | Select-Object ...`）
  const segmentTiers: Array<Exclude<SegmentTier, { kind: 'force_ask' }>> = [];
  for (let idx = 0; idx < parsed.segmentTokens.length; idx++) {
    const isPipeSink = idx > 0 && parsed.operators?.[idx - 1] === '|';
    const tier = classifySegment(parsed.segmentTokens[idx], isPipeSink);
    if (tier.kind === 'force_ask') {
      result.verdict = 'force_ask';
      result.riskLevel = 'high';
      result.explanation.risk = tier.reason;
      return finish();
    }
    segmentTiers.push(tier);
  }

  // 生成可复用的会话级命令前缀（多段命令仅在同前缀或单段安全命令时授予）
  const firstPrefix = segmentTiers[0]?.prefix;
  if (firstPrefix && (segmentTiers.length === 1 || segmentTiers.every((t) => t.kind === 'read_only' || t.kind === 'low_risk_dev'))) {
    result.commandPrefix = firstPrefix;
  }

  const gitReads = parsed.segmentTokens.filter((tokens, i) => /^git(?:\.exe)?$/i.test(tokens[0]) &&
    ['read_only', 'low_risk_dev'].includes(segmentTiers[i].kind));
  if (gitReads.length) {
    const base = commandWorkspaceCwd(cwd, rawInput);
    if (!base || gitReads.some(tokens => !cleanDevelopmentCommand(tokens, base))) {
      result.verdict = 'force_ask';
      result.commandPrefix = undefined;
      result.explanation.risk = 'Git 参数或范围需复核';
      return finish();
    }
    if (config.fastPassLowRiskDev === false) {
      result.verdict = 'grey_zone';
      result.riskLevel = 'low';
      return finish();
    }
  }

  const allow = match(config.allowPatterns);
  if (allow) {
    result.verdict = 'auto_approve';
    result.riskLevel = 'low';
    result.matchedRule = allow;
    result.explanation.risk = '命中用户允许规则，且未出现已识别危险结构';
    return finish();
  }

  // 所有分段均为纯只读目录枚举/文本检索/内存筛选（覆盖单条及管道组合） -> 直接本地快筛自动放行
  if (segmentTiers.every((t) => t.kind === 'read_only')) {
    result.verdict = 'auto_approve';
    result.riskLevel = segmentTiers.length === 1 && /^(?:pwd|get-location|gl)\s*$/i.test(command) ? 'safe' : 'low';
    if (/^(?:pwd|Get-Location)\s*$/i.test(command)) {
      result.explanation.meaning = '查看当前工作目录';
    }
    result.explanation.risk =
      segmentTiers.length > 1
        ? '多段管道全部为纯只读检索与内存筛选操作，不修改任何文件'
        : '纯只读本地查看/检索操作，不修改任何文件';
    return finish();
  }

  if (segmentTiers.every(t => t.kind === 'read_only' || t.kind === 'low_risk_dev')) {
    const base = commandWorkspaceCwd(cwd, rawInput);
    const hasPipe = parsed.operators?.some(op => op === '|') ?? false;
    let clean = false;
    if (base && !parsed.hasUnsafeSyntax && !parsed.malformed && !hasPipe) {
      const pathMod = /^[A-Z]:[\\/]|^\\\\/i.test(base) ? win32 : posix;
      let stepCwd = base;
      clean = parsed.segmentTokens.every((segToks, idx) => {
        if (segmentTiers[idx].kind === 'read_only') return true;
        if (!cleanDevelopmentCommand(segToks, stepCwd)) return false;
        const exec = (segToks[0] || '').toLowerCase().replace(/\.exe$/, '');
        if (/^(?:cd|set-location|sl)$/.test(exec) && segToks[1]) {
          stepCwd = pathMod.resolve(stepCwd, segToks[1]);
        }
        return true;
      });
    }
    result.verdict = clean && config.mode !== 'manual' && config.fastPassLowRiskDev !== false ? 'auto_approve' : 'grey_zone';
    result.riskLevel = 'low';
    result.explanation.risk = result.verdict === 'auto_approve' ? '工作区内的常规开发校验命令，按本地规则放行' : '开发命令，需复核参数和用户意图';
    if (!clean) result.commandPrefix = undefined;
  }

  return finish();
}
export { parseShellCommand } from './shell-lexer';

export { readOnlySearchScope, downloadUsesCredentials, credentialInspectionText } from './shell-workspace-scope';

export {
  compileSafePattern, sensitiveTarget, type GeminiPathPolicyTier, type GeminiPathPolicyResult,
  inspectGeminiPathPolicy, readonlyWriteReason,
} from './path-and-gemini-policy';

export { isMutatingShellCommand, isShellToolName } from './shell-mutation-policy';

export { networkTargetFloor, isDestructiveOrPrivilegedToolName, isPureReadOnlyLookupTool } from './mcp-network-policy';

export { describeOperationIntent } from './intent-describer';

export { isCatastrophicSystemCommand, isReadOnlyScriptReviewCandidate, assessShellHighRiskFloor } from './shell-risk-floor';

export { isWorkspaceMaintenanceCommand } from './shell-validators';
