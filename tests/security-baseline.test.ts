// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, WebContents, IpcMainInvokeEvent } from 'electron';
import { registerIpcRouter } from '../src/main/ipc-router';
import type { CoreService } from '../src/main/core-service';
import { IPC_CHANNELS } from '../src/shared';

describe('IPC 来源隔离与生命周期', () => {
  function setup() {
    const handlers = new Map<string, Function>();
    const ipcMain = { handle: (channel: string, callback: Function) => handlers.set(channel, callback), removeHandler: (channel: string) => handlers.delete(channel) } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const service = Object.assign(new EventEmitter(), { getBootstrap: vi.fn().mockResolvedValue({ ok: true }) }) as unknown as CoreService;
    const dispose = registerIpcRouter(ipcMain, service, trusted);
    const event = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    return { handlers, trusted, service, dispose, event };
  }
  it('仅主窗口主 frame 和匹配 URL 能调用；拒绝其他窗口与 iframe', async () => {
    const { handlers, trusted, service, dispose, event } = setup();
    try {
      const callback = handlers.get(IPC_CHANNELS.APP_GET_BOOTSTRAP)!;
      expect(await callback(event)).toEqual({ ok: true });
      expect(() => callback({ ...event, sender: {} })).toThrow('非主窗口');
      expect(() => callback({ ...event, senderFrame: { url: trusted.getURL() } })).toThrow('非主窗口');
      expect(service.getBootstrap).toHaveBeenCalledTimes(1);
    } finally { dispose(); }
  });
  it('参数数量与体积限制，卸载移除全部路由及事件订阅', () => {
    const { handlers, trusted, service, dispose, event } = setup();
    const callback = handlers.get(IPC_CHANNELS.APP_GET_BOOTSTRAP)!;
    expect(() => callback(event, 1, 2, 3, 4)).toThrow('数量');
    expect(() => callback(event, 'x'.repeat(32 * 1024 * 1024))).toThrow('大小');
    service.emit('session-updated', { sessionId: 'a' });
    expect(trusted.send).toHaveBeenCalledWith(IPC_CHANNELS.EVENT_SESSION_UPDATED, { sessionId: 'a' });
    dispose(); expect(handlers.size).toBe(0);
    expect(service.listenerCount('session-updated')).toBe(0);
    service.emit('session-updated', { sessionId: 'b' }); expect(trusted.send).toHaveBeenCalledTimes(1);
  });
});

describe('沙箱 preload 真实编译与最小桥接', () => {
  it('运行时仅 require electron，暴露冻结桥接，事件返回可用取消订阅函数', async () => {
    const source = readFileSync('src/main/preload.ts', 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const ipc = Object.assign(new EventEmitter(), { invoke: vi.fn().mockResolvedValue({ ok: true }) });
    let bridge: any;
    const exposed = new Map<string, unknown>();
    const contextBridge = { exposeInMainWorld: vi.fn((name, value) => { exposed.set(name, value); bridge = value; }) };
    const requireSpy = vi.fn((name) => { if (name !== 'electron') throw new Error(`沙箱不支持模块：${name}`); return { contextBridge, ipcRenderer: ipc }; });
    vm.runInNewContext(compiled, { exports: {}, require: requireSpy });
    expect(exposed.has('gravityDesktop')).toBe(true);
    expect(requireSpy.mock.calls.map((call) => call[0])).toEqual(['electron']);
    expect(Object.isFrozen(bridge)).toBe(true);
    await bridge.getBootstrap(); expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_GET_BOOTSTRAP);
    await bridge.submitApprovalDecision({ requestId: 'r', sessionId: 's', decision: 'allow_once' });
    expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.APPROVAL_SUBMIT_DECISION, { requestId: 'r', sessionId: 's', decision: 'allow_once' });
    const listener = vi.fn(); const unsubscribe = bridge.onApprovalRequested(listener);
    ipc.emit(IPC_CHANNELS.EVENT_APPROVAL_REQUESTED, { sender: 'hidden-event' }, { requestId: 'r' });
    expect(listener).toHaveBeenCalledWith({ requestId: 'r' });
    unsubscribe(); ipc.emit(IPC_CHANNELS.EVENT_APPROVAL_REQUESTED, {}, {}); expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge).not.toHaveProperty('ipcRenderer'); expect(bridge).not.toHaveProperty('require');
  });
});

describe('自动静态回归守卫（不替代人工合规审查）', () => {
  function files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
  }
  it('运行源码字符串不包含私有端点 URL 或硬编码官方凭据文件路径', () => {
    const violations: string[] = [];
    for (const file of files('src')) {
      const syntax = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node)) {
          if (/https?:\/\/[^\s]*cloudcode-pa\./i.test(node.text) || /(?:~|[A-Z]:|%APPDATA%)[\\/].*(?:\.gemini|antigravity-cli)[\\/]/i.test(node.text)) violations.push(`${file}:${syntax.getLineAndCharacterOfPosition(node.pos).line + 1}`);
        }
        ts.forEachChild(node, visit);
      }; visit(syntax);
    }
    expect(violations).toEqual([]);
  });
  it('主窗口安全设置与仅本机开发入口保持开启', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toMatch(/contextIsolation:\s*true/); expect(source).toMatch(/nodeIntegration:\s*false/);
    expect(source).toMatch(/sandbox:\s*true/); expect(source).toMatch(/webSecurity:\s*true/);
    expect(source).toContain("url.hostname !== '127.0.0.1'");
    expect(readFileSync('vite.config.ts', 'utf8')).toContain('127.0.0.1');
  });
});
