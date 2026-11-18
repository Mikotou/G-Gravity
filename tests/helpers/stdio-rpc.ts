import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

export type RpcMessage = { jsonrpc: string; id?: number | string; method?: string; params?: any; result?: any; error?: any };

/** 测试端双向 JSON-RPC 客户端；权限请求保留给测试显式应答，绝不默认放行。 */
export class StdioRpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: RpcMessage[] = [];
  stderr = '';
  private nextId = 0;
  private pending = new Map<number | string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  constructor(executable: string, args: string[]) {
    this.child = spawn(executable, args, { stdio: 'pipe', windowsHide: true });
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk); });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      this.messages.push(message);
      if (!message.method && message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
          else pending.resolve(message.result);
        }
      }
      for (const listener of this.listeners) listener(message);
    });
    const rejectPending = (error: Error) => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    };
    this.child.on('error', rejectPending);
    this.child.on('exit', (code) => rejectPending(new Error(`ACP 子进程退出 ${code}: ${this.stderr.slice(-500)}`)));
  }
  send(message: RpcMessage) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  notify(method: string, params: unknown) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method: string, params: unknown = {}, timeoutMs = 5000): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP 请求超时：${method}; ${this.stderr.slice(-500)}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs = 3000): Promise<RpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const listener = (message: RpcMessage) => {
        if (!predicate(message)) return;
        clearTimeout(timer); this.listeners.delete(listener); resolve(message);
      };
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error('等待 ACP 事件超时')); }, timeoutMs);
      this.listeners.add(listener);
    });
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.child.kill(), 1000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
  }
}

/** 仅将自有测试桩编译至隔离临时目录；不改变工程配置和任何业务源码。 */
export async function prepareMockAcp() {
  const directory = await mkdtemp(path.join(tmpdir(), 'agy-qa-mock-'));
  const source = await readFile(path.resolve('tests/helpers/mock-acp-server.ts'), 'utf8');
  const scriptPath = path.join(directory, 'mock-acp-server.cjs');
  await writeFile(scriptPath, ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText);
  return { executable: process.execPath, args: [scriptPath],
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}
