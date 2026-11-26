// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreService } from '../src/main/core-service';
import { ClientStore } from '../src/main/storage/client-store';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { TITLE_ORGANIZE_RATE_LIMIT } from '../src/shared';

class HydrogenFakeAcpChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  sent: any[] = [];
  promptCount = 0;
  private seq = 0;
  readonly config = new Map<string, Record<string, string>>();
  omitMedium = false;
  stopReason = 'end_turn';
  private replyFn: (promptText: string, sessionId: string) => string;

  stdin = new Writable({
    write: (chunk, _enc, done) => {
      const msg = JSON.parse(chunk.toString());
      this.sent.push(msg);
      queueMicrotask(() => this.handle(msg));
      done();
    },
  });

  constructor(replyFn: (promptText: string, sessionId: string) => string) {
    super();
    this.replyFn = replyFn;
    this.stdin.on('finish', () => setImmediate(() => this.emit('close', 0)));
  }

  private emitMsg(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  private handle(msg: any): void {
    const { id, method, params = {} } = msg;
    if (id === undefined) return;
    if (method === 'initialize') {
      this.emitMsg({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'Antigravity ACP', version: '1.5.11' },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {}, resume: {}, close: {} },
            _meta: { antigravity: { systemPrompt: { append: true } } },
          },
        },
      });
      return;
    }
    if (method === 'session/list') {
      this.emitMsg({ jsonrpc: '2.0', id, result: { sessions: [] } });
      return;
    }
    if (method === 'session/new') {
      const sessionId = `hy-sess-${++this.seq}`;
      this.config.set(sessionId, { model: 'gemini-4-carbon', thought_level: 'high', mode: 'default' });
      this.emitMsg({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              currentValue: 'gemini-4-carbon',
              options: [
                { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
                { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
              ],
            },
            {
              id: 'thought_level',
              name: 'Effort',
              currentValue: 'high',
              options: [
                { value: 'low', name: 'low' },
                ...(this.omitMedium ? [] : [{ value: 'medium', name: 'medium' }]),
                { value: 'high', name: 'high' },
              ],
            },
            {
              id: 'mode',
              name: 'Mode',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'default' },
                { value: 'plan', name: 'plan' },
              ],
            },
          ],
        },
      });
      return;
    }
    if (method === 'session/set_config_option') {
      const values = this.config.get(params.sessionId)!;
      values[params.configId] = params.value;
      this.emitMsg({
        jsonrpc: '2.0',
        id,
        result: {
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              currentValue: values.model,
              options: [
                { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
                { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
              ],
            },
            {
              id: 'thought_level',
              name: 'Effort',
              currentValue: values.thought_level,
              options: [
                { value: 'low', name: 'low' },
                ...(this.omitMedium ? [] : [{ value: 'medium', name: 'medium' }]),
                { value: 'high', name: 'high' },
              ],
            },
            {
              id: 'mode',
              name: 'Mode',
              currentValue: values.mode,
              options: [
                { value: 'default', name: 'default' },
                { value: 'plan', name: 'plan' },
              ],
            },
          ],
        },
      });
      return;
    }
    if (method === 'session/prompt') {
      this.promptCount += 1;
      const text = (params.prompt || [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
      const replyText = this.replyFn(text, params.sessionId);
      this.emitMsg({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: replyText },
          },
        },
      });
      this.emitMsg({ jsonrpc: '2.0', id, result: { stopReason: this.stopReason } });
      return;
    }
    if (method === 'session/close') {
      this.emitMsg({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    this.emitMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown' } });
  }

  kill(): boolean {
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

const dirs: string[] = [];
const disposers: Array<() => Promise<void> | void> = [];

function mkDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const fn of disposers.splice(0)) await fn();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('v0.2.0 遥测：会话平均 TPS 与平均缓存命中率', () => {
  it('区分实时 TPS 与会话累计平均 TPS，准确计算平均缓存命中率并跨重启持久化', () => {
    let now = Date.UTC(2026, 10, 19, 12, 0, 0);
    const disk = new ClientStore(mkDir('gravity-v020-tele-'));
    const store = new TelemetryStore({ store: disk, now: () => now });
    disposers.push(() => store.dispose());

    // Turn 1: 100 output tokens over 2s -> 50 tok/s; 200/1000 cached -> 20%
    store.beginTurn('s1', 'first');
    store.addChunk('s1', '一'.repeat(50));
    now += 2000;
    store.addChunk('s1', '二'.repeat(50));
    store.applyUsage('s1', { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 });
    store.endTurn('s1');

    let st = store.snapshot().activeSessions.s1;
    expect(st.currentTokensPerSecond).toBeCloseTo(50, 1);
    expect(st.averageTokensPerSecond).toBeCloseTo(50, 1);
    expect(st.averageCacheHitRate).toBeCloseTo(0.2, 4);

    // Turn 2: 300 output tokens over 2s -> 150 tok/s; cumulative avg = (100+300)/(2+2) = 100 tok/s
    // Input: 1000 total with 800 cached -> cumulative cache hit = (200+800)/(1000+1000) = 50%
    now += 1000;
    store.beginTurn('s1', 'second');
    store.addChunk('s1', '三'.repeat(150));
    now += 2000;
    store.addChunk('s1', '四'.repeat(150));
    store.applyUsage('s1', { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 300 });
    store.endTurn('s1');

    st = store.snapshot().activeSessions.s1;
    expect(st.currentTokensPerSecond).toBeCloseTo(150, 1);
    expect(st.averageTokensPerSecond).toBeCloseTo(100, 1);
    expect(st.averageCacheHitRate).toBeCloseTo(0.5, 4);

    // 重载持久化验证
    store.flush();
    const reloaded = new TelemetryStore({ store: disk, now: () => now });
    disposers.push(() => reloaded.dispose());
    const restored = reloaded.snapshot().activeSessions.s1;
    expect(restored.averageTokensPerSecond).toBeCloseTo(100, 1);
    expect(restored.averageCacheHitRate).toBeCloseTo(0.5, 4);
  });
});

describe('v0.2.0 内置 Hydrogen (medium) 标题整理与共享冷却', () => {
  it('未确认 medium 打开临时会话仍计入冷却窗口（TTL-01），中断的回复保留以前的标题，窗口恢复后可正常整理', async () => {
    let now = Date.UTC(2026, 10, 19, 13, 0, 0);
    const child = new HydrogenFakeAcpChild(text => {
      const [row] = JSON.parse(text.slice(text.lastIndexOf('[')));
      return JSON.stringify([{ sessionId: row.sessionId, organizedTitle: '示例｜合成标题' }]);
    });
    const dir = mkDir('gravity-title-preflight-');
    const core = new CoreService({ dataDir: dir, now: () => now, acpOptions: { spawn: () => child } });
    disposers.push(() => core.dispose());
    const row = await core.createSession({ cwd: dir, title: '原标题' });

    // TTL-01: 缺 medium 仍已真实发出 session/new，必须计入窗口额度，不能无限重试刷会话
    child.omitMedium = true;
    for (let i = 0; i < TITLE_ORGANIZE_RATE_LIMIT.maxCalls; i++) {
      now += 1000;
      await expect(core.organizeTitles()).rejects.toThrow(/medium/);
    }
    now += 1000;
    await expect(core.organizeTitles()).rejects.toThrow(/冷却限制|最多整理/);
    expect(child.promptCount).toBe(0);

    // 冷却窗口过期后恢复额度：验证中断保留原标题 + 正常整理成功
    now += TITLE_ORGANIZE_RATE_LIMIT.windowMs + 1000;
    child.omitMedium = false;
    child.stopReason = 'cancelled';
    await expect(core.organizeTitles()).rejects.toThrow(/未完整结束/);
    expect((await core.listSessions())[0]).toMatchObject({ sessionId: row.sessionId, title: '原标题' });
    child.stopReason = 'end_turn';
    expect(await core.organizeTitles()).toMatchObject({
      updatedCount: 1,
      remainingQuotaInWindow: TITLE_ORGANIZE_RATE_LIMIT.maxCalls - 2,
    });
  });
  it('整理等待期间手动改名的会话保留用户标题，同批其他会话仍可提交', async () => {
    let manualChange: Promise<unknown>;
    const child = new HydrogenFakeAcpChild(text => {
      const rows = JSON.parse(text.slice(text.lastIndexOf('['))) as { sessionId: string }[];
      manualChange = core.renameSession(rows[0].sessionId, '用户刚改的标题');
      return JSON.stringify(rows.map(row => ({ ...row, organizedTitle: '示例｜模型建议' })));
    });
    const dir = mkDir('gravity-title-edit-');
    const core = new CoreService({ dataDir: dir, acpOptions: { spawn: () => child } });
    disposers.push(() => core.dispose());
    const first = await core.createSession({ cwd: dir, title: '甲' });
    await core.createSession({ cwd: dir, title: '乙' });
    const result = await core.organizeTitles();
    await manualChange!;
    expect(result).toMatchObject({ updatedCount: 1, skippedChangedCount: 1 });
    expect((await core.listSessions()).find(s => s.sessionId === first.sessionId)?.title).toBe('用户刚改的标题');
    expect(result.nextBatch).toBeUndefined();
  });
  it('每次只发一批，未答的条目和超过上限的条目留待用户点击继续', async () => {
    const calls: string[][] = [];
    const child = new HydrogenFakeAcpChild(text => {
      const items = JSON.parse(text.slice(text.lastIndexOf('['))) as { sessionId: string }[];
      calls.push(items.map(item => item.sessionId));
      const replies = calls.length === 1 ? items.slice(1) : items;
      return JSON.stringify(replies.map(item => ({ ...item, organizedTitle: 'Docs｜测试标题' })));
    });
    const dataDir = mkDir('gravity-title-batch-');
    const core = new CoreService({ dataDir, acpOptions: { spawn: () => child } });
    disposers.push(() => core.dispose());
    for (let i = 0; i < 31; i++) {
      const s = await core.createSession({ cwd: dataDir, title: 'Title ' + i });
      await core.closeSession(s.sessionId);
    }
    const writes = vi.spyOn(core.store, 'write');
    const first = await core.organizeTitles({ scope: 'all' });
    expect(writes.mock.calls.filter(([file]) => file === 'titles.json')).toHaveLength(1);
    expect(writes.mock.calls.filter(([file]) => file.startsWith('owned-sessions'))).toHaveLength(0);
    writes.mockRestore();
    expect(calls.map(batch => batch.length)).toEqual([30]);
    expect(first.updatedCount).toBe(29);
    expect(first.nextBatch?.sessionIds).toHaveLength(2);
    const next = await core.organizeTitles(first.nextBatch);
    expect(calls[1]).toHaveLength(2);
    expect(calls[1]).toContain(calls[0][0]);
    expect(next.nextBatch).toBeUndefined();
    expect(next.updatedCount).toBe(2);
    expect(child.promptCount).toBe(2);
  });
  it('使用 Hydrogen (medium) 整理，全部整理跳过已整理会话，单会话/单项目可重整且共享 1 分钟 4 次冷却', async () => {
    let now = Date.UTC(2026, 10, 19, 12, 0, 0);
    let round = 0;
    const child = new HydrogenFakeAcpChild((promptText) => {
      if (!promptText.includes('[Gravity Title Organizer]')) return '普通回复';
      round += 1;
      const jsonStart = promptText.lastIndexOf('[');
      const items = JSON.parse(promptText.slice(jsonStart)) as Array<{ sessionId: string; currentTitle: string }>;
      return JSON.stringify(
        items.map((item) => ({
          sessionId: item.sessionId,
          categoryTag: `AI${round}`,
          organizedTitle: `AI${round}｜${item.currentTitle.replace(/^AI\d+｜/, '')}-精炼${round}`,
        }))
      );
    });

    const dataDir = mkDir('gravity-v020-core-');
    const workA = mkDir('gravity-v020-projA-');
    const workB = mkDir('gravity-v020-projB-');
    const core = new CoreService({
      dataDir,
      now: () => now,
      acpOptions: { spawn: () => child },
    });
    disposers.push(() => core.dispose());

    const sA = await core.createSession({ cwd: workA, title: '新建对话' });
    const sB = await core.createSession({ cwd: workB, title: '检查后端连接' });

    // 发送首条消息不会自动触发标题整理（仅保留首句原样摘要，不写 titleOrganizedAt）
    await core.sendPrompt({ sessionId: sA.sessionId, text: '帮我调整前端配色和额度条' });
    const afterSend = (await core.listSessions()).find((s) => s.sessionId === sA.sessionId)!;
    expect(afterSend.title).toBe('帮我调整前端配色和额度条');
    expect(afterSend.titleOrganizedAt).toBeUndefined();

    // 第 1 次：[全部整理] -> 通过 Hydrogen (medium) 整理 sA 与 sB
    const r1 = await core.organizeTitles({ scope: 'all' });
    expect(r1.updatedCount).toBe(2);
    expect(r1.modelUsed).toBe('Gemini 4 Hydrogen (medium)');
    expect(r1.remainingQuotaInWindow).toBe(3);

    // 验证发送给了 gemini-4-hydrogen + thought_level=medium + mode=plan，并立即关闭临时会话
    const setModelCall = child.sent.find(
      (m) => m.method === 'session/set_config_option' && m.params?.configId === 'model' && m.params?.value === 'gemini-4-hydrogen'
    );
    const setEffortCall = child.sent.find(
      (m) => m.method === 'session/set_config_option' && m.params?.configId === 'thought_level' && m.params?.value === 'medium'
    );
    const setModeCall = child.sent.find(
      (m) => m.method === 'session/set_config_option' && m.params?.configId === 'mode' && m.params?.value === 'plan'
    );
    expect(setModelCall).toBeTruthy();
    expect(setEffortCall).toBeTruthy();
    expect(setModeCall).toBeTruthy();
    expect(child.sent.some((m) => m.method === 'session/close' && m.params?.sessionId === setModelCall.params.sessionId)).toBe(true);
    expect(core.sessions.activeSessionCount).toBe(2);

    // 再次点击 [全部整理]：两个会话已整理过 -> 全部跳过，不调用模型也不消耗冷却次数
    const promptsBeforeSkip = child.promptCount;
    const skipped = await core.organizeTitles({ scope: 'all' });
    expect(skipped.updatedCount).toBe(0);
    expect(skipped.skippedOrganizedCount).toBe(2);
    expect(skipped.remainingQuotaInWindow).toBe(3);
    expect(child.promptCount).toBe(promptsBeforeSkip);

    // 第 2 次：单独整理 Project A（允许重整已整理会话）
    const r2 = await core.organizeTitles({ scope: 'project', projectCwd: workA });
    expect(r2.updatedCount).toBe(1);
    expect(r2.suggestions[0].sessionId).toBe(sA.sessionId);
    expect(r2.remainingQuotaInWindow).toBe(2);

    // 第 3 次：单独整理单条会话 sB
    const r3 = await core.organizeTitles({ scope: 'session', sessionIds: [sB.sessionId] });
    expect(r3.updatedCount).toBe(1);
    expect(r3.suggestions[0].sessionId).toBe(sB.sessionId);
    expect(r3.remainingQuotaInWindow).toBe(1);

    // 第 4 次：再次单独整理 sA（用尽 1 分钟内第 4 次）
    const r4 = await core.organizeTitles({ scope: 'session', sessionIds: [sA.sessionId] });
    expect(r4.remainingQuotaInWindow).toBe(0);

    // 第 5 次（不论 all / project / session）均触发共享 1 分钟 4 次冷却拦截
    await expect(core.organizeTitles({ scope: 'session', sessionIds: [sB.sessionId] })).rejects.toThrow(/冷却限制.*4 次/);
    await expect(core.organizeTitles({ scope: 'project', projectCwd: workA })).rejects.toThrow(/冷却限制.*4 次/);
    await expect(core.organizeTitles({ scope: 'all' })).rejects.toThrow(/冷却限制.*4 次/);

    // 61 秒后冷却解除，可再次整理
    now += 61_000;
    const r5 = await core.organizeTitles({ scope: 'session', sessionIds: [sB.sessionId] });
    expect(r5.updatedCount).toBe(1);
    expect(r5.remainingQuotaInWindow).toBe(3);
  });
});

describe('v0.2.0 正文图片复制（openLinkOrFileTarget copy-image）', () => {
  it('支持复制本地图片与大尺寸 data:image，拦截目录与敏感凭据路径', async () => {
    const dir = mkDir('gravity-v020-img-');
    const imgPath = path.join(dir, 'render.png');
    writeFileSync(imgPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const handler = vi.fn();
    const core = new CoreService({ dataDir: mkDir('gravity-v020-img-data-'), openTargetHandler: handler });
    disposers.push(() => core.dispose());

    const expectedImgPath = realpathSync(imgPath);
    const resLocal = await core.openLinkOrFileTarget({ target: 'render.png', action: 'copy-image', cwd: dir });
    expect(resLocal).toEqual({ opened: true, modeUsed: 'copy-image', resolvedTarget: expectedImgPath });
    expect(handler).toHaveBeenCalledWith(expectedImgPath, 'copy-image', false);

    // 超过 4096 字节的 data:image base64 也能直接通过 copy-image 复制
    const bigDataUrl = 'data:image/png;base64,' + 'A'.repeat(8192);
    const resData = await core.openLinkOrFileTarget({ target: bigDataUrl, action: 'copy-image' });
    expect(resData.modeUsed).toBe('copy-image');
    expect(handler).toHaveBeenLastCalledWith(bigDataUrl, 'copy-image');

    // 目录与敏感路径必须拒绝
    await expect(core.openLinkOrFileTarget({ target: dir, action: 'copy-image' })).rejects.toThrow('目录');
    await expect(
      core.openLinkOrFileTarget({ target: 'C:\\Users\\demo\\.gemini\\oauth_creds.json', action: 'copy-image' })
    ).rejects.toThrow('敏感凭据');
  });
});
