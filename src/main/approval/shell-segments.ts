import { isSafePublicHttpsHeadProbe } from './shell-validators';
import { HIGH_RISK_EXECUTABLES, READ_ONLY_FS_OR_TEXT_CMDLETS, READ_ONLY_MEMORY_FILTERS } from './shell-risk-floor';
import { mutatingFilterReason } from './shell-mutation-policy';


export type SegmentTier =
  | { kind: 'read_only'; prefix?: string }
  | { kind: 'low_risk_dev'; prefix?: string }
  | { kind: 'moderate_grey'; prefix?: string }
  | { kind: 'force_ask'; reason: string };

/** 对一个已分词的片段判定风险。输入是否来自管道会影响允许的类型，结论与可记忆前缀一并返回。 */
export function classifySegment(segTokens: string[], isPipeSink: boolean): SegmentTier {
  if (segTokens.length === 0) {
    return { kind: 'force_ask', reason: '存在空命令片段，转交人工确认' };
  }
  const rawExec = segTokens[0];
  const exec = rawExec.toLowerCase().replace(/\.exe$/i, '');
  const args = segTokens.slice(1);

  // 任何目录穿越 `..` 或注册表驱动器（HKLM:/HKCU:）强制人工确认
  if (
    segTokens.some((tok) => /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(tok)) ||
    segTokens.some((tok) => /^hk(?:lm|cu|cr|u|cc):/i.test(tok))
  ) {
    return { kind: 'force_ask', reason: '含跨级相对路径 `..` 或系统注册表路径，转交人工确认作用目标范围' };
  }

  // 允许纯版本号只读查询（如 node -v / python --version / git --version）
  if (
    /^(?:node|npm|pnpm|yarn|bun|npx|python|python3|py|git|tsc|cargo|go|dotnet|rustc|java|uv)$/.test(exec) &&
    args.length === 1 &&
    /^(?:--version|-v|-V)$/.test(args[0])
  ) {
    return { kind: 'read_only', prefix: `${exec} ${args[0]}` };
  }

  // 允许纯只读公共 HTTPS HEAD 连通性探测（如 `curl -sI https://example.com`，禁止下载/上传/内网/凭据/管道下游）
  if (!isPipeSink && exec === 'curl' && isSafePublicHttpsHeadProbe(segTokens)) {
    return { kind: 'read_only', prefix: 'curl -I' };
  }

  // 允许 python -m pytest / unittest 与 node --check 语法校验作为常规低风险开发命令
  if (
    !isPipeSink &&
    /^(?:python|python3|py)$/.test(exec) &&
    args[0] === '-m' &&
    /^(?:pytest|unittest)$/.test((args[1] || '').toLowerCase())
  ) {
    return { kind: 'low_risk_dev', prefix: `${exec} -m ${args[1].toLowerCase()}` };
  }
  if (!isPipeSink && exec === 'node' && args[0] === '--check' && args.length === 2) {
    return { kind: 'low_risk_dev', prefix: 'node --check' };
  }
  if (!isPipeSink && exec === 'uv' && args[0] === 'run' && /^(?:pytest|ruff|mypy)$/.test((args[1] || '').toLowerCase())) {
    return { kind: 'low_risk_dev', prefix: `uv run ${args[1].toLowerCase()}` };
  }
  // 允许工作区内安全的目录切换与空目录创建（在 cleanDevelopmentCommand 中严格校验路径位于工作区内且非敏感目录）
  if (!isPipeSink && /^(?:cd|set-location|sl)$/.test(exec) && args.length === 1) {
    return { kind: 'low_risk_dev', prefix: exec };
  }
  if (!isPipeSink && /^(?:mkdir|md)$/.test(exec) && args.length >= 1) {
    return { kind: 'low_risk_dev', prefix: exec };
  }
  if (
    !isPipeSink &&
    /^(?:new-item|ni)$/.test(exec) &&
    args.some((a, i) => /^-itemtype$|^-type$/i.test(a) && /^directory$/i.test(args[i + 1] || ''))
  ) {
    return { kind: 'low_risk_dev', prefix: 'mkdir' };
  }

  // 管道下游绝不允许接入解释器、Shell 或危险命令
  if (HIGH_RISK_EXECUTABLES.has(exec)) {
    return {
      kind: 'force_ask',
      reason: isPipeSink
        ? '管道下游接入了脚本解释器、Shell 或修改类命令，转交人工确认安全边界'
        : '涉及文件删除/写入、脚本解释器执行、进程控制或网络访问，转交人工确认代码用意',
    };
  }

  // 1. 纯只读本地枚举 / 文本搜索 / 内存对象过滤命令
  const filterRisk = mutatingFilterReason(segTokens);
  if (filterRisk) return { kind: 'force_ask', reason: filterRisk };
  if (READ_ONLY_FS_OR_TEXT_CMDLETS.has(exec)) {
    return { kind: 'read_only', prefix: exec };
  }

  if (READ_ONLY_MEMORY_FILTERS.has(exec)) {
    return { kind: 'read_only', prefix: exec };
  }

  if (exec === 'find') {
    return { kind: 'read_only', prefix: 'find' };
  }

  // 2. Git 子命令精细分级
  if (exec === 'git') {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) return { kind: 'low_risk_dev', prefix: 'git' };

    if (
      /^(?:push|reset|clean|rebase|merge|cherry-pick|revert|am|apply|bisect|filter-branch|gc|prune|worktree|submodule)$/.test(sub) ||
      args.some((a) => /^(?:--force|-f|--hard|--delete|-D)$/.test(a))
    ) {
      return { kind: 'force_ask', reason: '涉及 Git 远端推送、历史重写或强制清理，转交人工确认' };
    }

    if (sub === 'status') {
      return { kind: 'low_risk_dev', prefix: 'git status' };
    }

    if (/^(?:diff|log|show|rev-parse|ls-files|blame|shortlog|describe)$/.test(sub)) {
      if (args.some((a) => /^--(?:output|ext-diff|no-index|textconv)(?:=|$)/i.test(a))) {
        return { kind: 'force_ask', reason: 'Git 参数可能调用外部程序或扩大文件范围，转交人工确认' };
      }
      return { kind: 'read_only', prefix: `git ${sub}` };
    }

    if (sub === 'branch') {
      const readOnlyBranchFlags = args.slice(1).every((a) => /^(?:-a|--all|-r|--remotes|-v|-vv|--list|--show-current|--contains)$/.test(a));
      if (readOnlyBranchFlags) return { kind: 'read_only', prefix: 'git branch' };
      return { kind: 'moderate_grey', prefix: 'git branch' };
    }

    if (sub === 'remote' && args.length === 2 && args[1] === '-v') {
      return { kind: 'read_only', prefix: 'git remote' };
    }

    if (/^(?:add|commit|stash|checkout|switch|tag|fetch|pull)$/.test(sub)) {
      return { kind: 'moderate_grey', prefix: `git ${sub}` };
    }

    return { kind: 'moderate_grey', prefix: /^[a-z][a-z-]*$/.test(sub) ? `git ${sub}` : undefined };
  }

  // 3. 前端 / 多语言包管理器与自动化测试、类型检查（无安装/发布副作用）
  if (/^(?:npm|pnpm|yarn|bun)$/.test(exec)) {
    const sub = (args[0] || '').toLowerCase();
    if (/^(?:install|i|ci|add|remove|rm|uninstall|un|update|up|publish|link|unlink|exec|dlx|init|create)$/.test(sub)) {
      return { kind: 'force_ask', reason: '涉及依赖包安装、移除、发布或动态拉取执行，转交人工确认' };
    }
    if (sub === 'test' || sub === 't') {
      return { kind: 'low_risk_dev', prefix: `${exec} test` };
    }
    if (sub === 'run' && args[1]) {
      const script = args[1].toLowerCase();
      if (/^(?:test|unit|typecheck|tsc|check|lint|build|compile|format:check)(?::[a-z0-9_-]+)?$/.test(script)) {
        return { kind: 'low_risk_dev', prefix: `${exec} run ${script}` };
      }
      if (/^[a-z0-9:_-]+$/i.test(script)) {
        return { kind: 'moderate_grey', prefix: `${exec} run ${script}` };
      }
    }
    if (/^(?:typecheck|lint|build|check)$/.test(sub)) {
      return { kind: 'low_risk_dev', prefix: `${exec} ${sub}` };
    }
    return { kind: 'moderate_grey', prefix: /^[a-z][a-z-]*$/.test(sub) ? `${exec} ${sub}` : undefined };
  }

  if (exec === 'npx') {
    const tool = (args[0] || '').toLowerCase();
    if (args.some((a) => /^(?:-y|--yes|-p|--package)$/.test(a))) {
      return { kind: 'force_ask', reason: '`npx` 带有自动拉取远程包参数，转交人工确认' };
    }
    if (/^(?:vitest|tsc|eslint|biome)$/.test(tool)) {
      return { kind: 'low_risk_dev', prefix: `npx ${tool}` };
    }
    if (tool === 'prettier' && !args.some((a) => /^(?:-w|--write)$/.test(a))) {
      return { kind: 'low_risk_dev', prefix: 'npx prettier' };
    }
    return { kind: 'force_ask', reason: '`npx` 执行未知外部命令包，转交人工确认' };
  }

  if (exec === 'tsc') {
    return { kind: 'low_risk_dev', prefix: 'tsc' };
  }

  if (exec === 'pytest') {
    return { kind: 'low_risk_dev', prefix: 'pytest' };
  }

  if (/^(?:cargo|dotnet|go)$/.test(exec)) {
    const sub = (args[0] || '').toLowerCase();
    if (/^(?:install|publish|clean)$/.test(sub)) {
      return { kind: 'force_ask', reason: '涉及全局包安装、清理或发布，转交人工确认' };
    }
    if (/^(?:test|check|clippy|vet|build)$/.test(sub)) {
      return { kind: 'low_risk_dev', prefix: `${exec} ${sub}` };
    }
    return { kind: 'moderate_grey', prefix: /^[a-z][a-z-]*$/.test(sub) ? `${exec} ${sub}` : undefined };
  }

  // 4. 其余未包含高危语法但不在白名单中的普通命令：若带有具体路径参数则保守要求人工确认
  if (segTokens.some((tok) => /[\\/]/.test(tok))) {
    return { kind: 'force_ask', reason: '未知命令包含具体文件路径参数，转交人工确认作用目标范围' };
  }

  return {
    kind: 'moderate_grey',
    prefix: /^[a-z][a-z0-9_-]*$/i.test(exec) ? exec : undefined,
  };
}
