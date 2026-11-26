import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, isAbsolute } from 'node:path';
import { APP_BRAND } from '../../shared/theme-i18n-contract';
import { ALLOWED_AGY_ACP_FLAGS, FORBIDDEN_AGY_FLAGS } from '../../shared/acp-protocol';
import type { AcpInitializeResult, JsonRpcId, JsonRpcMessage, JsonRpcRequest } from '../../shared/acp-protocol';
import { buildAgyEnvironment, commonUnixToolDirectories } from './agy-environment';
import { diagnosticDetail, errorDiagnosticCode, officialLoginRequiredMessage } from '../services/session-diagnostics';
import type { AcpConnectionStatus } from '../../shared/ipc-channels';
import { WindowsAcpTree } from './windows-acp-tree';
import { MacAcpProcessGroup } from './mac-acp-process-group';

import type { AcpChildProcess, AcpClientOptions } from './acp-types';
import { isAnyAbsolutePath } from '../workspace/local-path-safety';
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
export class AcpRequestNotSentError extends Error {}

/** 校验传给子进程的参数序列并返回副本。目录参数要求绝对路径，带值选项同时接受等号和独立参数两种写法。 */
export function validateAgyArgs(args: readonly string[]): string[] {
  if (args[0] !== 'acp') throw new Error('只允许启动官方 acp 子命令');
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const flag = arg.split('=')[0];
    if (FORBIDDEN_AGY_FLAGS.some(item => item === flag)) throw new Error('禁止使用绕过权限或内部端点参数');
    if (!(ALLOWED_AGY_ACP_FLAGS as readonly string[]).includes(flag) || flag === 'acp') throw new Error(`不支持的 ACP 参数：${flag}`);
    if (flag === '--add-dir' || flag === '--agent' || flag === '--app-data-dir') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (!value || value.startsWith('-') || /[\r\n\0]/.test(value)) throw new Error('ACP 参数缺少合法值');
      if ((flag === '--add-dir' || flag === '--app-data-dir') && !isAnyAbsolutePath(value)) throw new Error('工作区与 Profile 目录必须为绝对路径');
    } else if (arg.includes('=')) throw new Error('布尔 ACP 参数不接受附带值');
  }
  return [...args];
}
function canLaunchMacBinary(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
}

export function discoverAgyBinary(configured?: string): string {
  if (configured) {
    if (!isAnyAbsolutePath(configured) || !/^agy(?:\.exe)?$/i.test(configured.split(/[\\/]/).pop() || '')) throw new Error('请指定官方 agy 可执行文件的绝对路径');
    if (process.platform === 'darwin' && (!isAbsolute(configured) || !canLaunchMacBinary(configured))) {
      throw new Error('无法启动官方 agy，请检查 AGY_BINARY_PATH 和执行权限。');
    }
    return configured;
  }
  const names = process.platform === 'win32' ? ['agy.exe'] : ['agy'];
  const dirs = (buildAgyEnvironment('').PATH || '').split(delimiter).filter(Boolean);
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    // macOS / Linux 从图形桌面启动时常不继承交互式 Shell 的 PATH，补充常见官方/用户安装目录只读检索。
    for (const extra of commonUnixToolDirectories(homedir())) {
      if (!dirs.includes(extra)) dirs.push(extra);
    }
  }
  for (const dir of dirs) {
    if (process.platform === 'darwin' && !isAbsolute(dir)) continue;
    for (const name of names) {
      const path = join(dir.replace(/^"|"$/g, ''), name);
      try { if (process.platform === 'darwin' ? canLaunchMacBinary(path) : statSync(path).isFile()) return path; }
      catch { /* Continue searching PATH. */ }
    }
  }
  throw new Error('未找到官方 agy，请将其加入 PATH 或设置 AGY_BINARY_PATH');
}

/** 一个实例只拥有一个常驻 ACP 主进程。request 处理器可挂起而不阻塞其他会话。 */
export class AcpClient extends EventEmitter {
  private child?: AcpChildProcess;
  private windowsTree?: WindowsAcpTree;
  private retiring = false;
  private macGroup?: MacAcpProcessGroup;
  private nextId = 1;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  // A timed-out Promise no longer owns a waiter, but its wire ID still belongs to this transport.
  private readonly outstanding = new Map<JsonRpcId, ((response: { result?: unknown; error?: unknown }) => void) | undefined>();
  private handlers = new Map<string, (params: unknown, id: JsonRpcId) => unknown | Promise<unknown>>();
  private connecting?: Promise<AcpInitializeResult>;
  private stopping?: Promise<void>;
  private loggingIn = false;
  initializeResult?: AcpInitializeResult;
  binaryPath = '';
  lastError?: string;
  private cooldownUntil = 0;
  get cooldownUntilMs(): number { return this.cooldownUntil; }
  cooldownKind?: AcpConnectionStatus['cooldownKind'];
  lastErrorCode?: AcpConnectionStatus['lastErrorCode'];
  lastExitCode?: number | null;
  lastSignal?: string | null;
  private transportGeneration = 0;

  private connectionEvent() {
    return { connected: this.connected, exitCode: this.lastExitCode, signal: this.lastSignal, errorCode: this.lastErrorCode,
      lastError: this.lastError, cooldownUntilMs: this.cooldownUntilMs, cooldownKind: this.cooldownKind };
  }
  constructor(readonly options: AcpClientOptions = {}) { super(); }
  get nextStartArgs(): string[] {
    const args = this.options.args || ['acp'];
    if (this.options.processPerSession === undefined) return [...args];
    const next = args.filter(flag => flag !== '--process-per-session');
    if (this.options.processPerSession) next.push('--process-per-session');
    return next;
  }
  get connected(): boolean { return !!this.child && !!this.initializeResult && !this.retiring && !this.stopping; }
  get isRateLimited(): boolean { return Date.now() < this.cooldownUntilMs; }
  registerRequestHandler(method: string, handler: (params: unknown, id: JsonRpcId) => unknown | Promise<unknown>): void { this.handlers.set(method, handler); }
  /** 复用正在进行的握手。首次同时打开多个会话时，所有调用者等待同一次 initialize。 */
  async start(): Promise<AcpInitializeResult> {
    if (this.stopping) {
      const interruptedHandshake = this.connecting;
      await this.stopping;
      if (interruptedHandshake) await interruptedHandshake.catch(() => {});
    }
    if (this.retiring) throw new AcpRequestNotSentError('旧 ACP 进程树回收尚未确认');
    this.assertRequestAllowed();
    if (this.loggingIn) throw new Error('官方登录正在进行，请完成登录后再连接');
    if (this.initializeResult && this.child) return this.initializeResult;
    if (this.connecting) return this.connecting;
    const handshake = this.connect();
    this.connecting = handshake;
    try { return await handshake; } catch (error) {
      this.lastError = diagnosticDetail(error);
      this.lastErrorCode = errorDiagnosticCode(error);
      this.emit('connection-changed', this.connectionEvent());
      throw error;
    } finally { if (this.connecting === handshake) this.connecting = undefined; }
  }
  private async connect(): Promise<AcpInitializeResult> {
    this.emit('before-connect');
    const generation = ++this.transportGeneration;
    this.lastExitCode = undefined;
    this.lastSignal = undefined;
    const args = validateAgyArgs(this.nextStartArgs);
    this.options.args = args;
    if (args.includes('--login')) throw new Error('交互登录必须使用独立的显式登录入口');
    this.binaryPath = this.options.spawn ? (this.options.binaryPath || 'agy') : discoverAgyBinary(this.options.binaryPath);
    this.buffer = ''; this.decoder = new StringDecoder('utf8');
    const mac = process.platform === 'darwin';
    const earliest = Date.now() - 2000;
    const child = (this.options.spawn || spawn)(this.binaryPath, args, {
      cwd: this.options.cwd, env: buildAgyEnvironment(this.binaryPath), stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, shell: false, detached: mac,
    });
    this.child = child;
    if (process.platform === 'win32' && child.pid && child.pid > 1 && child.pid !== process.pid) {
      this.windowsTree = new WindowsAcpTree(child, child.pid, earliest, Date.now() + 2000);
    }
    const recordExit = (code?: number | null, signal?: NodeJS.Signals | null) => {
      if (this.transportGeneration !== generation) return;
      const nextCode = code ?? child.exitCode ?? this.lastExitCode ?? null;
      const nextSignal = signal ?? child.signalCode ?? this.lastSignal ?? null;
      const changed = nextCode !== this.lastExitCode || nextSignal !== this.lastSignal;
      this.lastExitCode = nextCode;
      this.lastSignal = nextSignal;
      // Pipes can close before the OS reports the final process status.
      if (changed && !this.child) this.emit('connection-changed', this.connectionEvent());
    };
    child.once('exit', recordExit);
    child.once('close', recordExit);
    if (mac && child.pid !== undefined && Number.isSafeInteger(child.pid) && child.pid > 1 && child.pid !== process.pid) {
      const group = new MacAcpProcessGroup(child, child.pid);
      this.macGroup = group;
      child.once('exit', () => {
        if (this.child === child) this.reapMacGroup(child, group, false, new Error('官方 ACP 进程已退出'))
          .catch(() => this.emit('diagnostic', '未能完整关闭 ACP 进程组'));
      });
    }
    // 标准输出可能从一个汉字的中间断开。解码器先拼齐 UTF-8 字节，receive 再按换行拆 JSON。
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (this.child === child) this.receive(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    });
    child.stdout?.once('end', () => { if (this.child === child) this.fail(new Error('ACP 标准输出已关闭')); });
    // stderr 仅发出诊断信号，不落盘、不发送给独立 API。
    child.stderr?.on('data', () => { if (this.child === child) this.emit('diagnostic', '官方 ACP 进程产生诊断输出'); });
    child.stdin?.on('error', () => { if (this.child === child) this.fail(new Error('ACP 标准输入已关闭')); });
    child.on('error', () => { if (this.child === child) this.fail(new Error('无法启动官方 agy，请检查路径与执行权限')); });
    const exited = () => { if (this.child === child) this.fail(new Error('官方 ACP 进程已退出')); };
    if (!this.macGroup) child.once('exit', exited);
    child.once('close', exited);
    try {
      if (this.windowsTree) await this.windowsTree.ready;
      const result = await this.request<AcpInitializeResult>('initialize', {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: 'gravity', version: APP_BRAND.version },
      });
      if (result?.protocolVersion !== 1 || !result.agentCapabilities) throw new Error('官方 ACP 返回了不兼容的协议版本');
      if (this.child !== child || this.retiring) throw new Error('握手期间 ACP 连接已关闭');
      this.initializeResult = result;
      if (!this.isRateLimited) { this.lastError = undefined; this.lastErrorCode = undefined; }
      this.emit('connected', result);
      this.emit('connection-changed', this.connectionEvent());
      return result;
    } catch (error) {
      if (this.child === child) await this.stop();
      else if (this.stopping) await this.stopping;
      throw error;
    }
  }
  assertRequestAllowed(method?: string): void {
    if (this.isRateLimited && method !== 'session/close' && method !== 'session/cancel') {
      throw new AcpRequestNotSentError(`官方服务 HTTP ${this.cooldownKind === 'permission_403' ? 403 : 429}，已暂停连续请求；请在 ${Math.ceil((this.cooldownUntilMs - Date.now()) / 1000)} 秒后核对账号权限或配额再试`);
    }
  }
  /** 每个请求按 id 配对响应。正超时值会启动定时器，传入 0 则由响应或断连结束等待。 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 30000,
    onLate?: (response: { result?: unknown; error?: unknown }) => void): Promise<T> {
    if (this.retiring || this.stopping) return Promise.reject(new AcpRequestNotSentError('ACP 正在关闭'));
    try { this.assertRequestAllowed(method); } catch (error) { return Promise.reject(error); }
    if (this.outstanding.size >= 1024) {
      void this.stop().catch(() => this.emit('diagnostic', 'ACP 回收失败'));
      return Promise.reject(new AcpRequestNotSentError('ACP 未结算请求已达上限，请关闭连接后重试'));
    }
    if (!this.child?.stdin) return Promise.reject(new AcpRequestNotSentError('ACP 尚未连接'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP 请求超时：${method}`)); }, timeoutMs) : undefined;
      timer?.unref();
      // 先登记回调再写入管道，即使对端立即回答也能找到等待者。
      this.outstanding.set(id, onLate);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this.outstanding.delete(id); if (timer) clearTimeout(timer); this.pending.delete(id); reject(new AcpRequestNotSentError(error instanceof Error ? error.message : String(error))); }
    });
  }
  notify(method: string, params?: unknown): void { this.assertRequestAllowed(method); this.send({ jsonrpc: '2.0', method, params }); }
  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) throw new Error('ACP 通道已关闭');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    const limit = this.options.maxLineBytes ?? 32 * 1024 * 1024;
    let newline: number;
    // 一个数据块可能含多条消息，消费完整行后保留末尾半行。完整行和残留缓冲分别按字节检查上限。
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > limit) { this.fail(new Error('ACP 消息超过大小限制')); return; }
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line);
        if (!message || message.jsonrpc !== '2.0' || typeof message !== 'object') throw new Error();
      } catch { this.emit('protocolError', '忽略了无效的 ACP JSON-RPC 消息'); continue; }
      this.dispatch(message);
    }
    if (Buffer.byteLength(this.buffer) > limit) this.fail(new Error('ACP 行缓冲超过大小限制'));
  }
  /** 带 method 的消息由服务端发起，其中有 id 的需要应答。其余消息用 id 结清本地请求。 */
  private dispatch(message: JsonRpcMessage): void {
    if ('method' in message) {
      if (typeof message.method !== 'string') return;
      if ('id' in message) { void this.handleRequest(message); }
      else { this.emit('notification', message.method, message.params); if (message.method === 'session/update' || message.method === '$/cancel_request') this.emit(message.method, message.params); }
      return;
    }
    if (!this.outstanding.has(message.id)) return;
    const onLate = this.outstanding.get(message.id);
    this.outstanding.delete(message.id);
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (pending?.timer) clearTimeout(pending.timer);
    if (message.error) {
      const { code, message: reason, data } = message.error;
      const diagnostic = errorDiagnosticCode(new AcpRpcError(code, reason, data));
      this.lastErrorCode = diagnostic;
      if (diagnostic === 'rate_limited_429' || diagnostic === 'permission_denied_403') {
        const permission = diagnostic === 'permission_denied_403';
        const until = Date.now() + (permission ? 300_000 : 60_000);
        if (until >= this.cooldownUntilMs) {
          this.cooldownUntil = until;
          this.cooldownKind = permission ? 'permission_403' : 'rate_limit_429';
        }
        this.lastError = `官方服务 HTTP ${permission ? 403 : 429}，已熔断连续请求。请检查官方账号权限或等待配额恢复。`;
        this.emit('rateLimited', this.lastError);
        pending?.reject(new AcpRpcError(code, this.lastError, data));
      } else if (diagnostic === 'auth_required_401') {
        // Authentication errors may quote private account details. Only the public reason crosses IPC.
        this.lastError = officialLoginRequiredMessage;
        pending?.reject(new AcpRpcError(code, this.lastError));
      } else {
        this.lastError = diagnosticDetail(reason);
        pending?.reject(new AcpRpcError(code, reason, data));
      }
      this.emit('connection-changed', this.connectionEvent());
    }
    else if ('result' in message) pending?.resolve(message.result);
    else pending?.reject(new Error('ACP 响应缺少结果'));
    if (!pending) onLate?.(message);
  }
  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    // 记录收到请求时的子进程。人工审批可能跨越重连，旧请求的决定只能回给原连接。
    const transport = this.child;
    const handler = this.handlers.get(message.method);
    try {
      if (!handler) throw new AcpRpcError(-32601, '客户端未声明支持此操作');
      const result = await handler(message.params, message.id);
      if (transport === this.child) this.send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (transport !== this.child) return;
      try { this.send({ jsonrpc: '2.0', id: message.id, error: { code: error instanceof AcpRpcError ? error.code : -32603, message: error instanceof AcpRpcError ? error.message : '客户端请求处理失败，未执行授权' } }); } catch { /* 连接已关闭 */ }
    }
  }
  /** 连接失效时同时结束所有等待中的请求，并通知上层取消挂起的审批。 */
  private fail(error: Error): void {
    const child = this.child;
    if (!child) return;
    const group = this.macGroup;
    // During a graceful stop the pipes may close before the Windows ACP process exits.
    // Leave its parent PID alive until the owner can reap the entire tree.
    if (this.stopping) return;
    if (this.windowsTree) {
      this.retiring = true;
      this.stop().catch(() => this.emit('diagnostic', '未能完整关闭 Windows ACP 进程树'));
      return;
    }
    if (group) { this.reapMacGroup(child, group, false, error).catch(() => this.emit('diagnostic', '未能完整关闭 ACP 进程组')); return; }
    this.disconnect(error);
    if (!group && child.exitCode == null && child.signalCode == null) child.kill();
  }
  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) { if (item.timer) clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  private disconnect(error: Error): void {
    if (this.lastExitCode === undefined) this.lastExitCode = this.child?.exitCode;
    if (this.lastSignal === undefined) this.lastSignal = this.child?.signalCode;
    this.retiring = false; this.windowsTree = undefined;
    this.child = undefined; this.macGroup = undefined; this.initializeResult = undefined; this.lastError = error.message;
    this.lastErrorCode = errorDiagnosticCode(error) === 'agy_binary_missing' ? 'agy_binary_missing' : 'acp_disconnected';
    this.rejectPending(error);
    this.outstanding.clear();
    const event = this.connectionEvent();
    this.emit('disconnected', event);
    this.emit('connection-changed', event);
  }
  private reapMacGroup(child: AcpChildProcess, group: MacAcpProcessGroup, graceful: boolean, reason: Error): Promise<void> {
    if (this.stopping) return this.stopping;
    // Install the barrier before ending stdin, which may synchronously signal an error.
    this.retiring = true;
    const closing = Promise.resolve().then(() => group.close(graceful)).finally(() => {
      try { if (this.child === child) this.disconnect(reason); }
      finally { this.stopping = undefined; }
    });
    this.stopping = closing;
    return closing;
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child; if (!child) return;
    if (this.macGroup) return this.reapMacGroup(child, this.macGroup, true, new Error('ACP 已停止'));
    this.retiring = true;
    this.stopping = Promise.resolve().then(async () => {
      if (this.windowsTree) await this.windowsTree.close();
      else await this.closeTransport(child);
      if (this.child === child) this.disconnect(new Error('ACP 已停止'));
    });
    try { await this.stopping; }
    catch (error) {
      // Retain the generation and slots when the kernel could not confirm that the tree is empty.
      this.rejectPending(new Error('ACP 已中断，旧进程树回收未确认'));
      this.emit('connection-changed', this.connectionEvent());
      throw error;
    } finally { this.stopping = undefined; }
  }
  private async closeTransport(child: AcpChildProcess): Promise<void> {
    // 保留短暂正常退出窗口，随后只终止本实例所拥有的 PID 及其子树。
    await new Promise<void>(resolve => {
      const finished = () => {
        clearTimeout(timer);
        child.off('exit', finished);
        child.off('close', finished);
        resolve();
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 700);
      if (child.exitCode != null || child.signalCode != null) return finished();
      child.once('exit', finished);
      child.once('close', finished);
      child.stdin?.end();
    });
  }
  async launchOfficialLogin(args = [...this.nextStartArgs.filter(arg => arg !== '--login'), '--login']): Promise<{ launched: boolean; message: string }> {
    if (this.stopping) await this.stopping;
    if (this.loggingIn) throw new Error('官方登录窗口已打开');
    if (this.child) throw new Error('请先关闭活动会话并断开 ACP，再启动官方登录');
    const binary = this.options.spawn ? (this.options.binaryPath || 'agy') : discoverAgyBinary(this.options.binaryPath);
    validateAgyArgs(args);
    if (!args.includes('--login')) throw new Error('登录入口必须包含官方 --login 参数');
    this.loggingIn = true;
    try {
      if (this.options.loginLauncher) await this.options.loginLauncher(binary, args);
      else await new Promise<void>((resolve, reject) => {
        const child = (this.options.spawn || spawn)(binary, args, { env: buildAgyEnvironment(binary), stdio: 'inherit', shell: false, windowsHide: false });
        child.once('error', () => reject(new Error('官方登录终端启动失败')));
        child.once('close', (code: number) => code === 0 ? resolve() : reject(new Error('官方登录未成功完成')));
      });
      return { launched: true, message: '官方登录流程已完成，请重新连接会话' };
    } finally { this.loggingIn = false; }
  }
}
