/**
 * Gravity v0.2 — 官方 `agy acp` (Agent Client Protocol) JSON-RPC 2.0 over stdio 协议类型契约
 *
 * 合规铁律：
 * 1. 仅允许调用本机未修改的原版官方 `agy` / `agy.exe` 的 `acp` 及受支持的 `plugin` / `mcp` / `models` 子命令；
 * 2. 登录认证 100% 委托给 `agy acp [--app-data-dir <dir>] --login` 官方交互终端，登出优先走 ACP `auth/logout`；
 * 3. 严禁传递任何伪造指纹、劫持内部端点或暗中跳过权限的参数。
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: TParams;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: TResult;
  error?: JsonRpcErrorObject;
}

/** 接收端用 method 区分调用与响应，再用 id 区分请求与单向通知。请求双方都能发送，响应沿原 id 配对。 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

/**
 * 官方受支持的合法 `agy acp` 启动参数白名单（已通过本机 `agy acp --help` 实证）
 */
export const ALLOWED_AGY_ACP_FLAGS = [
  'acp',
  '--stdio',
  '--process-per-session',
  '--sandbox',
  '--add-dir',
  '--agent',
  '--app-data-dir',
  '--login',
  '--disable-telemetry',
  '--include-default-customizations',
] as const;

/**
 * 官方受支持的短时管理子命令白名单（仅供用户在界面显式点击时以 `shell: false` 调用）
 */
export const ALLOWED_AGY_CLI_SUBCOMMANDS = [
  'plugin',
  'plugins',
  'mcp',
  'models',
] as const;

/**
 * Google ToS 合规红线：严禁传递的参数黑名单（@compliance 重点核查项）
 */
export const FORBIDDEN_AGY_FLAGS = [
  '--dangerously-skip-permissions',
  '--override_user_agent_name',
  '--cloud_code_endpoint',
  '--use_stubby_auth',
  '--is_google3_workspace',
  '--is_google_internal',
] as const;

/**
 * Claude Code / 官方 ACP 会话执行模式（左下角 Shift+Tab 循环切换）
 * 注：官方 `agy acp` 仅声明 default / accept-edits / plan 三档；保留 'auto' 类型仅作旧配置兼容。
 */
export type AgentExecutionMode = 'default' | 'accept-edits' | 'plan' | 'auto';

export const EXECUTION_MODE_ORDER: readonly AgentExecutionMode[] = [
  'default',
  'accept-edits',
  'plan',
] as const;

/**
 * 推理强度档位（右下角 Effort 选择器，对齐 `agy --help`）
 */
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORT_ORDER: readonly AgentReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export interface AcpClientCapabilities {
  elicitation?: { form: Record<string, never> };
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: boolean;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: AcpClientCapabilities;
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    load_session?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    sessionCapabilities?: {
      resume?: Record<string, unknown>;
      close?: Record<string, unknown>;
      load?: Record<string, unknown>;
      list?: Record<string, unknown>;
      additionalDirectories?: Record<string, unknown>;
    };
    auth?: {
      logout?: Record<string, unknown>;
    };
    _meta?: {
      antigravity?: {
        tier?: boolean;
        systemPrompt?: {
          append?: boolean;
        };
      };
    };
  };
  agentInfo: {
    name: string;
    version: string;
  };
  authMethods?: AcpAuthMethod[];
}

export interface AcpMcpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers?: AcpMcpServerSpec[];
  additionalDirectories?: string[];
  _meta?: {
    antigravity?: {
      systemPrompt?: {
        append?: string;
      };
    };
  };
}

export interface AcpModelOption {
  modelId: string;
  name: string;
  description?: string;
}

export interface AcpConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: AcpConfigOptionChoice[];
}

/** 新建或恢复会话所得的配置。不同代理版本可分别声明 models、modes 或统一的 configOptions，消费方按实际字段判断能力。 */
export interface AcpSessionNewResult {
  sessionId: string;
  models?: {
    currentModelId?: string;
    availableModels?: AcpModelOption[];
  };
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{
      id: string;
      name: string;
      description?: string;
    }>;
  };
  configOptions?: AcpConfigOption[];
}

export interface AcpSessionResumeParams {
  sessionId: string;
  cwd: string;
  mcpServers?: AcpMcpServerSpec[];
}

export interface AcpSessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers?: AcpMcpServerSpec[];
}

export interface AcpSessionCloseParams {
  sessionId: string;
}

export interface AcpSessionSetModeParams {
  sessionId: string;
  modeId: string;
}

export interface AcpSessionSetModelParams {
  sessionId: string;
  modelId: string;
}

export interface AcpListedSession {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface AcpSessionListResult {
  sessions: AcpListedSession[];
  nextCursor?: string;
}

export type AcpPromptContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      mimeType: string;
      data: string;
    }
  | {
      type: 'resource';
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
    };

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpPromptContentBlock[];
}

/** 代理可以只上报部分计数。缺失字段保留为可选，统计层可用本轮估算值补足。 */
export interface AcpTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface AcpSessionPromptResult {
  stopReason: 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | string;
  usage?: AcpTokenUsage;
}

export interface AcpSessionCancelParams {
  sessionId: string;
}

export type AcpSessionUpdateKind =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'user_message_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'usage_update';

export interface AcpToolCallContentItem {
  type: 'content' | 'diff' | 'terminal';
  content?: {
    type: 'text';
    text: string;
  };
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
}

/**
 * 同一个会话会收到多次增量更新。
 * 先看 sessionUpdate 决定应读取哪些字段，工具更新再按 toolCallId 合并。
 */
export interface AcpSessionUpdatePayload {
  sessionUpdate: AcpSessionUpdateKind;
  name?: string;
  content?: {
    type: 'text' | string;
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
  };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
  rawInput?: Record<string, unknown> | string;
  rawOutput?: Record<string, unknown> | string;
  toolContent?: AcpToolCallContentItem[];
  locations?: Array<{ path: string; line?: number }>;
  entries?: Array<{
    content: string;
    priority?: 'high' | 'medium' | 'low';
    status?: 'pending' | 'in_progress' | 'completed';
  }>;
  currentModeId?: string;
  configOptions?: AcpConfigOption[];
  usage?: AcpTokenUsage;
  used?: number;
  size?: number;
}

export interface AcpSessionUpdateNotification {
  sessionId: string;
  update: AcpSessionUpdatePayload;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface AcpPermissionToolCallDetail {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown> | string;
  locations?: Array<{ path: string; line?: number }>;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpPermissionToolCallDetail;
  options: AcpPermissionOption[];
}

/** 同意或拒绝都通过代理提供的 optionId 返回。会话结束或无法选择有效选项时使用 cancelled。 */
export type AcpRequestPermissionOutcome =
  | {
      outcome: 'selected';
      optionId: string;
    }
  | {
      outcome: 'cancelled';
    };

export interface AcpRequestPermissionResult {
  outcome: AcpRequestPermissionOutcome;
}
