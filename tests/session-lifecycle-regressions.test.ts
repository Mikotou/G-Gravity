// @vitest-environment node
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { ClientStore } from '../src/main/storage/client-store';
import { ConversationMessages } from '../src/main/storage/conversation-messages';
import type { AcpConfigOption, AcpRequestPermissionParams, ChatMessageItem } from '../src/shared';
import { isTempExtractionDir, MESSAGE_PAGE_SIZE } from '../src/shared';
import { readAllSessionMessages } from './helpers/core-bridge';

let directory: string;
let core: CoreService | undefined;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'gravity-session-regressions-')); });
afterEach(async () => {
  await core?.dispose();
  core = undefined;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function message(i: number): ChatMessageItem {
  return { id: 'original-' + i, sessionId: 'one', role: i % 2 ? 'assistant' : 'user', content: '历史消息 ' + i, createdAt: '' };
}

function setup(handler?: (method: string, params: any, client: AcpClient) => any) {
  const client = new AcpClient();
  client.initializeResult = { protocolVersion: 1, agentInfo: { name: 'test', version: '1' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } } };
  const connected = vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
  const start = vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
  let count = 0;
  const requests = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    const overridden = handler?.(method, params, client);
    if (overridden !== undefined) return overridden;
    if (method === 'session/new') return { sessionId: 's' + ++count };
    if (method === 'session/prompt') return { stopReason: 'end_turn' };
    return {};
  });
  core = new CoreService({ dataDir: directory, homeDir: path.join(directory, 'fixture-home'), acp: client });
  return { core, client, requests, start, connected };
}

describe('完整历史的迁移、读取与删除', () => {
  it('保存超过 500 条，重启后仅按页读取；游标不受在末尾追加或旧快照写入失败影响', () => {
    const store = new ClientStore(directory);
    const original = Array.from({ length: 564 }, (_, i) => message(i));
    store.write('messages-default.json', { one: original });
    const log = new ConversationMessages(store);
    log.load('default');
    const write = store.write.bind(store);
    const fault = vi.spyOn(store, 'write').mockImplementation((name, data) => {
      if (name === 'message-index-v2-default.json') throw Error('磁盘写入失败');
      write(name, data);
    });
    expect(() => log.save()).toThrow('磁盘');
    expect(store.read<Record<string, ChatMessageItem[]>>('messages-default.json', {}).one).toHaveLength(564);
    fault.mockRestore();
    log.save();
    // An older executable can write an incomplete legacy snapshot when it closes.
    store.write('messages-default.json', {});
    const next = new ConversationMessages(store);
    const read = vi.spyOn(store, 'read');
    next.load('default');
    expect(read.mock.calls.some(([name]) => name.startsWith('messages-page-'))).toBe(false);
    const recent = next.page('one');
    expect(recent.messages).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(recent).toMatchObject({ earlierCount: 500, earlierUserCount: 250, precedingOriginId: 'original-499' });
    expect(read.mock.calls.some(([name]) => name.startsWith('messages-page-'))).toBe(false);
    next.upsert(message(564));
    const previous = next.page('one', recent.earlierCount);
    expect(previous.messages[0].id).toBe('original-436');
    expect(previous.messages.at(-1)?.id).toBe('original-499');
    expect(next.get('one')?.map(m => m.id)).toEqual([...original, message(564)].map(m => m.id));
    store.write('messages-default.json', { one: original.slice(-2), other: [message(20)] });
    store.write('messages.json', { one: original.slice(-1), other: [message(20)] });
    next.delete('one');
    next.save();
    expect(readdirSync(directory).some(name => name.startsWith('messages-page-'))).toBe(false);
    expect(store.read('messages-default.json', {})).toEqual({ other: [message(20)] });
    expect(store.read('messages.json', {})).toEqual({ other: [message(20)] });
    const afterDelete = new ConversationMessages(store);
    afterDelete.load('default');
    expect(afterDelete.get('one')).toBeUndefined();
  });

  it('通过服务端声明的 session/load 找回旧 500 条之前的记录，保留本地原始消息 ID 与附件，重开不重复', async () => {
    const stored = Array.from({ length: 500 }, (_, i) => message(i + 4));
    stored[0].annotations = [{ excerpt: '保留批注' }];
    stored[1].attachments = [{ id: 'saved', name: 'a.txt', sizeBytes: 1, mimeType: 'text/plain', textContent: 'x' }];
    new ClientStore(directory).write('messages-default.json', { one: stored });
    const { core: svc, requests } = setup((method, params, client) => {
      if (method !== 'session/load') return;
      for (let i = 0; i < 504; i++) {
        const m = message(i);
        client.emit('session/update', { sessionId: params.sessionId, update: {
          sessionUpdate: m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: m.content } } });
      }
      return {};
    });
    const upsert = vi.fn();
    svc.on('message-upserted', upsert);
    await svc.resumeSession('one', directory);
    const full = await readAllSessionMessages(svc, 'one');
    expect(full).toHaveLength(504);
    expect(full[0].content).toBe('历史消息 0');
    expect(full[4]).toMatchObject({ id: 'original-4', annotations: stored[0].annotations });
    expect(full[5].attachments).toEqual(stored[1].attachments);
    expect(upsert).not.toHaveBeenCalled();
    await svc.closeSession('one');
    await svc.resumeSession('one', directory);
    expect(requests.mock.calls.filter(([method]) => method === 'session/load')).toHaveLength(1);
    expect(await readAllSessionMessages(svc, 'one')).toHaveLength(504);
  });

  it('单个损坏的分页索引不妨碍其余历史启动，近期消息和不可解读的原记录都保留', async () => {
    const store = new ClientStore(directory);
    const bad = { pages: [{ file: 'invalid', end: { earlierCount: 64 } }], recent: [message(4)] };
    store.write('messages-default.json', { one: bad, other: [{ ...message(20), sessionId: 'other' }] });
    const { core: svc } = setup();
    expect((await svc.getBootstrap()).sessions.map(s => s.sessionId).sort()).toEqual(['one', 'other']);
    expect(await svc.getSessionMessagePage('one')).toMatchObject({ historyIndexUnavailable: true, messages: [{ id: 'original-4' }] });
    expect(await svc.getSessionMessagePage('other')).toMatchObject({ messages: [{ id: 'original-20' }] });
    const checkLog = new ConversationMessages(store);
    checkLog.load('default');
    expect(() => checkLog.get('one')).toThrow('本地副本已保留');
    await svc.dispose(); core = undefined;
    expect(store.read<{ one?: typeof bad }>('message-index-v2-default.json', {}).one?.pages).toEqual(bad.pages);
  });
});

describe('会话能力、配置与失败回滚', () => {
  it('重启和切换账号后按资料显示上次官方模型，但只允许切换到当前会话已声明的型号', async () => {
    const models = (id: string) => ({ sessionId: 'same', models: { currentModelId: id,
      availableModels: [{ modelId: id, name: id }] } });
    const first = setup(method => method === 'session/new' ? models('account-A') : undefined);
    await first.core.createSession({ cwd: directory });
    expect(await first.core.getConnectionStatus()).toMatchObject({ modelListSource: 'live' });
    await first.core.closeSession('same');
    await first.core.dispose();
    const second = setup(method => method === 'session/new' ? models('account-B') : undefined);
    const cached = { modelListSource: 'cached', availableModels: [{ modelId: 'account-A', name: 'account-A' }] };
    expect((await second.core.getBootstrap()).connection).toMatchObject(cached);
    await second.core.resumeSession('same', directory);
    await expect(second.core.sessions.setSessionModel('same', 'account-A')).rejects.toThrow('未声明');
    await second.core.closeSession('same');
    const profile = (await second.core.createAccountProfile({ name: 'Fixture B' })).profiles.find(p => !p.isDefault)!;
    await second.core.switchAccountProfile(profile.profileId);
    expect(await second.core.getConnectionStatus()).toMatchObject({ modelListSource: 'unknown', availableModels: [] });
    await second.core.createSession({ cwd: directory });
    expect((await second.core.getConnectionStatus()).availableModels.map(m => m.modelId)).toEqual(['account-B']);
    await second.core.closeSession('same');
    await second.core.switchAccountProfile('default');
    expect(await second.core.getConnectionStatus()).toMatchObject(cached);
  });

  it('旧资料按最近会话迁移，官方明确返回空清单会覆盖旧模型且重启后保持为空', async () => {
    const store = new ClientStore(directory);
    const old = (id: string, date: string) => ({ sessionId: id, cwd: directory, title: id,
      updatedAt: date, availableModels: [{ modelId: id, name: id }] });
    store.write('owned-sessions-default.json', { earlier: old('earlier', '2026-10-02T02:00:00+08:00'),
      later: old('later', '2026-10-01T23:00:00Z') });
    const { core: svc } = setup(method => method === 'session/new' ? { sessionId: 'fresh',
      configOptions: [{ id: 'model', options: [], currentValue: '', type: 'select', name: 'Model' }],
      models: { currentModelId: 'removed', availableModels: [{ modelId: 'removed', name: 'removed' }] } } : undefined);
    expect((await svc.getConnectionStatus()).availableModels.map(m => m.modelId)).toEqual(['later']);
    await svc.createSession({ cwd: directory });
    expect(await svc.getConnectionStatus()).toMatchObject({ modelListSource: 'live', availableModels: [] });
    await expect(svc.sessions.setSessionModel('fresh', 'removed')).rejects.toThrow('未声明');
    await svc.closeSession('fresh');
    await svc.dispose();
    const after = setup();
    expect(await after.core.getConnectionStatus()).toMatchObject({ modelListSource: 'cached', availableModels: [] });
    after.client.initializeResult!.agentInfo!.version = 'new-cli';
    expect(await after.core.getConnectionStatus()).toMatchObject({ modelListSource: 'unknown', availableModels: [] });
  });

  it('只恢复消失的 Mac 应用转位目录，保留普通临时项目路径', async () => {
    const suffix = '/var/folders/ab/fixture/T/AppTranslocation/ABC-123/d/Gravity.app/Contents/MacOS';
    expect(isTempExtractionDir(suffix)).toBe(true);
    expect(isTempExtractionDir('/private' + suffix)).toBe(true);
    expect(isTempExtractionDir(suffix.split('/Gravity.app')[0])).toBe(true);
    for (const cwd of ['/private/var/folders/ab/fixture/T/design', '/Users/demo/AppTranslocation/project',
      '/var/folders/ab/fixture/T/AppTranslocation/data/project']) expect(isTempExtractionDir(cwd)).toBe(false);
    const store = new ClientStore(directory);
    store.write('owned-sessions-default.json', { old: { cwd: suffix }, project: { cwd: '/var/folders/ab/fixture/T/design' } });
    const { core: svc } = setup();
    expect(svc.sessions.get('old').cwd).toBe(homedir());
    expect(svc.sessions.get('project').cwd).toBe('/var/folders/ab/fixture/T/design');
    const recovered = await svc.sessions.resumeSession('old', suffix);
    expect(recovered).toMatchObject({ cwd: homedir(), rawCwd: homedir() });
  });

  it('更换同一资料的登录身份后，旧会话的模型清单不会在下次启动复活', async () => {
    const first = setup(method => method === 'session/new' ? { sessionId: 'past',
      models: { currentModelId: 'old', availableModels: [{ modelId: 'old', name: 'Old' }] } } : undefined);
    await first.core.createSession({ cwd: directory });
    vi.spyOn(first.client, 'launchOfficialLogin').mockResolvedValue({ launched: true, message: 'ok' });
    await first.core.launchOfficialLogin();
    expect(await first.core.getConnectionStatus()).toMatchObject({ modelListSource: 'unknown', availableModels: [] });
    await first.core.dispose();
    const next = setup();
    expect(await next.core.getConnectionStatus()).toMatchObject({ modelListSource: 'unknown', availableModels: [] });
    expect(next.core.sessions.get('past').title).toBeTruthy();
  });

  it('模型缓存一次写入失败后能继续使用新会话，下一次读取重试保存', async () => {
    const { core: svc } = setup(method => method === 'session/new' ? { sessionId: 'working',
      models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'Model' }] } } : undefined);
    const write = svc.store.write.bind(svc.store);
    let failOnce = true;
    vi.spyOn(svc.store, 'write').mockImplementation((file, value) => {
      if (file === 'model-catalog-default.json' && failOnce) {
        failOnce = false;
        throw Error('temporary disk failure');
      }
      write(file, value);
    });
    expect((await svc.createSession({ cwd: directory })).sessionId).toBe('working');
    expect(await svc.getConnectionStatus()).toMatchObject({ modelListSource: 'live', availableModels: [{ modelId: 'm' }] });
    expect(svc.store.read('model-catalog-default.json', null)).toMatchObject({ models: [{ modelId: 'm' }] });
  });
  it('新建配置失败不留下空对话或展示事件，显式 Temp 工作区正常恢复，进程偏好可在连接时保存', async () => {
    const { core: svc } = setup();
    const emitted = vi.fn();
    svc.on('session-updated', emitted);
    await expect(svc.createSession({ cwd: directory, modelId: 'unknown' })).rejects.toThrow('未声明');
    expect(await svc.listSessions()).toEqual([]);
    expect(emitted).not.toHaveBeenCalled();
    const project = path.join(directory, 'AppData', 'Local', 'Temp', 'real-project');
    mkdirSync(project, { recursive: true });
    const s = await svc.createSession({ cwd: project });
    await svc.closeSession(s.sessionId);
    const reopened = await svc.resumeSession(s.sessionId, project);
    expect(reopened.cwd).toBe(project);
    const options = [...svc.client.options.args!];
    await svc.updatePreferences({ processPerSession: true });
    expect(svc.client.options.args).toEqual(options);
    expect(svc.store.read('preferences.json', {})).toHaveProperty('processPerSession', true);
  });

  it('会话接收提前到达的命令能力，撤销后不再调用，部分旧协议通过本地提示传递努力档位', async () => {
    const { core: svc, requests, client } = setup((method, _params, agent) => {
      if (method !== 'session/new') return;
      agent.emit('session/update', { sessionId: 'one', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } });
      return { sessionId: 'one', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'default' }] } };
    });
    await svc.createSession({ cwd: directory });
    await svc.compactSessionContext('one');
    client.emit('session/update', { sessionId: 'one', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } });
    await expect(svc.compactSessionContext('one')).rejects.toThrow('未声明');
    await svc.setSessionEffort('one', 'xhigh');
    await svc.sendPrompt({ sessionId: 'one', text: 'test' });
    expect(JSON.stringify(requests.mock.calls.at(-1))).toContain('Effort=xhigh');
  });

  it('CFG-01 拒绝空配置回执伪装成功，并在确认配置后恢复/切分支保留已选模式及强度', async () => {
    const cfg = (id: string, currentValue: string, values: string[]): AcpConfigOption => ({
      type: 'select', id, name: id, currentValue, options: values.map(value => ({ value, name: value })),
    });
    const current: Record<string, string> = { model: 'one', mode: 'default', thought_level: 'low' };
    const configOptions = () => [
      cfg('model', current.model, ['one', 'two']),
      cfg('mode', current.mode, ['default', 'plan']),
      cfg('thought_level', current.thought_level, ['low', 'high']),
    ];
    let returnEmptyReceipt = true;
    const { core: svc } = setup((m, params) => {
      if (m === 'session/new' || m === 'session/resume') return { sessionId: 'one', configOptions: configOptions() };
      if (m === 'session/set_config_option') {
        if (returnEmptyReceipt) return undefined;
        const p = params as { configId?: string; value?: string } | undefined;
        if (p?.configId && p.value) current[p.configId] = p.value;
        return { configOptions: configOptions() };
      }
      return undefined;
    });
    await svc.createSession({ cwd: directory });
    // CFG-01：官方未返回 configOptions 回执时不得按请求值伪造本地已生效状态，应保持原值 'one'
    expect((await svc.setSessionModel('one', 'two')).modelId).toBe('one');
    returnEmptyReceipt = false;
    expect((await svc.setSessionModel('one', 'two')).modelId).toBe('two');
    await svc.setSessionMode('one', 'plan');
    const afterEffort = await svc.setSessionEffort('one', 'high');
    expect(afterEffort).toMatchObject({ modelId: 'two', executionMode: 'plan', reasoningEffort: 'high' });
    await svc.closeSession('one');
    expect(await svc.resumeSession('one', directory)).toMatchObject({ executionMode: 'plan', reasoningEffort: 'high' });
  });

  it('离线切分支保留只读状态，分支树删除失败后可完整重试', async () => {
    const { core: svc, start, connected } = setup();
    const s = await svc.createSession({ cwd: directory });
    await svc.sendPrompt({ sessionId: s.sessionId, text: 'first' });
    const [first] = await readAllSessionMessages(svc, s.sessionId);
    const child = await svc.reviseMessage({ sessionId: s.sessionId, messageId: first.id, text: 'second' });
    await vi.waitFor(() => expect(svc.sessions.isBusy(child.sessionId)).toBe(false));
    await svc.closeSession(child.sessionId);
    connected.mockReturnValue(false);
    start.mockRejectedValueOnce(Error('offline'));
    expect((await svc.switchConversationBranch({ sessionId: child.sessionId, targetBranchId: s.sessionId })).session)
      .toMatchObject({ readOnly: true, status: 'closed' });
    const write = svc.store.write.bind(svc.store);
    const fault = vi.spyOn(svc.store, 'write').mockImplementation((name, payload) => {
      if (name.startsWith('pending-session-deletes')) throw Error('disk full');
      write(name, payload);
    });
    await expect(svc.manageSession(s.sessionId, 'delete')).rejects.toThrow('disk full');
    expect((await svc.getConversationTree(s.sessionId)).totalBranches).toBe(2);
    fault.mockRestore();
    const done = await svc.manageSession(s.sessionId, 'delete');
    expect(done.sessions).toHaveLength(0);
  });

  it('离线看历史时清除授权与刷新列表保留当前窗口，重新连接后恢复输入', async () => {
    const { core: svc, client, start, connected } = setup(method => method === 'session/list'
      ? { sessions: [{ sessionId: 's1', cwd: directory, title: '合成会话' }] } : undefined);
    const { sessionId } = await svc.createSession({ cwd: directory });
    await svc.sendPrompt({ sessionId, text: '保留这段历史' });
    await svc.closeSession(sessionId);
    connected.mockReturnValue(false);
    start.mockRejectedValueOnce(Error('offline'));
    const offline = { sessionId, readOnly: true, status: 'closed' };
    expect(await svc.resumeSession(sessionId, directory)).toMatchObject(offline);
    const updates = vi.fn();
    svc.on('session-updated', updates);
    expect(await svc.clearSessionApprovals(sessionId)).toMatchObject(offline);
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining(offline));
    expect((await svc.getSessionMessagePage(sessionId)).messages[0].content).toBe('保留这段历史');
    client.initializeResult!.agentCapabilities.sessionCapabilities!.list = {};
    connected.mockReturnValue(true);
    expect(await svc.listSessions()).toEqual([expect.objectContaining(offline)]);
    expect(svc.store.read<Record<string, { readOnly?: boolean }>>('owned-sessions-default.json', {})[sessionId].readOnly).toBe(false);
    await svc.closeSession(sessionId);
    expect(svc.sessions.get(sessionId).readOnly).toBe(false);
    connected.mockReturnValue(false);
    start.mockRejectedValueOnce(Error('offline'));
    expect(await svc.resumeSession(sessionId, directory)).toMatchObject(offline);
    connected.mockReturnValue(true);
    expect(await svc.resumeSession(sessionId, directory)).toMatchObject({ readOnly: false, status: 'idle' });
  });

  it('在纯手动档记住的前缀跨回合和重连保留，清除后逐条审批，撤销只结束对应卡片', async () => {
    const { core: svc, client } = setup();
    const s = await svc.createSession({ cwd: directory });
    const params: AcpRequestPermissionParams = { sessionId: s.sessionId,
      toolCall: { toolCallId: 'tool', title: 'run_command', kind: 'execute', rawInput: { command: 'npm test' } },
      options: [{ optionId: 'yes', kind: 'allow_once', name: '允许' }] };
    const ask = (id: number) => svc.approval.requestPermission(params, directory, undefined, id);
    const first = ask(1);
    const card = svc.approval.listPending()[0];
    await svc.submitApprovalDecision({ requestId: card.requestId, sessionId: s.sessionId, decision: 'allow_session_prefix', allowedPrefix: card.commandPrefix });
    expect((await first).outcome).toEqual({ outcome: 'selected', optionId: 'yes' });
    svc.sessions.emit('cancelled', s.sessionId);
    expect((await ask(2)).outcome).toEqual({ outcome: 'selected', optionId: 'yes' });
    client.emit('disconnected');
    expect((await ask(3)).outcome).toEqual({ outcome: 'selected', optionId: 'yes' });
    expect((await svc.clearSessionApprovals(s.sessionId)).hasApprovalGrants).toBe(false);
    const pendingA = ask(4), pendingB = ask(5);
    expect(svc.approval.listPending()).toHaveLength(2);
    client.emit('$/cancel_request', { requestId: 4 });
    expect((await pendingA).outcome).toEqual({ outcome: 'cancelled' });
    expect(svc.approval.listPending()).toHaveLength(1);
    client.emit('$/cancel_request', { requestId: 5 });
    await pendingB;
  });

  it('原会话归档、恢复和重开保留授权，编辑分支独立；删除在授权写盘失败后由下次启动完成', async () => {
    const {core: first} = setup();
    const a = await first.createSession({cwd:directory});
    const params: AcpRequestPermissionParams = {
      sessionId: a.sessionId, toolCall: {toolCallId:'sample', title:'run_command', kind:'execute', rawInput:{command:'npm test'}},
      options:[{optionId:'yes', kind:'allow_once', name:'允许一次'}],
    };
    const result = first.approval.requestPermission(params, directory);
    const card = first.approval.listPending()[0];
    await first.submitApprovalDecision({requestId:card.requestId, sessionId:a.sessionId, decision:'allow_session_prefix', allowedPrefix:card.commandPrefix});
    expect((await result).outcome.outcome).toBe('selected');
    const arch = await first.manageSession(a.sessionId, 'archive');
    expect(arch.sessions.find(s=>s.sessionId === a.sessionId)?.hasApprovalGrants).toBe(true);
    await first.manageSession(a.sessionId, 'restore');
    expect((await first.resumeSession(a.sessionId, directory)).hasApprovalGrants).toBe(true);
    await first.sendPrompt({sessionId:a.sessionId, text:'original'});
    const [msg] = await readAllSessionMessages(first, a.sessionId);
    const child = await first.reviseMessage({sessionId:a.sessionId, messageId:msg.id, text:'edited'});
    await vi.waitFor(() => expect(first.sessions.isBusy(child.sessionId)).toBe(false));
    expect(child.hasApprovalGrants).toBe(false);
    expect(first.approval.hasSessionGrants(a.sessionId, directory)).toBe(true);

    const write = first.store.write.bind(first.store);
    const writeSpy = vi.spyOn(first.store, 'write').mockImplementation((name, value) => {
      if (name.startsWith('approval-grants-')) throw new Error('cannot write grants');
      write(name, value);
    });
    await expect(first.manageSession(a.sessionId, 'delete')).rejects.toThrow('cannot write grants');
    expect(first.approval.hasSessionGrants(a.sessionId, directory)).toBe(true);
    // v0.3.6 4 步退出状态机在 checkpoint 阶段不吞写盘异常，拒绝静默丢弃遗留删除任务
    await expect(first.dispose()).rejects.toThrow('cannot write grants');
    expect(first.disposed).toBe(false);
    writeSpy.mockRestore();
    first.telemetry.dispose(false);
    await first.swarm.clear().catch(() => {});
    const {core: next} = setup();
    expect(next.approval.hasSessionGrants(a.sessionId, directory)).toBe(false);
    expect(next.sessions.sessions.has(a.sessionId)).toBe(false);
    expect(next.sessions.sessions.has(child.sessionId)).toBe(false);
  });

  it('切换 Profile 后，即使恢复成同名会话，旧回合的迟到结果也不会结清新回合或写错统计', async () => {
    let oldDone!: (r: unknown) => void, newDone!: (r: unknown) => void;
    const { core: svc } = setup((m, params) => {
      if (m === 'session/new') return { sessionId: 'same' };
      if (m === 'session/prompt') return new Promise(resolve => {
        if (params.prompt[0].text === 'old') oldDone = resolve;
        else newDone = resolve;
      });
    });
    await svc.createSession({ cwd: directory });
    const oldTurn = svc.sendPrompt({ sessionId: 'same', text: 'old' });
    const accounts = await svc.createAccountProfile({ name: '新资料' });
    await svc.switchAccountProfile(accounts.profiles.find(p => !p.isDefault)!.profileId);
    await svc.createSession({ cwd: directory });
    const newTurn = svc.sendPrompt({ sessionId: 'same', text: 'new' });
    oldDone({ stopReason: 'end_turn', usage: { outputTokens: 1234567 } });
    await oldTurn;
    expect(svc.sessions.isBusy('same')).toBe(true);
    expect((await readAllSessionMessages(svc, 'same')).map(m => m.content)).toEqual(['new']);
    expect((await svc.getTelemetryDashboard()).activeSessions.same.costSummary.outputTokens).toBe(0);
    newDone({ stopReason: 'end_turn' });
    await newTurn;
  });
});
