// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThoughtTranslator, detectThoughtLanguage } from '../src/main/translation/thought-translator';
import { TelemetryStore, estimateTokens } from '../src/main/telemetry/telemetry-store';
import { SwarmTracker } from '../src/main/swarm/swarm-tracker';
import { TitleOrganizer } from '../src/main/organizer/title-organizer';
import { ClientStore } from '../src/main/storage/client-store';
import type { ManagedSessionSummary } from '../src/shared';

const dirs: string[] = [];
const telemetryStores: TelemetryStore[] = [];
function store() { const dir = mkdtempSync(path.join(tmpdir(), 'agy-qa-state-')); dirs.push(dir); return new ClientStore(dir); }
afterEach(() => { for (const item of telemetryStores.splice(0)) item.dispose(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('双轨思考增量与异步竞态', () => {
  it('英文跨单词分块不丢块；中文与代码原样保留', () => {
    const translator = new ThoughtTranslator();
    const chunks = ['I need to che', 'ck the file. ', '检查 `test_file.ts`。'];
    let block;
    for (const chunk of chunks) block = translator.append('a', chunk);
    expect(block!.originalText).toBe(chunks.join(''));
    expect(block!.translatedZhText).toContain('检查');
    expect(block!.translatedZhText).toContain('`test_file.ts`');
    expect(block!.languageDetected).toBe('mixed');
    expect(translator.complete('a')!.isStreaming).toBe(false);
    expect(translator.append('b', '检查方案。')).toMatchObject({ originalText: '检查方案。', translatedZhText: '检查方案。', translationSource: 'native-zh' });
  });
  it('空输入、纯英文和混合语言判定不崩溃', () => {
    expect(detectThoughtLanguage('检查')).toBe('zh');
    expect(detectThoughtLanguage('Checking')).toBe('en');
    expect(detectThoughtLanguage('检查 file')).toBe('mixed');
    expect(new ThoughtTranslator().append('empty', '').originalText).toBe('');
  });
  it('新分片到达后旧译文不能覆盖新版本', async () => {
    let resolve!: (value: string) => void;
    const translator = new ThoughtTranslator(() => new Promise((done) => { resolve = done; }));
    translator.append('a', 'Check file'); translator.complete('a');
    const latest = translator.append('a', ' and test');
    const seen: any[] = []; translator.on('block', (block) => seen.push(block));
    resolve('旧译文'); await new Promise((done) => setImmediate(done));
    expect(seen).toEqual([]); expect(latest.originalText).toBe('Check file and test');
  });
  it('清除后复用相同块 ID，旧译文也不能覆盖新块', async () => {
    let resolve!: (value: string) => void;
    const translator = new ThoughtTranslator(() => new Promise((done) => { resolve = done; }));
    translator.append('a', 'Check old file'); translator.complete('a');
    translator.clear('a'); translator.append('a', 'Test new file');
    const seen: any[] = []; translator.on('block', (block) => seen.push(block));
    resolve('检查旧文件'); await new Promise((done) => setImmediate(done));
    expect(seen).toEqual([]);
  });
  it('翻译异常保留干净原文，不产生半英半中词典替换污染', async () => {
    const translator = new ThoughtTranslator(async () => { throw new Error('offline'); });
    translator.append('a', 'Check file'); const result = translator.complete('a');
    await new Promise((done) => setImmediate(done));
    expect(result!.originalText).toBe('Check file'); expect(result!.translatedZhText).toBe('Check file');
  });
  it('本地翻译成功时原文轨道不变', async () => {
    const translator = new ThoughtTranslator(async () => '检查文件');
    translator.append('a', 'Check file'); translator.complete('a');
    const [block] = await once(translator, 'block');
    expect(block).toMatchObject({ originalText: 'Check file', translatedZhText: '检查文件', translationSource: 'local-model' });
  });
  it('正文首字出现前（isStreaming=true）遇到句界或换行立即流式触发本地翻译并保留段落换行', async () => {
    const calls: string[] = [];
    const seenTexts: string[] = [];
    const translator = new ThoughtTranslator(async (seg) => {
      calls.push(seg);
      await new Promise((r) => setImmediate(r));
      return '正在检查核心配置。';
    });
    // 尚未调用 complete()（模拟正文首字出现前的 Thinking 阶段）
    translator.on('block', (b) => seenTexts.push(b.translatedZhText));
    translator.append('live', 'Let us inspect the core configuration.\n\n');
    translator.append('live', 'Next sentence still streaming');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['Let us inspect the core configuration.']);
    // 第一段在流式阶段已变为中文并保留 \n\n，第二段尚未到句界原样紧随其后
    expect(seenTexts.at(-1)).toBe('正在检查核心配置。\n\nNext sentence still streaming');
    translator.dispose();
  });
  it('中英混合思考流中前段为中文时，后续英文段落仍会被分段翻译', async () => {
    const calls: string[] = [];
    const translator = new ThoughtTranslator(async (seg) => {
      calls.push(seg);
      return '两个主要原因：防止历史失效连接。';
    });
    translator.append('mix', '第一段已经是原生中文思考。\n\n');
    translator.append('mix', 'Two primary reasons: prevent stale historical connections.\n\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['Two primary reasons: prevent stale historical connections.']);
    const finalBlock = translator.complete('mix')!;
    expect(finalBlock.translatedZhText).toBe('第一段已经是原生中文思考。\n\n两个主要原因：防止历史失效连接。\n\n');
    translator.dispose();
  });
});

describe('上下文遥测、历史聚合与价格来源', () => {
  const setup = (options = {}) => { const item = new TelemetryStore({ store: store(), now: () => Date.UTC(2026, 10, 17, 12), ...options }); telemetryStores.push(item); return item; };
  it('空历史24小时/168矩阵/30天，全部为零', () => {
    const snapshot = setup().snapshot();
    expect(snapshot.hourly24h).toHaveLength(24); expect(snapshot.matrix7d).toHaveLength(168);
    expect(snapshot.calendar30d).toHaveLength(30);
    expect(new Set(snapshot.calendar30d.map((cell) => cell.date)).size).toBe(30);
    expect(snapshot.calendar30d.at(-1)!.date).toBe('2026-11-17');
    expect(snapshot.calendar30d.every((cell) => cell.totalTokens === 0 && cell.intensity === 0)).toBe(true);
    expect(snapshot.costByRange.today.totalCostUsd).toBe(0);
  });
  it('中文与英文增量估算不随分片数量膨胀，回合结束后保留本轮真实生成速率', () => {
    let now = Date.UTC(2026, 10, 17, 12); const item = setup({ now: () => now });
    item.beginTurn('a', '测试'); item.addChunk('a', 'a'); now += 1000; item.addChunk('a', 'bcd');
    let state = item.snapshot().activeSessions.a;
    expect(state.costSummary.outputTokens).toBe(1); expect(state.currentTokensPerSecond).toBe(1);
    item.addChunk('a', '中文'); state = item.snapshot().activeSessions.a;
    expect(state.costSummary.outputTokens).toBe(3); expect(state.peakTokensPerSecond).toBeGreaterThanOrEqual(1);
    item.endTurn('a'); expect(item.snapshot().activeSessions.a.currentTokensPerSecond).toBeGreaterThan(0);
    expect(estimateTokens('中文abcd')).toBe(3);
  });
  it('大附件使进度封顶 100%，多会话独立且 heatmap 按会话去重', () => {
    const item = setup({ maxContextTokens: 100 });
    item.beginTurn('a', 'x', [{ id: 'attachment', name: 'large.txt', kind: 'file', sizeBytes: 1000000, estimatedTokens: 250000 }]);
    item.addChunk('a', '中文'); item.endTurn('a'); item.beginTurn('a', '再次'); item.endTurn('a');
    item.beginTurn('b', '第二会话');
    const snapshot = item.snapshot();
    expect(snapshot.activeSessions.a.usageRatio).toBe(1); expect(snapshot.activeSessions.a.pressureLevel).toBe('critical');
    expect(snapshot.activeSessions.a.attachments).toHaveLength(1); expect(snapshot.activeSessions.b.attachments).toHaveLength(0);
    expect(snapshot.calendar30d.at(-1)!.sessionCount).toBe(2);
    expect(snapshot.activeSessions.b.usedContextTokens).toBeLessThan(100);
  });
  it('官方 usage 修正为本轮总量，重复回报不重复计费，NaN/负数不污染', () => {
    const item = setup({ rateCards: [{ modelId: 'default', displayName: 'Default', inputPerMillionUsd: 1, cachedInputPerMillionUsd: 0, outputPerMillionUsd: 2, thinkingPerMillionUsd: 2 }] });
    item.beginTurn('a', '提示'); item.addChunk('a', '正文');
    item.applyUsage('a', { inputTokens: 100, outputTokens: 10, thoughtTokens: 5 });
    item.applyUsage('a', { inputTokens: 100, outputTokens: 10, thoughtTokens: 5 });
    const actual = item.snapshot().activeSessions.a;
    // outputTokens 为官方总输出，thoughtTokens 仅是细分，不能再次叠加计费。
    expect(actual.costSummary.inputTokens).toBe(100); expect(actual.costSummary.outputTokens + actual.costSummary.thinkingTokens).toBe(10);
    expect(actual.costSummary.totalCostUsd).toBeCloseTo(.00012);
    item.applyUsage('a', { inputTokens: NaN, outputTokens: -100 });
    expect(item.snapshot().activeSessions.a.costSummary.inputTokens).toBe(100);
  });
  it('默认参考价格与本地估算用量有明确来源', () => {
    const item = setup(); item.beginTurn('a', '测试');
    const snapshot = item.snapshot();
    expect(snapshot.activeSessions.a.pricingSource).toBe('reference-api-estimate');
    expect(snapshot.activeSessions.a.usageSource).toBe('estimated');
    expect(snapshot.pricingSource).toBe('reference-api-estimate');
  });
  it('持久化账本重载后保留历史，30天之外记录清除', () => {
    const disk = store(); disk.write('token-hours.json', [{ hourKey: '2020-01-01T00', modelId: 'default', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, thinkingTokens: 0, sessions: ['old'] }]);
    const first = new TelemetryStore({ store: disk, now: () => Date.UTC(2026, 10, 17) }); telemetryStores.push(first);
    first.beginTurn('a', '中文'); first.endTurn('a'); first.flush();
    const savedHours = disk.read<Array<{ hourKey: string }>>('v2-token-hours.json', []);
    expect(savedHours.map(record => record.hourKey)).toEqual(['2026-11-17T00']);
    const second = new TelemetryStore({ store: disk, now: () => Date.UTC(2026, 10, 17) }); telemetryStores.push(second);
    expect(second.snapshot().calendar30d.at(-1)!.inputTokens).toBe(2);
  });
});

describe('蜂群状态真实成功事件与会话隔离', () => {
  it('pending/failed 不凭空创建 worker；完成通知去重', () => {
    const tracker = new SwarmTracker(); const base = { toolCallId: 'same', title: 'swarm', rawInput: { action: 'spawn', name: 'worker', brief: '核对' } };
    tracker.consume('a', { ...base, sessionUpdate: 'tool_call', status: 'pending' });
    expect(tracker.getState('a').workers).toHaveLength(0);
    tracker.consume('a', { ...base, sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: { name: 'worker', model: 'mock' } });
    tracker.consume('a', { ...base, sessionUpdate: 'tool_call_update', status: 'completed' });
    expect(tracker.getState('a').workers).toHaveLength(1);
    expect(tracker.getState('a').actionTimeline.filter((event) => event.eventType === 'worker_spawned')).toHaveLength(1);
    tracker.consume('b', { ...base, sessionUpdate: 'tool_call', status: 'failed' });
    expect(tracker.getState('b').workers).toHaveLength(0);
  });
  it('子个体 brief/动作/完成摘要/mentions 与其他会话隔离', () => {
    const tracker = new SwarmTracker();
    tracker.consume('a', {
      sessionUpdate: 'tool_call',
      toolCallId: 'spawn-tester',
      name: 'swarm',
      status: 'completed',
      rawInput: { workers: [{ name: 'tester', role: '测试', model: 'mock', brief: '核对边界', workspaceMode: 'branch' }] },
    });
    tracker.consume('a', { sessionUpdate: 'tool_call', toolCallId: 'action', title: 'read_board', status: 'in_progress', rawInput: { sender: 'tester' } });
    expect(tracker.getState('a').workers[0].currentAction).toContain('read_board');
    tracker.consume('a', {
      sessionUpdate: 'tool_call',
      toolCallId: 'done-tester',
      name: 'post_message',
      status: 'completed',
      rawInput: { sender: 'tester', content: '[done] @lead 已核对', channel: 'qa' },
    });
    const state = tracker.getState('a');
    expect(state.workers[0]).toMatchObject({ brief: '核对边界', status: 'completed', workspaceMode: 'branch' });
    expect(state.boardMessages[0].mentions).toEqual(['lead']); expect(state.stats.completed).toBe(1);
    expect(tracker.getState('b').workers).toEqual([]);
  });
  it('真实 Antigravity PascalCase invoke_subagent / send_message / manage_subagents 识别并持久化', () => {
    const disk = store();
    const tracker = new SwarmTracker(disk);
    let reloadedTracker: SwarmTracker | undefined;
    try {
      tracker.consume('s1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sub-1',
        title: 'Invoke research subagent',
        status: 'completed',
        rawInput: { TypeName: 'research', Role: '代码架构调研员', Prompt: '梳理核心模块依赖', Model: 'flash', Workspace: 'inherit' },
        rawOutput: '{"conversationId":"conv-sub-1"}',
      });
      tracker.consume('s1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'msg-1',
        title: 'Message subagent',
        status: 'completed',
        rawInput: { Recipient: 'conv-sub-1', Message: '请补充单元测试覆盖率数据' },
      });
      reloadedTracker = new SwarmTracker(disk);
      const reloaded = reloadedTracker.getState('s1');
      expect(reloaded.workers).toHaveLength(1);
      expect(reloaded.workers[0]).toMatchObject({
        id: 'conv-sub-1',
        name: '代码架构调研员',
        model: 'flash',
        brief: '梳理核心模块依赖',
      });
      expect(reloaded.boardMessages).toHaveLength(1);
    } finally {
      reloadedTracker?.clear();
      tracker.clear();
    }
  });
});

describe('标题与客户端独立存储', () => {
  const session = (id: string, title: string): ManagedSessionSummary => ({ sessionId: id, title, cwd: 'F:\\工作区', rawCwd: 'F:\\工作区', pinned: false, isLegacyApprovalPollution: false, status: 'idle', modelId: '', executionMode: 'default', reasoningEffort: 'high', originKind: 'acp-live', readOnly: false, profileId: 'default', updatedAt: '' });
  it('整理、置顶、重命名可持久化，污染会话跳过，已有结构不重复更新', () => {
    const disk = store(); const organizer = new TitleOrganizer(disk);
    const a = session('a', '请帮我调整主题配色'); const pollution = { ...session('hidden', '旧插件'), isLegacyApprovalPollution: true };
    const selected = organizer.selectTargets([a, pollution]);
    expect(organizer.applyOrganizedTitles(selected.targets, new Map([['a', { organizedTitle: '界面｜调整配色' }]]), { ...selected, modelUsed: 'fixture' }))
      .toMatchObject({ updatedCount: 1, hiddenPollutionCount: 1 });
    expect(organizer.selectTargets([a]).targets).toHaveLength(0);
    expect(organizer.selectTargets([a], { scope: 'session', sessionIds: [] }).targets).toHaveLength(0);
    organizer.togglePin(a); organizer.rename(a, '前端界面｜验证主题切换');
    expect(new TitleOrganizer(disk).apply(a)).toMatchObject({ pinned: true, title: '前端界面｜验证主题切换' });
  });
  it('标题写盘失败不改变内存或已保存的标题，按项目保留路径大小写语义', () => {
    const disk = store();
    const organizer = new TitleOrganizer(disk);
    const a = session('a', '甲');
    organizer.rename(a, '已保存');
    const write = vi.spyOn(disk, 'write').mockImplementationOnce(() => { throw new Error('写入失败'); });
    expect(() => organizer.rename(a, '未保存')).toThrow('写入失败');
    expect(organizer.apply(a).title).toBe('已保存');
    expect(new TitleOrganizer(disk).apply(a).title).toBe('已保存');
    write.mockRestore();
    expect(organizer.selectTargets([{ ...a, cwd: '/Work/A' }, { ...session('b', '乙'), cwd: '/work/a' }],
      { scope: 'project', projectCwd: '/Work/A' }).targets.map(row => row.sessionId)).toEqual(['a']);
  });
  it('存储拒绝官方目录与路径穿越，不读取其中任何文件', () => {
    expect(() => new ClientStore(path.join(tmpdir(), '.gemini', 'qa'))).toThrow('官方');
    expect(() => new ClientStore(path.join(tmpdir(), 'antigravity-cli', 'qa'))).toThrow('官方');
    expect(() => store().write('../outside.json', {})).toThrow('文件名');
  });
});
