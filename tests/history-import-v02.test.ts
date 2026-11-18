// @vitest-environment node
import { promises as fs, appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryImporter } from '../src/main/history/history-importer';
import { createHistoryFixture, snapshotHistoryTree } from './helpers/history-fixture';

const fixtures: ReturnType<typeof createHistoryFixture>[] = [];
const importers: HistoryImporter[] = [];
afterEach(() => { for (const importer of importers.splice(0)) importer.dispose(); vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) rmSync(fixture.directory, { recursive: true, force: true }); });
function setup() {
  const fixture = createHistoryFixture(); fixtures.push(fixture);
  const cacheDir = path.join(fixture.directory, 'gravity-cache');
  const importer = new HistoryImporter({ roots: [fixture.root], cacheDir, debounceMs: 30 }); importers.push(importer);
  return { ...fixture, importer, cacheDir };
}

describe('业务历史导入：诱饵零读取、源树零写入', () => {
  it('JSONL 与 SQLite 导入成功，源目录每一字节/目录项/mtime/ctime/mode 全等', async () => {
    const fixture = setup(); const before = snapshotHistoryTree(fixture.root);
    const read = vi.spyOn(fs, 'readFile'); const write = vi.spyOn(fs, 'writeFile'); const unlink = vi.spyOn(fs, 'unlink');
    const list = await fixture.importer.refresh();
    const readsDuringImport = read.mock.calls.map(([file]) => path.resolve(String(file)));
    const writesDuringImport = [...write.mock.calls, ...unlink.mock.calls].map(([file]) => path.resolve(String(file)));
    read.mockRestore(); write.mockRestore(); unlink.mockRestore();
    expect(list).toHaveLength(2);
    expect(list.every((record) => record.readOnly && record.sessionId.startsWith('ag-history:'))).toBe(true);
    const transcript = list.find((record) => record.sourcePath === fixture.transcript)!;
    expect(fixture.importer.getDetail(transcript.sessionId).messages.map((message) => message.content)).toEqual(['请检查测试项目', '已完成只读检查。']);
    expect(list.find((record) => record.sourcePath === fixture.databasePath)).toMatchObject({ title: '只读历史测试', summarySnippet: '测试合成会话摘要' });
    expect(readsDuringImport.sort()).toEqual([fixture.transcript, fixture.databasePath].sort());
    for (const decoy of fixture.decoys) expect(readsDuringImport).not.toContain(decoy);
    expect(writesDuringImport.every((file) => !file.startsWith(fixture.root + path.sep))).toBe(true);
    expect(snapshotHistoryTree(fixture.root)).toEqual(before);
    expect(fixture.importer.list()).toEqual(list);
  });
  it('纯图片消息、内嵌图片和资源链接在历史中保留', async () => {
    const fixture = setup();
    const image = { mimeType: 'image/png', data: 'AQID' };
    appendFileSync(fixture.transcript, '\n' + [
      { role: 'user', parts: [{ inlineData: image }, { type: 'image', ...image }] },
      { type: 'PLANNER_RESPONSE', step_index: 200, content: [{ type: 'resource_link', uri: 'file:///F:/sample.png' }] },
    ].map(item => JSON.stringify(item)).join('\n'));
    const records = await fixture.importer.refresh();
    const item = records.find(r => r.sourcePath === fixture.transcript)!;
    const [user, assistant] = fixture.importer.getDetail(item.sessionId).messages.slice(-2);
    expect(user.attachments).toHaveLength(1);
    expect(user.attachments![0]).toMatchObject({ dataUrl: 'data:image/png;base64,AQID', sizeBytes: 3 });
    expect(assistant.attachments?.[0].uri).toBe('file:///F:/sample.png');
  });
  it('真实 WAL 新行从客户端快照读入，源库/源wal/源shm保持字节与元数据不变', async () => {
    const fixture = setup(); const writer = new DatabaseSync(fixture.databasePath);
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      writer.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?)').run('wal-002', 'wal-002', 'WAL新增会话', '仅存在于WAL中的已提交摘要', 'F:\\synthetic-history', 'F:\\synthetic-history', '2026-11-17T00:00:02Z');
      const before = snapshotHistoryTree(fixture.root); const read = vi.spyOn(fs, 'readFile');
      const records = await fixture.importer.refresh(); const calls = read.mock.calls.map(([file]) => String(file)); read.mockRestore();
      expect(records.some((record) => record.title === 'WAL新增会话')).toBe(true);
      expect(calls).toContain(`${fixture.databasePath}-wal`);
      expect(calls.some((file) => /-shm$/.test(file))).toBe(false);
      expect(snapshotHistoryTree(fixture.root)).toEqual(before);
    } finally { writer.close(); }
  });
  it('恶意目录/文件名与超限历史内容不会被读取', async () => {
    const fixture = setup(); const bait = path.join(fixture.root, 'brain', 'oauth_token', '.system_generated', 'logs');
    mkdirSync(bait, { recursive: true }); const forbiddenTranscript = path.join(bait, 'transcript.jsonl'); writeFileSync(forbiddenTranscript, '{"role":"user","content":"bait"}');
    const limited = new HistoryImporter({ roots: [fixture.root], cacheDir: fixture.cacheDir, maxFileBytes: 1 }); importers.push(limited);
    const before = snapshotHistoryTree(fixture.root); const read = vi.spyOn(fs, 'readFile');
    expect(await limited.refresh()).toEqual([]);
    expect(read.mock.calls).toEqual([]); read.mockRestore(); expect(snapshotHistoryTree(fixture.root)).toEqual(before);
  });
  it('并发刷新合并为一次扫描，watch启动/停止也保持源树不变', async () => {
    const fixture = setup(); const before = snapshotHistoryTree(fixture.root); const read = vi.spyOn(fs, 'readFile');
    fixture.importer.startWatching(); const [a, b] = await Promise.all([fixture.importer.refresh(), fixture.importer.refresh()]);
    expect(a).toEqual(b); expect(read.mock.calls.filter(([file]) => String(file) === fixture.transcript)).toHaveLength(1);
    read.mockRestore(); fixture.importer.dispose(); expect(snapshotHistoryTree(fixture.root)).toEqual(before);
  });
  it('缓存目录不得位于源目录，getDetail副本不能改写内部记录', async () => {
    const fixture = setup();
    expect(() => new HistoryImporter({ roots: [fixture.root], cacheDir: path.join(fixture.root, 'cache') })).toThrow('独立客户端');
    const records = await fixture.importer.refresh(); const detail = fixture.importer.getDetail(records[0].sessionId);
    detail.messages[0].content = '改动副本'; expect(fixture.importer.getDetail(records[0].sessionId).messages[0].content).not.toBe('改动副本');
  });
  it('真实 Antigravity source/type/created_at 行格式准确映射角色与时间，并剥离 <USER_REQUEST> 与 GENERIC 工具输出', async () => {
    const fixture = setup();
    writeFileSync(fixture.transcript, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-17T01:00:00Z',
        content: '<USER_REQUEST>\n真实结构用户消息\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'GENERIC',
        created_at: '2026-11-17T01:00:00.500Z',
        content: 'Showing lines 1-55 of 55 (工具原始输出不应混入对话气泡)',
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-17T01:00:01Z',
        thinking: '先分析项目结构。',
        content: '真实结构模型回复',
      },
    ].map((record) => JSON.stringify(record)).join('\n'));
    const records = await fixture.importer.refresh(); const transcript = records.find((record) => record.sourcePath === fixture.transcript);
    expect(transcript).toBeTruthy();
    // 自动继承 conversation_summaries.db 中同 conversation_id 的整理标题与 cwd
    expect(transcript!.title).toBe('只读历史测试');
    expect(transcript!.cwd).toBe('F:\\synthetic-history');
    const detail = fixture.importer.getDetail(transcript!.sessionId);
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(detail.messages.map((message) => message.content)).toEqual(['真实结构用户消息', '真实结构模型回复']);
    expect(detail.messages[1].thoughts?.[0]?.originalText).toBe('先分析项目结构。');
    expect(detail.messages[0].createdAt).toBe('2026-11-17T01:00:00.000Z');
  });
  it('WAL头但无旁路文件时仅规范化客户端副本，源库头部保持原样', async () => {
    const fixture = setup(); const bytes = readFileSync(fixture.databasePath); bytes[18] = 2; bytes[19] = 2; writeFileSync(fixture.databasePath, bytes);
    const before = snapshotHistoryTree(fixture.root); const records = await fixture.importer.refresh();
    expect(records.some((record) => record.title === '只读历史测试')).toBe(true);
    expect(snapshotHistoryTree(fixture.root)).toEqual(before);
    expect(readFileSync(fixture.databasePath)[18]).toBe(2);
  });
  it('真实fs.watch在内容变化后防抖刷新，刷新本身不改变源树', async () => {
    const fixture = setup(); await fixture.importer.refresh(); fixture.importer.startWatching();
    let timeout: NodeJS.Timeout | undefined;
    const event = once(fixture.importer, 'updated');
    try {
      // 此处为测试主动编辑自建夹具；仅要求随后业务刷新不得再次写源文件。
      appendFileSync(fixture.transcript, `${JSON.stringify({ role: 'user', content: 'watch增量' })}\n`);
      const beforeRefresh = snapshotHistoryTree(fixture.root);
      const [records] = await Promise.race([event, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('fs.watch未触发刷新')), 3000); })]);
      const record = records.find((item: any) => item.sourcePath === fixture.transcript)!;
      expect(fixture.importer.getDetail(record.sessionId).messages.at(-1)!.content).toBe('watch增量');
      expect(snapshotHistoryTree(fixture.root)).toEqual(beforeRefresh);
    } finally { if (timeout) clearTimeout(timeout); }
  });
});
