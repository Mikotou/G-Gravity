/**
 * Gravity v0.3.1 — 对话暂停、截断与各类错误停止的结构化诊断及恢复建议契约
 *
 * 合规约束：
 * - 429 / 403 冷却期间仅允许倒计时等待或提示用户前往账号设置**手动切换**，绝不触发自动轮号切号；
 * - technicalDetail 严禁包含任何 API Key、Token、Cookie 或未脱敏的私密路径。
 */

export type DiagnosticCode =
  | 'user_cancelled'
  | 'max_tokens'
  | 'refusal'
  | 'waiting_approval'
  | 'waiting_question'
  | 'rate_limited_429'
  | 'permission_denied_403'
  | 'auth_required_401'
  | 'context_overflow'
  | 'stream_interrupted'
  | 'auto_resume_failed'
  | 'acp_disconnected'
  | 'agy_binary_missing'
  | 'concurrency_limit_reached'
  | 'policy_blocked'
  | 'tool_failure_stopped'
  | 'resume_failed'
  | 'unknown_error';

export type DiagnosticSeverity = 'paused' | 'warning' | 'error';

export type DiagnosticActionId =
  | 'continue_turn'
  | 'retry_turn'
  | 'reconnect_session'
  | 'compact_context'
  | 'launch_official_login'
  | 'open_accounts_settings'
  | 'open_approval_settings'
  | 'new_session'
  | 'edit_last_message'
  | 'scroll_to_approval'
  | 'focus_question_bar'
  | 'dismiss';

export interface TurnStopState {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  stopReason?: string;
  titleZh: string;
  titleEn: string;
  messageZh: string;
  messageEn: string;
  suggestionsZh: string[];
  suggestionsEn: string[];
  technicalDetail?: string;
  /** ISO 时间戳：用于 429 / 403 冷却倒计时 */
  cooldownUntil?: string;
  actions: DiagnosticActionId[];
  occurredAt: string;
}

export interface SessionDiagnosticBanner extends TurnStopState {
  dismissible?: boolean;
}

export interface BuildDiagnosticOptions {
  stopReason?: string;
  technicalDetail?: string;
  cooldownUntil?: string;
  exitCode?: number | null;
  signal?: string | null;
  activeSessionCount?: number;
  maxParallelSessions?: number;
  blockedReasons?: string[];
  dismissible?: boolean;
  occurredAt?: string;
}

function sanitizeDetail(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/((?:bearer|basic)\s+)[\w.\-+/=]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-[\w-]+|AIza[\w-]+|ya29\.[\w.-]+|github_pat_[\w-]+|gh[pousr]_[\w-]+)\b/g, '[redacted]')
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[redacted]@')
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 280) : undefined;
}

/** 将常见错误对象或文本归纳为标准 `DiagnosticCode`，便于前后端一致呈现解决建议。 */
export function classifyErrorToDiagnosticCode(error: unknown): DiagnosticCode {
  const codeField =
    error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  if (
    codeField === 429 ||
    /(?:^|\b(?:http|status|code|error|err)\b[^\d]{0,12})429\b|\b429\s*(?:too many requests|resource_exhausted|rate[ _-]?limit)|\b(?:RESOURCE_EXHAUSTED|rate[ _-]?limit(?:ed)?|quota exceeded)\b/i.test(msg)
  ) {
    return 'rate_limited_429';
  }
  if (
    codeField === 403 ||
    /(?:^|\b(?:http|status|code|error|err)\b[^\d]{0,12})403\b|\b403\s*(?:forbidden|permission_denied)|\bPERMISSION_DENIED\b/i.test(msg)
  ) {
    return 'permission_denied_403';
  }
  if (
    codeField === 401 ||
    /(?:^|\b(?:http|status|code|error|err)\b[^\d]{0,12})401\b|\b401\s*(?:unauthorized|unauthenticated)|\b(?:UNAUTHENTICATED|unauthorized|login required|not logged in|auth(?:entication)? failed)\b/i.test(msg) ||
    /未登录|登录已过期|登录失效|请先登录/.test(msg)
  ) {
    return 'auth_required_401';
  }
  if (
    /\b(?:context[ _-]?length|max[ _-]?context|token limit|prompt(?: is)? too long|context window)\b/i.test(msg) ||
    /上下文(?:长度|窗口)?超[限出]|提示词过长/.test(msg)
  ) {
    return 'context_overflow';
  }
  if (
    /未找到官方\s*agy|无法启动官方\s*agy|AGY_BINARY_PATH|spawn\s+agy(?:\.exe)?\s+ENOENT/i.test(msg)
  ) {
    return 'agy_binary_missing';
  }
  if (
    /最多同时打开\s*4\s*个活动会话|已打开\s*4\s*个活动会话|MAX_PARALLEL_ACTIVE_SESSIONS/i.test(msg)
  ) {
    return 'concurrency_limit_reached';
  }
  if (
    /ACP\s*(?:尚未连接|连接已关闭|通道已关闭|进程已退出|标准(?:输入|输出)已关闭|已停止|正在关闭)|会话未激活|请先恢复此会话/i.test(msg) ||
    /\b(?:EPIPE|ECONNRESET|disconnect(?:ed)?)\b/i.test(msg)
  ) {
    return 'acp_disconnected';
  }
  if (
    /stream was interrupted|network issue connecting|connection interrupted|network error|流式连接.*中断/i.test(msg)
  ) {
    return 'stream_interrupted';
  }
  if (/安全策略拦截|受保护路径|禁止写入|\.gemini/i.test(msg)) {
    return 'policy_blocked';
  }
  return 'unknown_error';
}

/** 构造统一的中英双语诊断状态与可执行恢复建议。 */
export function buildDiagnosticBanner(
  code: DiagnosticCode,
  options: BuildDiagnosticOptions = {}
): SessionDiagnosticBanner {
  const occurredAt = options.occurredAt || new Date().toISOString();
  const detail = sanitizeDetail(options.technicalDetail);
  const dismissible = options.dismissible ?? true;

  switch (code) {
    case 'user_cancelled':
      return {
        code,
        severity: 'paused',
        stopReason: options.stopReason ?? 'cancelled',
        titleZh: '对话已暂停（由你手动停止）',
        titleEn: 'Conversation paused (stopped by you)',
        messageZh: '当前回合已按你的指令中断，已生成的内容与文件改动均已保留。',
        messageEn: 'This turn stopped at your request. Everything generated so far has been preserved.',
        suggestionsZh: [
          '点击「继续生成」可让智能体从中断位置接着完成剩余任务；',
          '也可直接在输入框补充新要求或调整思路后再发送。',
        ],
        suggestionsEn: [
          'Click "Continue" to resume the task from where it stopped.',
          'Or enter follow-up instructions in the composer to steer the next step.',
        ],
        technicalDetail: detail,
        actions: ['continue_turn', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'max_tokens':
      return {
        code,
        severity: 'paused',
        stopReason: options.stopReason ?? 'max_tokens',
        titleZh: '回复因达到单轮长度上限而暂停',
        titleEn: 'Response paused at output length limit',
        messageZh: '模型单次输出达到上限并自动截断，已保留目前全部已生成内容。',
        messageEn: 'The model reached its single-turn output limit. All partial output has been kept.',
        suggestionsZh: [
          '点击「继续生成」接着输出剩余部分；',
          '若上下文占用较高，建议先执行「压缩上下文 (/compact)」后再继续。',
        ],
        suggestionsEn: [
          'Click "Continue" to finish generating the remaining content.',
          'If context usage is high, run "/compact" before continuing.',
        ],
        technicalDetail: detail,
        actions: ['continue_turn', 'compact_context', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'refusal':
      return {
        code,
        severity: 'warning',
        stopReason: options.stopReason ?? 'refusal',
        titleZh: '模型拒绝完成当前请求',
        titleEn: 'The model declined this request',
        messageZh: '官方模型根据安全或使用策略中止了本轮答复。',
        messageEn: 'The model stopped this turn due to safety or usage policy constraints.',
        suggestionsZh: [
          '尝试重新表述目标、补充合法的工程背景，或拆分为更明确的合规子任务；',
          '点击「编辑上一条消息」即可基于同一位置修改提示词重新发送。',
        ],
        suggestionsEn: [
          'Rephrase the prompt with clear engineering context or split it into smaller tasks.',
          'Click "Edit previous message" to revise and retry from the same point.',
        ],
        technicalDetail: detail,
        actions: ['edit_last_message', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'waiting_approval':
      return {
        code,
        severity: 'paused',
        titleZh: '对话已暂停，等待你的权限审批',
        titleEn: 'Paused — waiting for your approval',
        messageZh: '智能体请求执行受控操作，在你作出决定前不会继续运行。',
        messageEn: 'The agent requested permission for an action and is paused until you decide.',
        suggestionsZh: [
          '前往待审批卡片，直接按数字键 1–4 或点击按钮放行/拒绝。',
        ],
        suggestionsEn: [
          'Jump to the approval card and press keys 1–4 or click an option to proceed.',
        ],
        technicalDetail: detail,
        actions: ['scroll_to_approval'],
        occurredAt,
        dismissible: false,
      };

    case 'waiting_question':
      return {
        code,
        severity: 'paused',
        titleZh: '对话已暂停，等待你回答澄清问题',
        titleEn: 'Paused — waiting for your answer',
        messageZh: '智能体需要你确认关键细节后才能继续下一步操作。',
        messageEn: 'The agent needs your input before continuing the task.',
        suggestionsZh: [
          '请在底部问题栏中选择推荐项或输入自定义说明后提交。',
        ],
        suggestionsEn: [
          'Select an option or type a reply in the question bar below to continue.',
        ],
        technicalDetail: detail,
        actions: ['focus_question_bar'],
        occurredAt,
        dismissible: false,
      };

    case 'rate_limited_429':
      return {
        code,
        severity: 'warning',
        titleZh: '触发官方频率或配额限制（429），已自动冷却保护',
        titleEn: 'Official rate or quota limit reached (429) — cooling down',
        messageZh: '为遵守官方使用规定并保护账号安全，客户端已暂停连续请求，不会自动重试或自动切号。',
        messageEn: 'To comply with official usage limits and protect your account, requests are paused without auto-retry or auto account rotation.',
        suggestionsZh: [
          '请等待冷却倒计时结束后再点击「重试」或继续对话；',
          '可在右下角查看当前账号额度，或在「账号设置」中由你手动切换已登录的隔离 Profile。',
        ],
        suggestionsEn: [
          'Wait for the cooldown countdown to finish before retrying.',
          'Check remaining quota in the bottom-right footer, or manually switch profiles in Account Settings.',
        ],
        technicalDetail: detail,
        cooldownUntil: options.cooldownUntil,
        actions: ['retry_turn', 'open_accounts_settings', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'permission_denied_403':
      return {
        code,
        severity: 'error',
        titleZh: '当前账号无权访问所选模型或接口（403）',
        titleEn: 'Access denied for this account or model (403)',
        messageZh: '官方服务拒绝了本次访问，客户端已自动进入冷却保护以防重复触发风控。',
        messageEn: 'The official service denied access and triggered cooldown protection to avoid repeated errors.',
        suggestionsZh: [
          '核对当前所选模型是否在你的账号订阅权限内，必要时在输入框右下角切换其他可用模型；',
          '前往「账号设置」检查当前 Profile 的官方登录状态与权限。',
        ],
        suggestionsEn: [
          'Verify that the selected model is included in your account tier, or switch to another available model.',
          'Open Account Settings to verify your active profile and official sign-in status.',
        ],
        technicalDetail: detail,
        cooldownUntil: options.cooldownUntil,
        actions: ['open_accounts_settings', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'auth_required_401':
      return {
        code,
        severity: 'error',
        titleZh: '官方账号登录态已失效或尚未登录（401）',
        titleEn: 'Official sign-in expired or required (401)',
        messageZh: '官方 agy CLI 返回未认证错误，需要你通过官方终端重新完成登录。',
        messageEn: 'Official agy CLI reported an authentication error. Please sign in again via the official terminal.',
        suggestionsZh: [
          '点击「启动官方登录」拉起原版 agy 登录窗口完成认证；',
          '登录成功后返回本窗口点击「重新连接」即可继续对话。',
        ],
        suggestionsEn: [
          'Click "Launch official login" to authenticate in the official agy terminal.',
          'After signing in, return here and click "Reconnect" to continue.',
        ],
        technicalDetail: detail,
        actions: ['launch_official_login', 'open_accounts_settings', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'context_overflow':
      return {
        code,
        severity: 'warning',
        titleZh: '当前会话上下文已接近或超出模型窗口上限',
        titleEn: 'Conversation context exceeded model window limit',
        messageZh: '本轮消息连同历史上下文和附件体积过大，官方服务无法继续处理。',
        messageEn: 'The prompt combined with conversation history and attachments exceeded the context window.',
        suggestionsZh: [
          '优先点击「压缩上下文 (/compact)」总结历史记录以释放大量空间；',
          '若当前会话不支持压缩，建议「新建会话」并仅携带必要文件继续。',
        ],
        suggestionsEn: [
          'Click "Compact context (/compact)" to summarize earlier turns and free window space.',
          'If compaction is unavailable, start a new session with only the required files.',
        ],
        technicalDetail: detail,
        actions: ['compact_context', 'new_session', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'stream_interrupted':
      return {
        code,
        severity: 'warning',
        titleZh: '流式连接意外中断，本轮输出未能完整收尾',
        titleEn: 'Stream connection interrupted before completion',
        messageZh: '与官方服务的网络流发生波动导致输出提前停止，已生成的内容完整保留。',
        messageEn: 'A network interruption stopped the stream early. All output received so far is preserved.',
        suggestionsZh: [
          '请检查本机网络连接或代理节点是否稳定；',
          '点击「继续任务」即可基于当前进度接着完成剩余回答。',
        ],
        suggestionsEn: [
          'Check your network or proxy stability.',
          'Click "Continue" to resume the task from the current state.',
        ],
        technicalDetail: detail,
        actions: ['continue_turn', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'auto_resume_failed':
      return {
        code,
        severity: 'warning',
        stopReason: options.stopReason,
        titleZh: '已自动续接一次，但仍未能完成本轮回复',
        titleEn: 'Automatic continuation could not finish this turn',
        messageZh: '为避免无休止重试，客户端已停止自动续接；请查看详情并决定是否手动继续。',
        messageEn: 'Automatic retries are capped at once to stay compliant. Review the detail below and continue manually when ready.',
        suggestionsZh: [
          '确认网络稳定且账号额度正常后，点击「继续任务」手动恢复；',
          '若多次中断，可尝试压缩上下文或切换到更稳定的模型。',
        ],
        suggestionsEn: [
          'Verify network stability and account quota, then click "Continue" manually.',
          'If interruptions repeat, compact the context or switch models.',
        ],
        technicalDetail: detail,
        actions: ['continue_turn', 'compact_context', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'acp_disconnected': {
      const exitInfo =
        options.exitCode !== undefined && options.exitCode !== null
          ? `exit=${options.exitCode}`
          : options.signal
            ? `signal=${options.signal}`
            : undefined;
      const mergedDetail = [exitInfo, detail].filter(Boolean).join(' · ') || undefined;
      return {
        code,
        severity: 'error',
        titleZh: '与本地官方 agy 进程的连接已断开',
        titleEn: 'Disconnected from local official agy process',
        messageZh: '后台 ACP 通信进程意外退出或管道中断，当前会话已暂停并保留全部历史消息。',
        messageEn: 'The local ACP backend process exited or closed its pipe. Your session history is safely preserved.',
        suggestionsZh: [
          '点击「重新连接」重新拉起官方 agy 并恢复当前对话；',
          '若反复退出，请打开「账号与连接设置」核查 agy 路径、版本与登录态。',
        ],
        suggestionsEn: [
          'Click "Reconnect" to restart official agy and resume this conversation.',
          'If disconnects persist, inspect the agy binary path, version, and sign-in status in Account Settings.',
        ],
        technicalDetail: mergedDetail,
        actions: ['reconnect_session', 'open_accounts_settings', 'dismiss'],
        occurredAt,
        dismissible,
      };
    }

    case 'agy_binary_missing':
      return {
        code,
        severity: 'error',
        titleZh: '未在本机检测到官方 agy CLI',
        titleEn: 'Official agy CLI binary not found',
        messageZh: '无法定位或启动原版官方 agy 可执行文件，因此无法建立对话连接。',
        messageEn: 'Gravity could not locate or launch the official agy executable.',
        suggestionsZh: [
          '确认已安装官方 Antigravity CLI（agy）并将其所在目录加入系统 PATH；',
          '也可设置环境变量 AGY_BINARY_PATH 指向 agy 绝对路径后重启客户端。',
        ],
        suggestionsEn: [
          'Install the official Antigravity CLI (agy) and ensure its directory is on your system PATH.',
          'Alternatively, set AGY_BINARY_PATH to the absolute path of agy and restart Gravity.',
        ],
        technicalDetail: detail,
        actions: ['open_accounts_settings', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'concurrency_limit_reached': {
      const limit = options.maxParallelSessions ?? 4;
      return {
        code,
        severity: 'warning',
        titleZh: `已达到并行活跃会话合规上限（最多 ${limit} 个）`,
        titleEn: `Active session concurrency limit reached (max ${limit})`,
        messageZh: `为保障官方服务稳定与账号安全，同时最多保持 ${limit} 个活跃会话连接。`,
        messageEn: `Up to ${limit} parallel active sessions are allowed to stay within safe usage limits.`,
        suggestionsZh: [
          '请先点击顶部标签栏关闭至少一个暂不使用的会话标签页；',
          '关闭标签只会断开内存连接，不会删除历史记录，之后随时可重新打开。',
        ],
        suggestionsEn: [
          'Close at least one idle tab in the top bar before opening or resuming another session.',
          'Closing a tab preserves all saved conversation history.',
        ],
        technicalDetail: detail,
        actions: ['dismiss'],
        occurredAt,
        dismissible,
      };
    }

    case 'policy_blocked': {
      const reasons = (options.blockedReasons || []).filter(Boolean).slice(0, 3);
      return {
        code,
        severity: 'warning',
        titleZh: '操作因触及本地安全与合规策略被拦截',
        titleEn: 'Action blocked by local safety & compliance policy',
        messageZh: reasons.length
          ? `为保护账号与本机安全，本地策略拦截了高风险或受保护路径操作（${reasons.join('；')}）。`
          : '为保护账号与本机安全，客户端拦截了触及安全底线或受保护目录的操作。',
        messageEn: reasons.length
          ? `Local safety rules blocked a restricted action (${reasons.join('; ')}).`
          : 'Local safety rules blocked an action touching restricted credentials or official directories.',
        suggestionsZh: [
          '如需写入临时文件，请引导智能体写入当前项目工作区内的目录（切勿写入官方配置目录）；',
          '点击「继续任务」可让模型跳过受限项并改用安全方案完成，或在「Approve for me 设置」查看审计详情。',
        ],
        suggestionsEn: [
          'For temporary files, instruct the agent to write inside the current workspace instead of the official config directory.',
          'Click "Continue" to proceed safely, or inspect the audit trail in Approve for me Settings.',
        ],
        technicalDetail: detail,
        actions: ['continue_turn', 'open_approval_settings', 'dismiss'],
        occurredAt,
        dismissible,
      };
    }

    case 'tool_failure_stopped':
      return {
        code,
        severity: 'warning',
        titleZh: '工具执行失败导致当前回合提前中止',
        titleEn: 'Turn stopped early after tool execution failure',
        messageZh: '上一轮中部分命令或工具调用返回失败，智能体未能产出最终总结。',
        messageEn: 'One or more tool calls failed and the turn ended without a final reply.',
        suggestionsZh: [
          '可展开上方「操作记录」查看具体失败输出；',
          '点击「继续任务」让智能体基于失败原因自动调整方案继续执行。',
        ],
        suggestionsEn: [
          'Expand "Activity" above to inspect the failing tool output.',
          'Click "Continue" so the agent can adapt and finish the task.',
        ],
        technicalDetail: detail,
        actions: ['continue_turn', 'dismiss'],
        occurredAt,
        dismissible,
      };

    case 'resume_failed':
      return {
        code,
        severity: 'error',
        titleZh: '恢复此历史会话失败，当前已切换为只读查看',
        titleEn: 'Failed to resume session — opened in read-only mode',
        messageZh: '已为你保留全部本地历史消息；在连接或会话状态恢复前暂时无法发送新消息。',
        messageEn: 'Your local conversation history is intact, but live prompting is paused until the session reconnects.',
        suggestionsZh: [
          '确认未超过 4 路并行会话上限且官方 agy 连接正常后，点击「重新连接」；',
          '若服务端会话已过期，可点击「新建会话」继续后续工作。',
        ],
        suggestionsEn: [
          'Verify you are below the 4-session limit and agy is connected, then click "Reconnect".',
          'If the remote session expired, start a new session to continue.',
        ],
        technicalDetail: detail,
        actions: ['reconnect_session', 'new_session', 'open_accounts_settings', 'dismiss'],
        occurredAt,
        dismissible,
      };

    default:
      return {
        code: 'unknown_error',
        severity: 'error',
        stopReason: options.stopReason,
        titleZh: '本轮对话因异常错误停止',
        titleEn: 'Conversation stopped due to an unexpected error',
        messageZh: '执行期间发生未预期错误，你的草稿与历史消息均已安全保留。',
        messageEn: 'An unexpected error interrupted this turn. Your draft and history remain preserved.',
        suggestionsZh: [
          '点击「重试」再次发送，或点击「重新连接」刷新与官方 agy 的会话连接；',
          '如问题持续，请展开下方技术详情排查。',
        ],
        suggestionsEn: [
          'Click "Retry" to send again, or "Reconnect" to refresh the official agy session.',
          'Expand technical details below if the issue persists.',
        ],
        technicalDetail: detail,
        actions: ['retry_turn', 'reconnect_session', 'dismiss'],
        occurredAt,
        dismissible,
      };
  }
}
