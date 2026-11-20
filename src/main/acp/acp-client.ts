import { EventEmitter } from 'node:events';
import { spawn, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, isAbsolute } from 'node:path';
import { APP_BRAND } from '../../shared/theme-i18n-contract';
import { ALLOWED_AGY_ACP_FLAGS, FORBIDDEN_AGY_FLAGS } from '../../shared/acp-protocol';
import type { AcpInitializeResult, JsonRpcId, JsonRpcMessage, JsonRpcRequest } from '../../shared/acp-protocol';

export interface AcpChildProcess extends EventEmitter {
  stdin: Writable | null; stdout: Readable | null; stderr: Readable | null;
  pid?: number; kill(signal?: NodeJS.Signals | number): boolean;
}
export type AcpSpawn = (binary: string, args: string[], options: SpawnOptions) => AcpChildProcess;
export interface AcpClientOptions {
  binaryPath?: string; args?: string[]; cwd?: string; spawn?: AcpSpawn;
  requestTimeoutMs?: number; maxLineBytes?: number;
  loginLauncher?: (binary: string, args?: string[]) => Promise<void>;
}
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
const isAnyAbsolutePath = (value: string): boolean =>
  isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');

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
export function discoverAgyBinary(configured?: string): string {
  if (configured) {
    if (!isAnyAbsolutePath(configured) || !/^agy(?:\.exe)?$/i.test(configured.split(/[\\/]/).pop() || '')) throw new Error('请指定官方 agy 可执行文件的绝对路径');
    return configured;
  }
  const names = process.platform === 'win32' ? ['agy.exe'] : ['agy'];
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    // macOS / Linux 从图形桌面启动时常不继承交互式 Shell 的 PATH，补充常见官方/用户安装目录只读检索。
    const home = homedir();
    for (const extra of ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, 'bin')]) {
      if (!dirs.includes(extra)) dirs.push(extra);
    }
  }
  for (const dir of dirs) {
    for (const name of names) { const path = join(dir.replace(/^"|"$/g, ''), name); if (existsSync(path)) return path; }
  }
  throw new Error('未找到官方 agy，请将其加入 PATH 或设置 AGY_BINARY_PATH');
}

/** 一个实例只拥有一个常驻 ACP 主进程。request 处理器可挂起而不阻塞其他会话。 */
export class AcpClient extends EventEmitter {
  private child?: AcpChildProcess;
  private nextId = 1;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private handlers = new Map<string, (params: unknown, id: JsonRpcId) => unknown | Promise<unknown>>();
  private connecting?: Promise<AcpInitializeResult>;
  private stopping?: Promise<void>;
  private loggingIn = false;
  initializeResult?: AcpInitializeResult;
  binaryPath = '';
  lastError?: string;
  private cooldownUntil = 0;
  constructor(readonly options: AcpClientOptions = {}) { super(); }
  get connected(): boolean { return !!this.child && !!this.initializeResult; }
  get isRateLimited(): boolean { return Date.now() < this.cooldownUntil; }
  registerRequestHandler(method: string, handler: (params: unknown, id: JsonRpcId) => unknown | Promise<unknown>): void { this.handlers.set(method, handler); }
  /** 复用正在进行的握手。首次同时打开多个会话时，所有调用者等待同一次 initialize。 */
  async start(): Promise<AcpInitializeResult> {
    if (this.stopping) await this.stopping;
    if (this.loggingIn) throw new Error('官方登录正在进行，请完成登录后再连接');
    if (this.initializeResult && this.child) return this.initializeResult;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }
  private async connect(): Promise<AcpInitializeResult> {
    const args = validateAgyArgs(this.options.args || ['acp']);
    if (args.includes('--login')) throw new Error('交互登录必须使用独立的显式登录入口');
    this.binaryPath = this.options.spawn ? (this.options.binaryPath || 'agy') : discoverAgyBinary(this.options.binaryPath);
    this.buffer = ''; this.decoder = new StringDecoder('utf8');
    const child = (this.options.spawn || spawn)(this.binaryPath, args, { cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child = child;
    // 标准输出可能从一个汉字的中间断开。解码器先拼齐 UTF-8 字节，receive 再按换行拆 JSON。
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (this.child === child) this.receive(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    });
    child.stdout?.once('end', () => { if (this.child === child) this.fail(new Error('ACP 标准输出已关闭')); });
    // stderr 仅发出诊断信号，不落盘、不发送给独立 API。
    child.stderr?.on('data', () => this.emit('diagnostic', '官方 ACP 进程产生诊断输出'));
    child.stdin?.on('error', () => { if (this.child === child) this.fail(new Error('ACP 标准输入已关闭')); });
    child.once('error', () => { if (this.child === child) this.fail(new Error('无法启动官方 agy，请检查路径与执行权限')); });
    child.once('close', () => { if (this.child === child) this.fail(new Error('官方 ACP 进程已退出')); });
    try {
      const result = await this.request<AcpInitializeResult>('initialize', {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: 'gravity', version: APP_BRAND.version },
      });
      if (result?.protocolVersion !== 1 || !result.agentCapabilities) throw new Error('官方 ACP 返回了不兼容的协议版本');
      if (this.child !== child) throw new Error('握手期间 ACP 连接已关闭');
      this.initializeResult = result; this.lastError = undefined; this.emit('connected', result); return result;
    } catch (error) { if (this.child === child) await this.stop(); throw error; }
  }
  /** 每个请求按 id 配对响应。正超时值会启动定时器，传入 0 则由响应或断连结束等待。 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 30000): Promise<T> {
    if (Date.now() < this.cooldownUntil && !['initialize', 'session/close'].includes(method)) {
      return Promise.reject(new Error(`官方服务触发配额或权限限制，已暂停连续请求；请在 ${Math.ceil((this.cooldownUntil - Date.now()) / 1000)} 秒后核对账号权限或配额再试`));
    }
    if (!this.child?.stdin) return Promise.reject(new Error('ACP 尚未连接'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP 请求超时：${method}`)); }, timeoutMs) : undefined;
      timer?.unref();
      // 先登记回调再写入管道，即使对端立即回答也能找到等待者。
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { if (timer) clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params?: unknown): void { this.send({ jsonrpc: '2.0', method, params }); }
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
      try {
        const message = JSON.parse(line);
        if (!message || message.jsonrpc !== '2.0' || typeof message !== 'object') throw new Error();
        this.dispatch(message as JsonRpcMessage);
      } catch { this.emit('protocolError', '忽略了无效的 ACP JSON-RPC 消息'); }
    }
    if (Buffer.byteLength(this.buffer) > limit) this.fail(new Error('ACP 行缓冲超过大小限制'));
  }
  /** 带 method 的消息由服务端发起，其中有 id 的需要应答。其余消息用 id 结清本地请求。 */
  private dispatch(message: JsonRpcMessage): void {
    if ('method' in message) {
      if (typeof message.method !== 'string') return;
      if ('id' in message) { void this.handleRequest(message); }
      else { this.emit('notification', message.method, message.params); this.emit(message.method, message.params); }
      return;
    }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      const errorText = `${message.error.code} ${message.error.message} ${JSON.stringify(message.error.data || {})}`;
      // 将限制记在当前连接。冷却期间普通请求在写管道前被拦截，握手和关闭会话仍可进行。
      if (/\b(?:429|403|RESOURCE_EXHAUSTED|PERMISSION_DENIED)\b/i.test(errorText)) {
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + (/403|PERMISSION_DENIED/i.test(errorText) ? 300000 : 60000));
        this.lastError = '官方服务触发配额或权限限制，已熔断连续请求。请检查官方账号权限或等待配额恢复。';
        this.emit('rateLimited', this.lastError);
        pending.reject(new AcpRpcError(message.error.code, this.lastError));
      } else pending.reject(new AcpRpcError(message.error.code, message.error.message, message.error.data));
    }
    else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('ACP 响应缺少结果'));
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
    const child = this.child; this.child = undefined; this.initializeResult = undefined; this.lastError = error.message;
    for (const item of this.pending.values()) { if (item.timer) clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); child?.kill(); this.emit('disconnected', error.message);
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child; if (!child) return;
    this.stopping = this.closeTransport(child);
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  private async closeTransport(child: AcpChildProcess): Promise<void> {
    // 保留短暂正常退出窗口，随后只终止本实例所拥有的 PID 及其子树。
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid && !this.options.spawn) {
          const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          const cleanupTimeout = setTimeout(() => { child.kill(); resolve(); }, 2000);
          cleanup.once('close', () => { clearTimeout(cleanupTimeout); resolve(); });
          cleanup.once('error', () => { clearTimeout(cleanupTimeout); child.kill(); resolve(); });
        } else { child.kill('SIGKILL'); resolve(); }
      }, 700);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin?.end();
    });
    if (this.child === child) this.fail(new Error('ACP 已停止'));
  }
  async launchOfficialLogin(args = [...(this.options.args || ['acp']).filter(arg => arg !== '--login'), '--login']): Promise<{ launched: boolean; message: string }> {
    if (this.loggingIn) throw new Error('官方登录窗口已打开');
    if (this.child) throw new Error('请先关闭活动会话并断开 ACP，再启动官方登录');
    const binary = this.options.spawn ? (this.options.binaryPath || 'agy') : discoverAgyBinary(this.options.binaryPath);
    validateAgyArgs(args);
    if (!args.includes('--login')) throw new Error('登录入口必须包含官方 --login 参数');
    this.loggingIn = true;
    try {
      if (this.options.loginLauncher) await this.options.loginLauncher(binary, args);
      else await new Promise<void>((resolve, reject) => {
        const child = (this.options.spawn || spawn)(binary, args, { stdio: 'inherit', shell: false, windowsHide: false });
        child.once('error', () => reject(new Error('官方登录终端启动失败')));
        child.once('close', (code: number) => code === 0 ? resolve() : reject(new Error('官方登录未成功完成')));
      });
      return { launched: true, message: '官方登录流程已完成，请重新连接会话' };
    } finally { this.loggingIn = false; }
  }
}
