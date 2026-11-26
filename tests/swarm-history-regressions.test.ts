// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { ClientStore } from '../src/main/storage/client-store';
import { SwarmTracker } from '../src/main/swarm/swarm-tracker';
import { SwarmArchive } from '../src/main/swarm/swarm-archive';
import { SWARM_PAGE_SIZE, type AcpSessionUpdatePayload, type SwarmTopologyState } from '../src/shared';

const dirs: string[] = [];
const trackers: SwarmTracker[] = [];
let core: CoreService | undefined;
function makeTracker(store?: ClientStore) {
  const tracker = new SwarmTracker(store);
  trackers.push(tracker);
  return tracker;
}
function disk() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gravity-swarm-history-'));
  dirs.push(dir);
  return new ClientStore(dir);
}
afterEach(async () => {
  for (const tracker of trackers.splice(0)) tracker.clear();
  await core?.dispose();
  core = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tool(
  id: string,
  name: string,
  input: Record<string, unknown>,
  output?: Record<string, unknown>
): AcpSessionUpdatePayload {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    name,
    status: 'completed',
    rawInput: input,
    rawOutput: output,
  };
}
function pages(tracker: SwarmTracker, sid: string) {
  let p = tracker.getState(sid);
  const all = [p];
  while (p.earlier && Object.values(p.earlier).some(Boolean)) {
    p = tracker.getState(sid, p.earlier);
    all.unshift(p);
  }
  return all;
}
describe('完整 Swarm 记录及官方事件', () => {
  it('保留服务单列的被提及成员，合并正文中的名字并跨重启去重', () => {
    const store = disk();
    const tracker = makeTracker(store);
    const post = tool('with-mentions', 'post_message', {
      sender: 'alice', channel: 'main', content: '请 @设计师 和 @设计师 复核', mentions: ['lead', ' @设计师 ', '', 3],
    });
    tracker.consume('s', post);
    tracker.consume('s', post);
    tracker.flush();
    const board = makeTracker(store).getState('s').boardMessages;
    expect(board).toHaveLength(1);
    expect(board[0].mentions).toEqual(['lead', '设计师']);
  });
  it('后续读板补齐同一消息的接收者，已有行和事件保持各一份', () => {
    const tracker = makeTracker();
    const original = { sender: 'alice', channel: 'main', seq: 42, content: 'ready' };
    tracker.consume('s', tool('post', 'post_message', original));
    const before = tracker.getState('s');
    tracker.consume('s', tool('read', 'read_board', {}, { messages: [{ ...original, mentions: ['lead'] }] }));
    const after = tracker.getState('s');
    expect(after.boardMessages).toHaveLength(1);
    expect(after.boardMessages[0]).toMatchObject({ rowId: before.boardMessages[0].rowId, mentions: ['lead'] });
    expect(after.actionTimeline.filter(e => e.eventType === 'board_posted')).toHaveLength(1);
  });
  it('临时保存失败后，读取/关闭前重试，重复完成通知不会重复发信', () => {
    const store = disk(),
      tracker = makeTracker(store);
    const failure = vi.spyOn(SwarmArchive.prototype, 'write').mockImplementationOnce(() => {
      throw Error('synthetic store busy');
    });
    try {
      const post = tool('atomic', 'post_message', { sender: 'worker', content: 'durable' });
      tracker.consume('s', post);
      tracker.flush();
      tracker.consume('s', post);
      expect(makeTracker(store).getState('s').boardMessages.map((item) => item.content)).toEqual([
        'durable',
      ]);
    } finally {
      failure.mockRestore();
    }
  });
  it('重复读取没有序号的消息板，保留同文不同次的发言并识别服务端消息 ID', () => {
    const tracker = makeTracker();
    const list = [
      { sender: 'A', content: 'same' },
      { sender: 'A', content: 'same' },
      { sender: 'B', content: 'status', messageId: 'm-id' },
    ];
    tracker.consume('s', tool('first', 'read_board', {}, { messages: list }));
    tracker.consume('s', tool('second', 'read_board', {}, { messages: list }));
    expect(tracker.getState('s').boardMessages.map((m) => m.content)).toEqual(['same', 'same', 'status']);
    tracker.consume('s', tool('post-again', 'post_message', { sender: 'A', content: 'same' }));
    expect(tracker.getState('s').boardMessages).toHaveLength(4);
  });
  it('按归属合并两个旧文件，多个账号复用的旧会话 ID 不会被迁到任何错误账号', () => {
    const store = disk(),
      old = makeTracker();
    old.consume('s', tool('legacy-1', 'post_message', { sender: 'A', content: 'older' }));
    const earlier = old.getState('s');
    old.consume('s', tool('legacy-2', 'post_message', { sender: 'B', content: 'newer' }));
    const recent = old.getState('s');
    store.write('swarm-states.json', { s: earlier, collision: earlier });
    store.write('swarm-states-default.json', {
      s: { ...recent, boardMessages: recent.boardMessages.slice(-1) },
    });
    store.write('profiles.json', { profiles: [{ profileId: 'second' }] });
    store.write('owned-sessions-default.json', { s: {}, collision: {} });
    store.write('owned-sessions-second.json', { collision: {} });
    const first = makeTracker(store);
    first.setProfile('default', new Set(['s', 'collision']));
    expect(first.getState('s').boardMessages.map((m) => m.content)).toEqual(['older', 'newer']);
    expect(first.getState('collision').boardMessages).toHaveLength(0);
    first.remove('collision');
    store.write('owned-sessions-default.json', { s: {} });
    const second = makeTracker(store);
    second.setProfile('second', new Set(['collision']));
    expect(second.getState('collision').boardMessages).toHaveLength(0);
  });
  it('同名不同身份、普通工具标题、标准返回内容、收件人以及真实停止和失败', () => {
    const t = makeTracker();
    t.consume('s', {
      sessionUpdate: 'tool_call',
      title: 'Read README from swarm',
      kind: 'read',
      toolCallId: 'read',
      status: 'completed',
      rawInput: { path: 'swarm/README' },
    });
    expect(t.getState('s').isActive).toBe(false);
    const t1 = tool('create1', 'invoke_subagent', { Role: 'Reviewer', TypeName: 'research', Prompt: 'first' });
    t.consume('s', { ...t1, status: 'in_progress' });
    t.consume('s', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'create1',
      status: 'completed',
      toolContent: [{ type: 'content', content: { type: 'text', text: '{"conversationId":"child-111"}' } }],
    });
    t.consume(
      's',
      tool(
        'create2',
        'invoke_subagent',
        { Role: 'Reviewer', TypeName: 'research', Prompt: 'second' },
        { workers: [{ id: 'child-222', name: 'Reviewer', brief: 'second' }] }
      )
    );
    t.consume(
      's',
      tool('send', 'send_message', { sender: 'child-111', Recipient: 'child-222', Message: 'Please confirm' })
    );
    t.consume('s', tool('done', 'post_message', { sender: 'child-111', content: '[done] ready' }));
    const before = t.getState('s');
    expect(before.workers.map((w) => [w.id, w.brief, w.kind, w.status])).toEqual([
      ['child-111', 'first', 'subagent', 'completed'],
      ['child-222', 'second', 'subagent', 'working'],
    ]);
    expect(before.workers[1].currentAction).toContain('Please confirm');
    t.consume('s', { ...tool('fail', 'read_board', { sender: 'child-222' }), status: 'in_progress' });
    t.consume('s', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'fail',
      status: 'failed',
      rawOutput: 'board unavailable',
    });
    expect(t.getState('s').workers[1].currentAction).toBeUndefined();
    expect(t.getState('s').actionTimeline.at(-1)?.summaryEn).toContain('board unavailable');
    t.consume('s', tool('stop', 'manage_subagents', { Action: 'kill_all' }));
    expect(t.getState('s').workers.map((w) => w.status)).toEqual(['completed', 'killed']);
    t.consume('s', {
      ...tool('board', 'read_board', {}),
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({ messages: [{ sender: 'A', message: 'status from public content' }] }),
          },
        },
      ],
    });
    expect(t.getState('s').boardMessages.at(-1)?.content).toBe('status from public content');
  });

  it('跨越以前所有上限，空会话和旧包退出都不会覆盖新记录，删除只清当前账号的会话', () => {
    const store = disk(),
      first = makeTracker(store);
    first.setProfile('default');
    const workers = Array.from({ length: 125 }, (_, i) => ({ name: 'worker' + i, id: 'stable' + i }));
    first.consume('old', tool('all', 'swarm', { action: 'add' }, { workers }));
    const notes = Array.from({ length: 526 }, (_, i) => ({
      sender: 'worker0',
      seq: i + 1,
      content: 'note' + i,
    }));
    first.consume('old', tool('board', 'read_board', {}, { messages: notes }));
    for (let i = 0; i < 205; i++) first.getState('empty' + i);
    first.consume('old', tool('last', 'post_message', { sender: 'worker0', content: 'last', channel: 'new' }));
    store.write('swarm-states-default.json', {});
    const reopened = makeTracker(store);
    reopened.setProfile('default');
    const latest = reopened.getState('old');
    expect(latest.workers).toHaveLength(SWARM_PAGE_SIZE);
    expect(latest.boardMessages).toHaveLength(SWARM_PAGE_SIZE);
    expect(latest.stats).toMatchObject({ total: 125, working: 0, completed: 0 });
    const all = pages(reopened, 'old');
    expect(all.flatMap((p) => p.workers.map((w) => w.id))).toEqual(workers.map((w) => w.id));
    expect(all.flatMap((p) => p.boardMessages.map((m) => m.content))).toEqual([
      ...notes.map((n) => n.content),
      'last',
    ]);
    expect(all.flatMap((p) => p.actionTimeline)).toHaveLength(125 + 527);
    const other = makeTracker(store);
    other.setProfile('profile-b');
    other.consume('old', tool('unique', 'swarm', { action: 'add', name: 'other' }));
    reopened.remove('old');
    expect(reopened.getState('old').stats.total).toBe(0);
    expect(other.getState('old').workers.map((w) => w.name)).toEqual(['other']);
  });

  it('旧 JSON 兼容缺损条目、同名真实成员及已推断的完成，迁移中途损坏的会话不阻塞其余会话', () => {
    const store = disk(),
      source = makeTracker();
    source.consume(
      's',
      tool(
        'src-guard',
        'invoke_subagent',
        { Role: 'approval-guard', TypeName: 'my-guard', Prompt: 'Check text', Model: 'my-model' },
        { conversationId: 'real-guard' }
      )
    );
    source.consume('s', tool('src-post', 'post_message', { sender: 'approval-guard', content: 'still working' }));
    const original = source.getState('s');
    const worker = { ...original.workers[0], status: 'completed', resultSummary: '已完成（上次会话归档）' };
    store.write('swarm-states-default.json', {
      s: { ...original, workers: [null, worker] },
      bad: { workers: [null], boardMessages: 42, actionTimeline: [false] },
    });
    let t = makeTracker(store);
    t.setProfile('default');
    expect(t.getState('s').workers[0]).toMatchObject({ id: 'real-guard', status: 'unconfirmed' });
    expect(t.getState('s').boardMessages).toHaveLength(1);
    t.beginReplay('s');
    const post = tool('old-tool', 'post_message', { sender: 'approval-guard', content: 'still working' });
    t.consume('s', post, true);
    t.finishReplay('s');
    expect(t.getState('s').boardMessages).toHaveLength(1);
    t = makeTracker(store);
    t.setProfile('default');
    t.consume('s', post);
    expect(t.getState('s').boardMessages).toHaveLength(1);
    t.remove('s');
    expect(store.read<Record<string, unknown>>('swarm-states-default.json', {}).s).toBeUndefined();
  });

  it('同一次工具跨重启只记一次，在回放恢复失败时丢弃部分内容；新一轮真实发信相同文字仍单独保留', () => {
    const store = disk();
    const t = makeTracker(store);
    t.setProfile('default');
    const a = tool('a', 'post_message', { sender: 'worker', content: 'same' });
    t.consume('s', a);
    const t2 = makeTracker(store);
    t2.setProfile('default');
    t2.beginReplay('s');
    t2.consume('s', a, true);
    t2.consume('s', tool('partial', 'post_message', { sender: 'worker', content: 'partial' }), true);
    t2.discardReplay('s');
    t2.beginReplay('s');
    t2.consume('s', a, true);
    t2.consume('s', tool('second', 'post_message', { sender: 'worker', content: 'same' }), true);
    t2.finishReplay('s');
    expect(t2.getState('s').boardMessages.map((m) => m.content)).toEqual(['same', 'same']);
    expect(t2.getState('s').actionTimeline).toHaveLength(2);
  });

  it('实际 CoreService 以官方 load 补回有正文但无拓扑的历史，同时保持多成员唤醒与失败关闭的状态', async () => {
    const store = disk();
    store.write('messages-default.json', {
      history: [{ id: 'old', role: 'user', sessionId: 'history', content: 'history', createdAt: '2026-01-01' }],
    });
    const client = new AcpClient();
    client.initializeResult = {
      protocolVersion: 1,
      agentInfo: { name: 'fixture', version: '1' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
    };
    vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
    let rejectClose = true;
    const requests = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'session/new') return { sessionId: 'live' };
      if (method === 'session/load')
        client.emit('session/update', {
          sessionId: (params as { sessionId: string }).sessionId,
          update: tool('retro', 'swarm', { action: 'add', name: 'historical' }),
        });
      if (method === 'session/close' && rejectClose) throw Error('close refused');
      return {};
    });
    core = new CoreService({ dataDir: store.dataDir, homeDir: path.join(store.dataDir, 'home'), acp: client });
    await core.resumeSession('history', store.dataDir);
    expect(requests.mock.calls.some(([method]) => method === 'session/load')).toBe(true);
    expect((await core.getSwarmState('history')).workers[0]).toMatchObject({
      name: 'historical',
      status: 'unconfirmed',
    });
    const { sessionId } = await core.createSession({ cwd: store.dataDir });
    core.swarm.consume(sessionId, tool('both', 'swarm', {}, { workers: [{ name: 'One' }, { name: 'Two' }] }));
    client.emit('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'One agent returned' } },
    });
    expect((await core.getSwarmState(sessionId)).stats.completed).toBe(0);
    await expect(core.closeSession(sessionId)).rejects.toThrow('close refused');
    expect((await core.getSwarmState(sessionId)).stats.working).toBe(2);
    core.swarm.consume(sessionId, tool('done', 'post_message', { sender: 'One', content: '[done] yes' }));
    rejectClose = false;
    await core.closeSession(sessionId);
    expect((await core.getSwarmState(sessionId)).workers.map((w) => w.status)).toEqual([
      'completed',
      'unconfirmed',
    ]);
  });
});
