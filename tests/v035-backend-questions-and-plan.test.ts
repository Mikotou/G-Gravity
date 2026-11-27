// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpRequestNotSentError } from '../src/main/acp/acp-client';
import * as submissions from '../src/main/session/question-submission';
import { PlanArtifactReader } from '../src/main/session/plan-artifact-reader';
import * as localSafety from '../src/main/workspace/local-path-safety';
import { CoreService } from '../src/main/core-service';
import { InspectorStore } from '../src/main/session/inspector-store';
import { ClientStore } from '../src/main/storage/client-store';
import { ConversationMessages } from '../src/main/storage/conversation-messages';
import type { AcpSessionUpdatePayload } from '../src/shared/acp-protocol';
import { MESSAGE_PAGE_SIZE, type ChatMessageItem } from '../src/shared/session-contract';
import type { QuestionSubmission } from '../src/shared/user-question';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { try { while (cleanup.length) await cleanup.pop()!(); } finally { vi.restoreAllMocks(); } });
function directory() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gravity-v035-plan-')));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
async function setup(existingDir?: string) {
  const dir = existingDir ?? directory(), cwd = join(dir, 'workspace'), homeDir = join(dir, 'fake-home');
  mkdirSync(cwd, { recursive: true }); mkdirSync(homeDir, { recursive: true });
  const id = 'fixture-session';
  const client = new AcpClient();
  client.initializeResult = { protocolVersion: 1, agentInfo: { name: 'fixture', version: '1' }, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } };
  vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
  vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(client, 'notify').mockImplementation(() => {});
  const handlers = vi.spyOn(client, 'registerRequestHandler');
  const original = deferred<{ stopReason: string }>();
  const prompts: string[] = [];
  let nextError: Error | undefined;
  let load = async () => ({ sessionId: id });
  const update = (payload: AcpSessionUpdatePayload) => client.emit('session/update', { sessionId: id, update: payload });
  vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'session/new') return { sessionId: id };
    if (method === 'session/load' || method === 'session/resume') return load();
    if (method === 'session/prompt') {
      prompts.push((params as { prompt: Array<{ text: string }> }).prompt[0].text);
      if (prompts.length === 1) return original.promise;
      if (nextError) { const error = nextError; nextError = undefined; throw error; }
      return { stopReason: 'end_turn' };
    }
    return {};
  });
  const openTargetHandler = vi.fn(async () => {});
  const core = new CoreService({ dataDir: join(dir, 'client'), homeDir, acp: client, openTargetHandler });
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; await core.dispose(); } };
  cleanup.push(dispose);
  if (existingDir) await core.resumeSession(id, cwd);
  else await core.createSession({ cwd });
  const elicit = handlers.mock.calls.find(([key]) => key === 'elicitation/create')![1];
  const ask = (properties: object, required = Object.keys(properties)) =>
    Promise.resolve(elicit({ mode: 'form', sessionId: id, message: 'Release settings?', requestedSchema: { type: 'object', properties, required } }, 77));
  const rows = () => core.messages.get(id)!;
  const question = () => rows().slice().reverse().find(m => m.question)!;
  const userTurn = () => core.sendPrompt({ sessionId: id, text: 'Make a plan' });
  return { core, client, cwd, dir, homeDir, id, dispose, ask, original, prompts, update, rows, question, userTurn, openTargetHandler,
    failNext: (e: Error) => { nextError = e; }, onLoad: (fn: typeof load) => { load = fn; } };
}
const fields = { release: { type: 'string', title: 'Release channel', oneOf: [
  { const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' },
] }, notes: { type: 'string', title: 'Release notes' } };
const submit = (id: string, messageId: string): QuestionSubmission => ({
  sessionId: id, messageId, submissionId: 'unique-intent', action: 'accept', delivery: 'followup',
  values: { release: 'a' }, optionEdits: { release: { a: 'Preview' } }, customAnswers: { notes: 'Manual verification' },
});

describe('elicitation receipts and durable visible delivery', () => {
  it('preserves false/zero, validates email/uri/date, and settles every split segment at the same turn boundary', async () => {
    const f = await setup();
    const turn = f.userTurn();
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before' } });
    const rpc = f.ask({ enabled: { type: 'boolean' }, count: { type: 'integer' }, site: { type: 'string', format: 'uri' },
      when: { type: 'string', format: 'date' }, email: { type: 'string', format: 'email' } });
    expect(f.question().question).toMatchObject({ state: 'open', submissionVersion: 2 });
    const input: QuestionSubmission = { action: 'accept', delivery: 'form', sessionId: f.id, messageId: f.question().id, submissionId: 'native',
      values: { enabled: false, count: 0, site: 'https://example.invalid/docs', when: '2024-02-29', email: 'a@example.invalid' } };
    for (const bad of [{ when: '2023-02-29' }, { email: 'x@' }, { site: 'a local path' }]) {
      await expect(f.core.answerQuestion({ ...input, values: Object.assign({}, input.values, bad) })).rejects.toThrow();
      expect(f.question().question?.state).toBe('open');
    }
    const receipt = { mode: 'form', submissionId: 'native' };
    expect(await Promise.all([f.core.answerQuestion(input), f.core.answerQuestion(input)])).toEqual([receipt, receipt]);
    expect(await rpc).toEqual({ action: 'accept', content: input.values });
    await expect(f.core.answerQuestion({ ...input, values: { ...input.values, count: 1 } })).rejects.toThrow(/不一致/);
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'After' } });
    expect(f.rows().filter(m => m.role === 'assistant').every(m => !m.turnSettledAt)).toBe(true);
    f.original.resolve({ stopReason: 'end_turn' });
    await turn;
    const replies = f.rows().filter(m => m.role === 'assistant');
    expect(replies).toHaveLength(3);
    expect(replies.every(m => m.turnStartedAt && m.turnSettledAt && m.turnSettledAt >= m.turnStartedAt)).toBe(true);
    expect(new Set(replies.map(m => m.turnStartedAt)).size).toBe(1);
    expect(new Set(replies.map(m => m.turnSettledAt)).size).toBe(1);
    expect(f.prompts).toHaveLength(1);
  });

  it('checks every follow-up field and rejects malformed or oversized form values before computing a signature', async () => {
    const f = await setup(), turn = f.userTurn();
    const rpc = f.ask({ ...fields, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 2 }, count: { type: 'integer', minimum: 0, maximum: 5 },
      when: { type: 'string', format: 'date' }, enabled: { type: 'boolean' } });
    const input = { ...submit(f.id, f.question().id), values: { release: 'a', tags: ['a'], count: 0, when: '2024-02-29', enabled: false } };
    const sign = vi.spyOn(submissions, 'submissionSignature');
    const invalid: Partial<QuestionSubmission>[] = [{ customAnswers: { notes: ' ' } }, { customAnswers: {}, customReply: 'one generic answer' },
      { customAnswers: {}, values: { ...input.values, notes: '' } },
      ...[{ release: 'unlisted' }, { tags: ['x'] }, { tags: ['a', 'a'] }, { tags: [] }, { count: 6 }, { count: '3' }, { when: '2024-02-30' }, { enabled: 1 }]
        .map(values => ({ values: Object.assign({}, input.values, values) }))];
    for (const patch of invalid) {
      await expect(f.core.answerQuestion({ ...input, ...patch })).rejects.toThrow();
    }
    expect(sign).not.toHaveBeenCalled();
    expect(f.question().question?.state).toBe('open');
    await f.core.answerQuestion(input);
    expect(await rpc).toEqual({ action: 'decline' });
    f.original.resolve({ stopReason: 'end_turn' }); await turn;

    const form = f.ask({ text: { type: 'string' } });
    const native: QuestionSubmission = { sessionId: f.id, messageId: f.question().id, delivery: 'form', action: 'accept' };
    const exact = '界'.repeat(333_329) + 'ab';
    expect(Buffer.byteLength(JSON.stringify({ text: exact }))).toBe(1_000_000);
    sign.mockClear();
    const cyclic: Record<string, unknown> = {}; cyclic.text = cyclic;
    for (const values of [{ text: exact + 'x' }, { text: '\n'.repeat(500_000) }, cyclic]) {
      await expect(f.core.answerQuestion({ ...native, values: values as QuestionSubmission['values'] })).rejects.toThrow();
    }
    expect(sign).not.toHaveBeenCalled();
    await f.core.answerQuestion({ ...native, values: { text: exact } });
    expect(await form).toEqual({ action: 'accept', content: { text: exact } });
  });

  it('commits the receipt and exactly one user message before declining, then reports sent to duplicate callers', async () => {
    const f = await setup();
    const turn = f.userTurn(), rpc = f.ask(fields);
    const input = submit(f.id, f.question().id);
    const failedSave = vi.spyOn(f.core.store, 'write').mockImplementationOnce(() => { throw Error('disk busy'); });
    await expect(f.core.answerQuestion(input)).rejects.toThrow('disk busy');
    failedSave.mockRestore();
    expect(f.rows().filter(m => m.role === 'user')).toHaveLength(1);
    expect(f.question().question?.state).toBe('open');
    f.core.once('message-upserted', () => { throw Error('display disconnected after commit'); });
    const [a, b] = await Promise.all([f.core.answerQuestion(input), f.core.answerQuestion(input)]);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ mode: 'followup', followupState: 'queued' });
    expect(await rpc).toEqual({ action: 'decline' });
    const persisted = readFileSync(join(f.core.store.dataDir, 'message-index-v2-default.json'), 'utf8');
    expect(JSON.parse(persisted)[f.id].recent.find((m: ChatMessageItem) => m.id === a.followupMessageId).questionFollowup.state).toBe('queued');
    const reopened = new ConversationMessages(f.core.store);
    reopened.load('default');
    expect(reopened.findMessage(f.id, a.followupMessageId!)?.questionFollowup?.state).toBe('failed-unsent');
    f.original.resolve({ stopReason: 'end_turn' }); await turn;
    expect(f.prompts).toHaveLength(2);
    for (const text of ['Release settings?', 'Release channel', 'Alpha', 'Beta', 'Preview', 'Release notes', 'Manual verification']) expect(f.prompts[1]).toContain(text);
    expect(f.rows().filter(m => m.id === a.followupMessageId)).toHaveLength(1);
    expect(await f.core.answerQuestion(input)).toMatchObject({ ...a, followupState: 'sent' });
    await expect(f.core.answerQuestion({ ...input, retryUnsentFollowup: true })).rejects.toThrow();
    await expect(f.core.answerQuestion({ ...input, customAnswers: { notes: 'other' } })).rejects.toThrow(/不一致/);
  });

  it.each(['parent-error', 'cancel', 'server-cancel', 'before-write', 'after-write'] as const)('classifies %s and permits only a provably unsent manual retry', async failure => {
    const f = await setup();
    const turn = f.userTurn().catch(() => {});
    const rpc = f.ask(fields);
    const input = submit(f.id, f.question().id);
    const first = await f.core.answerQuestion(input);
    expect(await rpc).toEqual({ action: 'decline' });
    if (failure === 'cancel') await f.core.cancelPrompt(f.id);
    if (failure === 'before-write') f.failNext(new AcpRequestNotSentError('pre-write'));
    if (failure === 'after-write') f.failNext(new Error('transport lost after write'));
    if (failure === 'parent-error') f.original.reject(new Error('parent RPC failed'));
    else f.original.resolve({ stopReason: failure === 'cancel' || failure === 'server-cancel' ? 'cancelled' : 'end_turn' });
    await turn;
    const state = failure === 'after-write' ? 'unknown' : 'failed-unsent';
    const count = f.prompts.length;
    expect(f.rows().find(m => m.id === first.followupMessageId)?.questionFollowup?.state).toBe(state);
    expect((await f.core.answerQuestion(input)).followupState).toBe(state);
    expect(f.prompts).toHaveLength(count);
    const retry = { ...input, retryUnsentFollowup: true };
    if (state === 'unknown') {
      await expect(f.core.answerQuestion(retry)).rejects.toThrow();
      expect(f.prompts).toHaveLength(count);
    } else {
      await expect(f.core.answerQuestion({ ...retry, values: { release: 'b' } })).rejects.toThrow();
      expect(await f.core.answerQuestion(retry)).toMatchObject({ followupMessageId: first.followupMessageId, followupState: 'queued' });
      await vi.waitFor(() => expect(f.question().questionFollowup?.state).toBe('sent'));
      expect(f.prompts).toHaveLength(count + 1);
      expect(f.rows().filter(m => m.id === first.followupMessageId)).toHaveLength(1);
    }
  });

  it('reopens a paged failed-unsent receipt, checks the profile and retries the same archived user message exactly once', async () => {
    const f = await setup();
    const turn = f.userTurn().catch(() => {}), rpc = f.ask(fields);
    const input = submit(f.id, f.question().id), receipt = await f.core.answerQuestion(input);
    expect(await rpc).toEqual({ action: 'decline' });
    f.original.reject(new Error('parent failed')); await turn;
    for (let i = 0; i < 2 * MESSAGE_PAGE_SIZE; i++) {
      f.core.messages.upsert({ sessionId: f.id, id: 'page-' + i, createdAt: '', role: 'user', content: 'later' });
    }
    f.core.messages.save();
    expect(f.core.messages.recent(f.id).some(m => m.id === receipt.followupMessageId)).toBe(false);
    await f.dispose();
    const reopened = await setup(f.dir);
    const other = vi.spyOn(reopened.core.accounts, 'activeProfileId', 'get').mockReturnValue('other');
    await expect(reopened.core.answerQuestion(input)).rejects.toThrow();
    other.mockRestore();
    expect(await reopened.core.answerQuestion(input)).toMatchObject({ ...receipt, followupState: 'failed-unsent' });
    await reopened.core.answerQuestion({ action: 'accept', sessionId: input.sessionId, messageId: input.messageId,
      submissionId: input.submissionId, retryUnsentFollowup: true });
    await vi.waitFor(() => expect(reopened.prompts).toHaveLength(1));
    expect((await reopened.core.answerQuestion(input)).followupState).toBe('sending');
    const cold = new ConversationMessages(reopened.core.store); cold.load('default');
    expect(cold.findMessage(f.id, receipt.followupMessageId!)?.questionFollowup?.state).toBe('unknown');
    reopened.original.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(async () => expect((await reopened.core.answerQuestion(input)).followupState).toBe('sent'));
    expect(reopened.rows().filter(m => m.id === receipt.followupMessageId)).toHaveLength(1);
    expect(reopened.prompts).toHaveLength(1);
  });

  it('recovers an interrupted sending record as unknown and never queues it at startup', () => {
    const store = new ClientStore(directory());
    const m: ChatMessageItem = { id: 'u', sessionId: 'id', role: 'user', content: 'followup', createdAt: '',
      questionFollowup: { submissionId: 'intent', questionMessageId: 'q', state: 'sending' } };
    store.write('messages-default.json', { id: [m] });
    const messages = new ConversationMessages(store); messages.load('default');
    expect(messages.findMessage('id', 'u')?.questionFollowup?.state).toBe('unknown');
    messages.save();
    expect(store.read<Record<string, { recent: ChatMessageItem[] }>>('message-index-v2-default.json', {}).id.recent[0].questionFollowup?.state).toBe('unknown');
  });
});

describe('authoritative inspector and replay', () => {
  it('retires activity after a failed settlement, session release and profile release', async () => {
    const f = await setup();
    const stream = f.core['turns'], activity = stream['activity'];
    const row = (sessionId: string, id: string): ChatMessageItem => ({ sessionId, id, role: 'assistant', content: '', createdAt: '' });
    const orphan = row(f.id, 'orphan'), publish = vi.fn();
    activity.begin(f.id); activity.stamp(orphan); f.core.messages.upsert(orphan);
    const fail = vi.spyOn(f.core.messages, 'commitInteraction').mockImplementationOnce(() => { throw Error('disk unavailable'); });
    expect(() => activity.settle(f.id, f.core.messages, publish)).toThrow('disk unavailable');
    fail.mockRestore();
    const next = row(f.id, 'fresh'); activity.stamp(next);
    expect(next.turnStartedAt).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    expect(orphan.turnSettledAt).toBeUndefined();
    activity.begin(f.id);
    vi.spyOn(f.core.telemetry, 'cancelManualCompaction').mockImplementationOnce(() => { throw Error('release failed'); });
    expect(() => stream.releaseSession(f.id)).toThrow('release failed');
    activity.stamp(next); expect(next.turnStartedAt).toBeUndefined();
    const unrelated = row('unlisted', 'new-profile');
    activity.begin(unrelated.sessionId); stream.releaseProfile(); activity.stamp(unrelated);
    expect(unrelated.turnStartedAt).toBeUndefined();
  });
  it('counts all entries, retains six statuses and 64 Unicode code points, and retains evicted disk snapshots', () => {
    const dir = directory(), disk = new ClientStore(dir);
    const inspector = new InspectorStore(disk, 'default');
    const statuses = ['pending', 'in_progress', 'done', 'skipped', 'failed', '🐈'.repeat(70)];
    const entries = Array.from({ length: 126 }, (_, i) => ({ content: 'entry ' + i, status: statuses[i % 6] }));
    const update = (id: string, value: unknown) => inspector.consume(id, { sessionUpdate: 'plan', entries: value as AcpSessionUpdatePayload['entries'] });
    expect(inspector.get('a').plan).toMatchObject({ state: 'unreceived', revision: 0 });
    expect(update('a', [])).toEqual([]);
    expect(inspector.get('a').plan).toMatchObject({ state: 'empty', revision: 1 });
    const todos = update('a', entries)!;
    expect(todos.slice(0, 6).map(x => x.status)).toEqual(['pending', 'in_progress', 'completed', 'skipped', 'failed', 'unknown']);
    expect(todos[5].rawStatus).toBe('🐈'.repeat(64));
    expect(todos).toHaveLength(100);
    const state = inspector.get('a');
    expect(state.plan).toEqual({ state: 'present', revision: 2, truncated: true, totalCount: 126, completedCount: 21, failedCount: 21 });
    for (const bad of [null, {}, [null], [{ content: 3 }]]) expect(update('a', bad)).toBeUndefined();
    expect(inspector.get('a')).toEqual(state);
    for (let i = 0; i < 204; i++) update('cold-' + i, []);
    expect(inspector.get('a')).toEqual(state);
    inspector.flush();
    expect(new InspectorStore(new ClientStore(dir), 'default').get('a')).toEqual(state);
    expect(new InspectorStore(disk, 'other').get('a').plan?.state).toBe('unreceived');
  });

  it('requests session/load for a missing local plan and buffers late notifications until replay storage finishes', async () => {
    const f = await setup();
    await f.core.closeSession(f.id);
    f.core.messages.set(f.id, [{ id: 'saved', sessionId: f.id, role: 'user', content: 'previous turn', createdAt: '' }]);
    f.client.initializeResult!.agentCapabilities.sessionCapabilities!.resume = {};
    vi.spyOn(f.core.swarm, 'needsReplay').mockResolvedValue(false);
    const finish = f.core.swarm.finishReplay.bind(f.core.swarm);
    vi.spyOn(f.core.swarm, 'finishReplay').mockImplementation(async id => {
      await finish(id);
      expect(f.core.sessions.isResuming(f.id)).toBe(false);
      f.update({ sessionUpdate: 'plan', entries: [{ content: 'authoritative' }, { content: 'second' }] });
      f.update({ sessionUpdate: 'usage_update', usage: { totalTokens: 123 } });
      expect(f.core.inspector.get(f.id).plan?.state).toBe('unreceived');
    });
    f.onLoad(async () => { f.update({ sessionUpdate: 'plan', entries: [{ content: 'first' }] }); return { sessionId: f.id }; });
    const usage = vi.spyOn(f.core.telemetry, 'applyUsage'), guard = vi.spyOn(f.core.approval, 'enableBurstGuard');
    await f.core.resumeSession(f.id, f.cwd);
    expect(vi.mocked(f.client.request).mock.calls.some(([method]) => method === 'session/load')).toBe(true);
    expect(f.core.inspector.get(f.id).todos.map(t => t.content)).toEqual(['authoritative', 'second']);
    expect(f.rows().map(m => m.id)).toEqual(['saved']);
    expect(usage).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure', 'disconnect'] as const)('buffers only valid plans for the owning resume generation on %s', async outcome => {
    const f = await setup();
    await f.core.closeSession(f.id);
    f.core.messages.set(f.id, [{ sessionId: f.id, id: 'old', role: 'user', content: 'local history', createdAt: '' }]);
    f.core.messages.save();
    f.core.inspector.consume(f.id, { sessionUpdate: 'plan', entries: [{ content: 'old' }] });
    const burst = vi.spyOn(f.core.approval, 'enableBurstGuard'), usage = vi.spyOn(f.core.telemetry, 'applyUsage');
    f.onLoad(async () => {
      f.update({ sessionUpdate: 'plan', entries: [{ content: 'intermediate' }] });
      f.update({ sessionUpdate: 'plan', entries: [{ content: 'last', status: 'completed' }, { content: 'next' }] });
      f.update({ sessionUpdate: 'plan' });
      f.update({ sessionUpdate: 'usage_update', usage: { totalTokens: 999 } });
      expect(f.core.inspector.get(f.id).todos[0].content).toBe('old');
      if (outcome === 'disconnect') f.client.emit('disconnected', 'closed');
      if (outcome !== 'success') throw new Error('resume interrupted');
      return { sessionId: f.id };
    });
    if (outcome === 'success') await f.core.resumeSession(f.id, f.cwd);
    else await expect(f.core.resumeSession(f.id, f.cwd)).rejects.toThrow();
    expect(f.core.inspector.get(f.id).todos[0].content).toBe(outcome === 'success' ? 'last' : 'old');
    expect(f.rows().map(m => m.id)).toEqual(['old']);
    expect(burst).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
  });
});

describe('read-only session plan artifacts', () => {
  it('resolves a referenced workspace file, observes edits, verifies revisions on open and rejects stale/foreign owners', async () => {
    const f = await setup(), owner = { profileId: 'default', sessionId: f.id };
    const file = join(f.cwd, 'implementation_plan.md');
    writeFileSync(file, 'first');
    expect((await f.core.getSessionPlanArtifact(owner)).status).toBe('missing');
    f.core.messages.set(f.id, [{ id: 'ref', sessionId: f.id, role: 'user', createdAt: '', content: '',
      references: [{ kind: 'file', label: 'plan', value: 'implementation_plan.md' }] }]);
    const changed = vi.fn(); f.core.on('plan-artifact-changed', changed);
    const ready = await f.core.getSessionPlanArtifact(owner);
    expect(ready).toMatchObject({ status: 'ready', source: 'workspace-reference', content: 'first', filePath: file });
    await expect(f.core.openLinkOrFileTarget({ action: 'default-app', target: 'file://%ZZ', planArtifactOwner: owner }))
      .rejects.toThrow(/无效.*文件.*URL/);
    expect(f.openTargetHandler).not.toHaveBeenCalled();
    const reads = vi.spyOn(localSafety, 'readBoundedLocalFile');
    expect(await f.core.getSessionPlanArtifact({ ...owner, knownRevision: ready.revision })).toEqual({ owner, revision: ready.revision, status: 'unchanged' });
    expect(reads).not.toHaveBeenCalled();
    expect((await f.core.getSessionPlanArtifact(owner)).content).toBe('first');
    expect(reads).toHaveBeenCalledTimes(1);
    const open = { action: 'default-app' as const, target: file, planArtifactOwner: { ...owner, revision: ready.revision } };
    await f.core.openLinkOrFileTarget(open);
    expect(f.openTargetHandler).toHaveBeenCalledTimes(1);
    writeFileSync(file, 'other');
    await vi.waitFor(() => expect(changed.mock.calls.some(([e]) => e.revision > ready.revision)).toBe(true));
    await expect(f.core.openLinkOrFileTarget(open)).rejects.toThrow();
    for (const bad of [{ ...owner, profileId: 'foreign' }, { ...owner, sessionId: '../escape' }, { ...owner, sessionId: 'foreign' }]) {
      expect((await f.core.getSessionPlanArtifact(bad)).status).toBe('unavailable');
      await expect(f.core.openLinkOrFileTarget({ ...open, planArtifactOwner: bad })).rejects.toThrow();
    }
    await expect(f.core.openLinkOrFileTarget({ ...open, target: join(f.cwd, 'other.exe'), planArtifactOwner: owner })).rejects.toThrow();
    expect(f.openTargetHandler).toHaveBeenCalledTimes(1);
  });

  it('emits the first artifact event for an explicit plain-text reference before any inspector read', async () => {
    const f = await setup(), owner = { profileId: 'default', sessionId: f.id };
    const subdir = join(f.cwd, 'project'); mkdirSync(subdir);
    writeFileSync(join(subdir, 'implementation_plan.md'), 'from this session');
    const event = vi.fn(); f.core.on('plan-artifact-changed', event);
    const turn = f.userTurn();
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'See project/implementation_plan.md.' } });
    f.original.resolve({ stopReason: 'end_turn' }); await turn;
    await vi.waitFor(() => expect(event).toHaveBeenCalled());
    expect(event.mock.calls[0][0]).toMatchObject(owner);
    expect(await f.core.getSessionPlanArtifact(owner)).toMatchObject({ content: 'from this session', source: 'workspace-reference' });
  });

  it('requires explicit plan labels for renamed artifacts and preserves executable reveal and credential guards', async () => {
    const f = await setup(), owner = { profileId: 'default', sessionId: f.id };
    const target = join(f.cwd, 'release checklist.cmd'); writeFileSync(target, 'Review release notes');
    const name = 'release%20checklist.cmd';
    const set = (content: string) => f.core.messages.set(f.id, [{ id: 'ref', sessionId: f.id, role: 'assistant', createdAt: '', content }]);
    set('[release notes](' + name + ')');
    expect((await f.core.getSessionPlanArtifact(owner)).status).toBe('missing');
    set('[Implementation plan](' + name + ')');
    const ready = await f.core.getSessionPlanArtifact(owner);
    expect(ready).toMatchObject({ status: 'ready', filePath: target, content: 'Review release notes' });
    expect(await f.core.openLinkOrFileTarget({ action: 'default-app', target, planArtifactOwner: { ...owner, revision: ready.revision } }))
      .toMatchObject({ modeUsed: 'reveal-in-folder' });
    mkdirSync(join(f.cwd, '.git')); writeFileSync(join(f.cwd, '.git', 'config'), 'private state');
    set('[实施计划](.git/config)');
    expect((await f.core.getSessionPlanArtifact(owner)).content).toBeUndefined();
    set('[实施计划](.env)');
    expect((await f.core.getSessionPlanArtifact(owner)).content).toBeUndefined();
  });

  it('enforces the UTF-8 byte limit and regular-file boundaries in the owned brain and rejects a redirected ancestor', async () => {
    const f = await setup(), owner = { profileId: 'default', sessionId: f.id };
    const root = join(f.homeDir, '.gemini', 'antigravity-cli', 'brain', f.id);
    mkdirSync(root, { recursive: true });
    const path = join(root, 'implementation_plan.md');
    const bytes = Buffer.alloc(131072, 65);
    writeFileSync(path, bytes);
    expect(await f.core.getSessionPlanArtifact(owner)).toMatchObject({ status: 'ready', source: 'brain-artifact', content: bytes.toString() });
    await f.core.openLinkOrFileTarget({ action: 'default-app', target: path, planArtifactOwner: owner });
    expect(f.openTargetHandler).toHaveBeenCalledWith(path, 'default-app', false);
    await expect(f.core.openLinkOrFileTarget({ action: 'default-app', target: path, sessionId: f.id })).rejects.toThrow();
    expect(readFileSync(path)).toEqual(bytes);
    for (const invalid of [Buffer.alloc(131073), Buffer.from([0xff, 0xfe]), Buffer.from([65, 0, 66])]) {
      writeFileSync(path, invalid);
      expect((await f.core.getSessionPlanArtifact(owner)).status).toBe('unavailable');
    }
    rmSync(path); mkdirSync(path);
    expect((await f.core.getSessionPlanArtifact(owner)).status).toBe('unavailable');
    rmSync(root, { recursive: true, force: true });
    writeFileSync(join(f.cwd, 'implementation_plan.md'), 'foreign');
    symlinkSync(f.cwd, root, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await f.core.getSessionPlanArtifact(owner)).status).toBe('unavailable');
    expect(existsSync(join(f.homeDir, '.gemini', 'settings.json'))).toBe(false);
  });

  it('preserves revisions across 210 sessions and returns first-read errors with revision zero', async () => {
    const dir = directory(), generation = {};
    const file = join(dir, 'implementation_plan.md');
    writeFileSync(file, 'first');
    const reader = new PlanArtifactReader(owner => ({ cwd: dir, homeDir: join(dir, 'absent'), generation,
      references: () => owner.sessionId === 's0' || owner.sessionId === 'invalid' ? [file] : [] }), vi.fn());
    cleanup.push(() => reader.clear());
    const owner = { profileId: 'default', sessionId: 's0' };
    const ready = await reader.get(owner);
    expect(ready.status).toBe('ready');
    for (let i = 1; i <= 210; i++) {
      expect((await reader.get({ ...owner, sessionId: 's' + i, knownRevision: 0 })).status).toBe('missing');
    }
    expect(await reader.get({ ...owner, knownRevision: ready.revision })).toEqual({ owner, status: 'unchanged', revision: ready.revision });
    writeFileSync(file, Buffer.from([0xff]));
    expect(await reader.get({ ...owner, sessionId: 'invalid', knownRevision: 0 })).toMatchObject({ status: 'unavailable', revision: 0 });
  });

  it('verifies alternate filesystem spellings for both a referenced plan and its owner-bound opener', async () => {
    const f = await setup(), owner = { profileId: 'default', sessionId: f.id };
    const dir = join(f.cwd, 'Long Plan Directory');
    mkdirSync(dir);
    const file = join(dir, 'implementation_plan.md');
    writeFileSync(file, 'same document');
    const spellings = [file, join(f.cwd, 'LONG PLAN DIRECTORY', 'implementation_plan.md')];
    if (process.platform === 'win32') {
      const result = spawnSync('cmd.exe', ['/d', '/c', 'for %I in ("%GRAVITY_TEST_PLAN_FILE%") do @echo %~sI'], {
        env: { ...process.env, GRAVITY_TEST_PLAN_FILE: file }, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
      });
      expect(result.status).toBe(0);
      const short = result.stdout.trim();
      expect(existsSync(short)).toBe(true);
      spellings.push(short);
    }
    for (const path of spellings) {
      f.core.messages.set(f.id, [{ id: 'ref', sessionId: f.id, role: 'assistant', createdAt: '', content: '',
        references: [{ kind: 'file', label: 'Implementation plan', value: path }] }]);
      const snapshot = await f.core.getSessionPlanArtifact(owner);
      if (!existsSync(path)) { expect(snapshot.status).toBe('missing'); continue; }
      expect(snapshot).toMatchObject({ status: 'ready', content: 'same document' });
      expect(await f.core.openLinkOrFileTarget({ action: 'default-app', target: path, planArtifactOwner: owner }))
        .toMatchObject({ modeUsed: 'default-app', resolvedTarget: snapshot.filePath });
    }
  });

  it('uses the tail on notifications, indexes archived references on demand and tolerates an unreadable index', async () => {
    const f = await setup(), owner = { sessionId: f.id, profileId: 'default' };
    const file = join(f.cwd, 'implementation_plan.md');
    writeFileSync(file, 'archived');
    const ref: ChatMessageItem = { id: 'ref', sessionId: f.id, role: 'assistant', createdAt: '', content: '[plan](implementation_plan.md#step)' };
    f.core.messages.set(f.id, [ref, ...Array.from({ length: 3 * MESSAGE_PAGE_SIZE }, (_, i) => ({ ...ref, id: 'm' + i, content: '' }))]);
    f.core.messages.save(); f.core.messages.load('default');
    const scan = vi.spyOn(f.core.messages, 'get').mockImplementation(() => { throw Error('full scan'); });
    const search = vi.spyOn(f.core.messages, 'planReferences');
    const disk = vi.spyOn(f.core.store, 'read');
    const notify = () => f.core.emit('message-upserted', { sessionId: f.id, message: { ...ref, content: '', todos: [] } });
    notify(); await vi.waitFor(() => expect(search).toHaveBeenCalledWith(f.id, false));
    const pageReads = () => disk.mock.calls.filter(([file]) => file.startsWith('messages-page-')).length;
    expect(pageReads()).toBe(0);
    const ready = await f.core.getSessionPlanArtifact(owner);
    expect(ready).toMatchObject({ status: 'ready', content: 'archived' });
    const coldReads = pageReads(); expect(coldReads).toBeGreaterThan(0);
    f.core.messages.commitInteraction(f.id, [{ ...ref, content: 'See implementation_plan.md#step.' }]);
    search.mockClear(); notify(); await vi.waitFor(() => expect(search).toHaveBeenCalledWith(f.id, false));
    expect((await f.core.getSessionPlanArtifact({ ...owner, knownRevision: ready.revision })).status).toBe('unchanged');
    expect(pageReads()).toBe(coldReads);
    f.core.store.write('message-index-v2-default.json', { [f.id]: { pages: [{ file: 'invalid-index' }], recent: [ref] } });
    f.core.messages.load('default');
    expect(await f.core.getSessionPlanArtifact(owner)).toMatchObject({ status: 'ready', content: 'archived' });
    expect(scan).not.toHaveBeenCalled(); scan.mockRestore();
  });

  it('bounds the preview and validates the entire file, including split UTF-8 and binary tails', async () => {
    const f = await setup(), owner = { sessionId: f.id, profileId: 'default' };
    const file = join(f.cwd, 'implementation_plan.md');
    f.core.messages.set(f.id, [{ id: 'ref', sessionId: f.id, role: 'assistant', createdAt: '',
      content: '[plan](implementation_plan.md?view=source#milestone)' }]);
    expect(await f.core.getSessionPlanArtifact({ ...owner, knownRevision: 0 })).toMatchObject({ status: 'missing', revision: 0 });
    writeFileSync(file, Buffer.from([255]));
    const invalidOwner = { ...owner, sessionId: 'other' };
    expect(await f.core.getSessionPlanArtifact({ ...invalidOwner, knownRevision: 0 })).toMatchObject({ status: 'unavailable', revision: 0 });
    for (const char of ['é', '界', '🙂']) {
      for (let split = 1; split < Buffer.byteLength(char); split++) {
        const prefix = 'a'.repeat(131_072 - split);
        writeFileSync(file, prefix + char + 'tail');
        expect(await f.core.getSessionPlanArtifact(owner)).toMatchObject({ status: 'ready', truncated: true, content: prefix });
      }
    }
    const cap = 4 * 1024 * 1024, bytes = Buffer.alloc(cap, 65);
    writeFileSync(file, bytes);
    expect(await f.core.getSessionPlanArtifact(owner)).toMatchObject({ status: 'ready', truncated: true, content: 'A'.repeat(131_072) });
    for (const tail of [Buffer.from([0]), Buffer.from([255]), Buffer.from([0xe2, 0x82])]) {
      writeFileSync(file, Buffer.concat([bytes.subarray(0, -tail.length), tail]));
      expect(await f.core.getSessionPlanArtifact(owner)).toMatchObject({ status: 'unavailable' });
    }
    writeFileSync(file, Buffer.alloc(cap + 1, 65));
    expect(await f.core.getSessionPlanArtifact(owner)).toMatchObject({ status: 'unavailable' });
  });

  it('never follows traversal, private state or unowned workspace references from a transcript', async () => {
    const f = await setup(), owner = { profileId: 'default', sessionId: f.id };
    writeFileSync(join(f.cwd, 'implementation_plan.md'), 'never referenced');
    for (const content of ['[implementation_plan.md](https://example.invalid/implementation_plan.md)',
      'See nested/../implementation_plan.md.', 'See https://example.invalid/implementation_plan.md.']) {
      f.core.messages.set(f.id, [{ id: 'bad', sessionId: f.id, role: 'assistant', createdAt: '', content }]);
      expect((await f.core.getSessionPlanArtifact(owner)).status).toBe('missing');
    }
    for (const [i, dir] of [join(f.dir, 'outside'), join(f.cwd, '.gemini', 'credentials'), join(f.cwd, '.env')].entries()) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'implementation_plan.md'); writeFileSync(file, 'private');
      f.core.messages.set(f.id, [{ id: String(i), sessionId: f.id, role: 'assistant', createdAt: '', content: '[plan](' + file + ')' }]);
      expect((await f.core.getSessionPlanArtifact(owner)).content).toBeUndefined();
    }
  });
});
