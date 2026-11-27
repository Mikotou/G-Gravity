// @vitest-environment node
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import { compileSafePattern } from '../src/main/approval/path-and-gemini-policy';
import { CoreService } from '../src/main/core-service';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import * as quota from '../src/main/accounts/account-quota';
import { openExternalTarget } from '../src/main/services/external-opener';
import { inspectLocalTargets, resolveLocalTarget } from '../src/main/services/local-media-inspector';
import { PlanArtifactReader } from '../src/main/session/plan-artifact-reader';
import { hasPlanText, planReferences } from '../src/main/session/plan-references';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { declaredModels } from '../src/main/session/session-options-store';
import { ClientStore } from '../src/main/storage/client-store';
import { SwarmWorkerClient } from '../src/main/swarm/swarm-worker-client';
import { LocalTranslator } from '../src/main/translation/local-translator';
import { GitHubUpdater, selectReleaseAsset } from '../src/main/updater/github-updater';
import { installDownloadedUpdate } from '../src/main/updater/platform-installer';
import { localPathMember, sameLocalPath } from '../src/main/workspace/local-path-safety';
import { WorkspaceFiles } from '../src/main/workspace/workspace-files';
import type { AcpSessionNewResult } from '../src/shared/acp-protocol';
import type { AppUpdateState } from '../src/shared/ipc-channels';

const shell = vi.hoisted(() => ({ openPath: vi.fn(), showItemInFolder: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false }, shell }));
const clean: Array<() => unknown> = [];
afterEach(async () => { try { while (clean.length) await clean.pop()!(); } finally { vi.restoreAllMocks(); vi.useRealTimers(); } });
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gravity-v035-core-'));
  clean.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

it('closes only the originating hidden title slot on a late successful creation and releases it after close confirmation', async () => {
  const dir = tempDir(), client = new AcpClient();
  client.initializeResult = { protocolVersion: 1, agentInfo: { name: 'fixture', version: '1' }, agentCapabilities: { sessionCapabilities: { close: {} } } };
  vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
  new ClientStore(dir).write('owned-sessions-default.json', { owned: { sessionId: 'owned', title: 'Owned', cwd: dir, updatedAt: '' } });
  const core = new CoreService({ acp: client, dataDir: dir });
  clean.push(() => core.dispose());
  type Late = NonNullable<Parameters<AcpClient['request']>[3]>;
  let late!: Late, closeLate!: Late;
  const request = vi.spyOn(client, 'request').mockImplementation(async (method, _params, _timeout, callback) => {
    if (method === 'session/new') late = callback!;
    if (method === 'session/close') closeLate = callback!;
    throw Error('fixture timeout');
  });
  await expect(core.organizeTitles({ sessionIds: ['owned'] })).rejects.toThrow('timeout');
  expect(core.sessions.activeSessionCount).toBe(1);
  late({ result: { sessionId: 'hidden' } });
  late({ result: { sessionId: 'hidden' } });
  expect(request.mock.calls.filter(([m]) => m === 'session/close').map(([, params]) => params)).toEqual([{ sessionId: 'hidden' }]);
  expect(core.sessions.activeSessionCount).toBe(1);
  closeLate({ result: {} });
  expect(core.sessions.activeSessionCount).toBe(0);
  await expect(core.organizeTitles({ sessionIds: ['owned'] })).rejects.toThrow();
  client.emit('disconnected', 'generation retired');
  late({ result: { sessionId: 'reused-on-new-transport' } });
  expect(request.mock.calls.filter(([m]) => m === 'session/close')).toHaveLength(1);
});

it('drains an actual SQLite write lock in bounded FIFO batches after a single ordinary worker read', async () => {
  const directory = tempDir(), worker = new SwarmWorkerClient({ directory, profile: 'default', owned: ['s'] });
  clean.push(() => worker.clear());
  const post = (id: string) => worker.consume('s', { sessionUpdate: 'tool_call', name: 'post_message', status: 'completed',
    toolCallId: id, rawInput: { sender: 'owner', content: id } });
  post('first'); expect((await worker.readState('s')).boardMessages).toHaveLength(1);
  const db = new DatabaseSync(join(directory, readdirSync(directory).find(f => f.endsWith('.sqlite'))!));
  try {
    db.exec('BEGIN IMMEDIATE');
    const warning = once(worker, 'updated');
    const pending = Array.from({ length: 40 }, (_, i) => 'ordered-' + i);
    pending.forEach(post);
    expect((await warning)[0].historyUnavailable).toBe(true);
    expect((await worker.readState('s')).historyUnavailable).toBe(true);
    await expect(worker.clear()).rejects.toThrow(/未保存/);
    db.exec('ROLLBACK');
    const batches: Array<[number, boolean]> = [];
    worker.on('updated', state => batches.push([state.boardMessages.length, !!state.historyUnavailable]));
    const firstBatch = await worker.readState('s');
    expect(firstBatch.historyUnavailable).toBe(true);
    expect(firstBatch.boardMessages.map(m => m.content)).toEqual(['first', ...pending.slice(0, 32)]);
    await vi.waitFor(() => expect(worker.getState('s').boardMessages.map(m => m.content)).toEqual(['first', ...pending]));
    const again = await worker.readState('s');
    expect(batches).toEqual([[33, true], [41, false]]);
    expect(again.historyUnavailable).toBeFalsy();
    expect(again.boardMessages.map(m => m.content)).toEqual(['first', ...pending]);
  } finally { db.close(); }
}, 20_000);

it('recovers disconnect markers under the real session ID when reopening SQLite is write-locked', async () => {
  const directory = tempDir();
  const worker = new SwarmWorkerClient({ directory, profile: 'default', owned: ['s'] });
  clean.push(() => worker.clear());
  const spawn = (id: string) => worker.consume('s', { sessionUpdate: 'tool_call', toolCallId: id, name: 'swarm', status: 'completed',
    rawInput: { action: 'spawn', name: id }, rawOutput: { workers: [{ name: id, status: 'working' }] } });
  spawn('first');
  expect((await worker.readState('s')).workers.some(w => w.status === 'working')).toBe(true);
  const db = new DatabaseSync(join(directory, readdirSync(directory).find(name => name.endsWith('.sqlite'))!));
  try {
    db.exec('BEGIN IMMEDIATE');
    const warning = once(worker, 'updated');
    spawn('second'); await warning;
    await expect(worker.clear()).rejects.toThrow(/未保存记录：s$/);
    worker.disconnected();
    await expect(worker.clear()).rejects.toThrow(/未保存记录：s$/);
    db.exec('ROLLBACK');
    const state = await worker.readState('s');
    expect(state.historyUnavailable).toBeFalsy();
    expect(state.workers.map(w => [w.name, w.status])).toEqual(expect.arrayContaining([['first', 'unconfirmed'], ['second', 'unconfirmed']]));
    expect(await worker.flush()).toEqual([]);
  } finally { db.close(); }
}, 20_000);

it('never downloads an asset of a different Windows architecture, including during API-only checks', async () => {
  const base = 'https://github.com/Mikotou/G-Gravity/releases/download/v1.0.0/';
  const assets = ['Gravity-win-arm64.exe', 'Gravity.exe', 'Gravity-win-x64.exe', 'Gravity-win-x64-arm64.exe']
    .map(name => ({ name, sizeBytes: 20, downloadUrl: base + name }));
  expect(selectReleaseAsset(assets, 'win32', 'x64')?.name).toBe('Gravity-win-x64.exe');
  expect(selectReleaseAsset(assets, 'win32', 'arm64')?.name).toBe('Gravity-win-arm64.exe');
  expect(selectReleaseAsset(assets.slice(1), 'win32', 'arm64')).toBeUndefined();
  expect(selectReleaseAsset([assets[0], assets[3]], 'win32', 'x64')).toBeUndefined();
  expect(selectReleaseAsset([assets[1]], 'win32', 'x64')).toBe(assets[1]);
  const fetcher = vi.fn(async (_url: unknown) => Response.json({ tag_name: 'v1.0.0', assets: [{
    name: assets[0].name, size: 20, browser_download_url: assets[0].downloadUrl,
  }] }));
  const updater = new GitHubUpdater({ currentVersion: '0.3.4', platform: 'win32', arch: 'x64', updatesDir: tempDir(), fetcher });
  expect(await updater.downloadUpdate()).toMatchObject({ status: 'error', errorMessage: expect.stringContaining('x64') });
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://api.github.com/repos/Mikotou/G-Gravity/releases/latest']);

  // macOS architecture fail-fast, hyphenated prerelease matching, and .zip preference over .dmg
  const macAssets = ['Gravity-0.3.5-rc-1-mac-arm64.dmg', 'Gravity-0.3.5-rc-1-mac-arm64.zip', 'Gravity-0.3.5-rc-1-mac-x64.zip']
    .map(name => ({ name, sizeBytes: 20, downloadUrl: base + name }));
  expect(selectReleaseAsset(macAssets, 'darwin', 'arm64')?.name).toBe('Gravity-0.3.5-rc-1-mac-arm64.zip');
  expect(selectReleaseAsset(macAssets, 'darwin', 'x64')?.name).toBe('Gravity-0.3.5-rc-1-mac-x64.zip');
  const macFetcher = vi.fn(async (_url: unknown) => Response.json({ tag_name: 'v0.3.5-rc-1', assets: [{
    name: macAssets[2].name, size: 20, browser_download_url: macAssets[2].downloadUrl,
  }] }));
  const macUpdater = new GitHubUpdater({ currentVersion: '0.3.4', platform: 'darwin', arch: 'arm64', updatesDir: tempDir(), fetcher: macFetcher });
  expect(await macUpdater.checkForUpdates()).toMatchObject({ status: 'error', errorMessage: expect.stringMatching(/macOS.*arm64/) });
  expect(macFetcher).toHaveBeenCalledTimes(1);
});

it('reaps a stuck Bergamot worker, ignores its late result and serves the next queued job', async () => {
  vi.useFakeTimers();
  class FixtureWorker extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);
  }
  const workers: FixtureWorker[] = [];
  const translator = new LocalTranslator(100, () => {
    const worker = new FixtureWorker(); workers.push(worker); return worker as unknown as Worker;
  });
  clean.push(() => translator.dispose());
  const first = expect(translator.translate('first')).rejects.toThrow(/超时/);
  const second = translator.translate('second');
  await vi.advanceTimersByTimeAsync(101);
  await first;
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(workers[1].postMessage.mock.calls[0][0].text).toBe('second');
  workers[0].emit('message', { id: 2, text: 'stale' });
  workers[0].emit('exit', 1);
  workers[1].emit('message', { id: 2, text: '译文' });
  expect(await second).toBe('译文');
});

it.each(['abort', 'postMessage failure'] as const)('immediately retires an active translator after %s', async failure => {
  class FakeWorker extends EventEmitter {
    postMessage = vi.fn<(m: { id: number; text: string }) => void>();
    terminate = vi.fn(async () => 0);
  }
  const workers: FakeWorker[] = [];
  const translator = new LocalTranslator(60_000, () => {
    const worker = new FakeWorker();
    if (!workers.length && failure === 'postMessage failure') worker.postMessage.mockImplementationOnce(() => { throw Error('postMessage failed'); });
    workers.push(worker);
    return worker as unknown as Worker;
  });
  clean.push(() => translator.dispose());
  const controller = new AbortController();
  const first = expect(translator.translate('first', controller.signal)).rejects.toThrow(failure === 'abort' ? /取消/ : /postMessage failed/);
  const second = translator.translate('second');
  if (failure === 'abort') controller.abort();
  expect(workers).toHaveLength(2);
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  const job = workers[1].postMessage.mock.calls[0][0];
  expect(job.text).toBe('second');
  workers[0].emit('error', Error('late')); workers[0].emit('message', { id: job.id, text: 'late' });
  workers[1].emit('message', { id: job.id, text: 'translated' });
  await first; expect(await second).toBe('translated');
});

it('reports unrecognized MCP shapes, recognizes explicit empty lists, labels CLI scope and blocks both cross-profile mutations', async () => {
  const dir = tempDir();
  let profile = 'default', mcp = '{"mcpServers":{}}';
  const executor = vi.fn<CliExecutor>(async (_bin, args) => ({ stdout: args[0] === 'plugin' ? '[]' : mcp }));
  const manager = new PluginsManager({ store: new ClientStore(dir), homeDir: dir, executor, activeProfile: () => profile });
  for (const empty of ['[]', '{}', '{"servers":[]}', '{"mcpServers":{}}', 'No MCP servers configured.', 'No MCP servers are configured.', 'Name Type Status Command/URL', 'Name Type Status Command/URL\n---', 'Name Type Status Command/URL\n---- ---- ------ -----------']) expect(manager.parseMcpList(empty)).toEqual([]);
  for (const bad of ['', 'null', '{"error":"offline"}', '{"weird":{"nested":1}}', '[{}]', 'bad output', 'Name Type Status Command/URL\nunknown column format', '{malformed']) {
    expect(() => manager.parseMcpList(bad)).toThrow(/无法识别/);
  }
  mcp = 'unrecognized';
  const snapshot = await manager.getSnapshot(dir);
  expect(snapshot.sectionErrors?.mcp).toMatch(/无法识别/);
  expect(snapshot.sectionErrors?.plugins).toBeUndefined();
  profile = 'isolated';
  expect(manager.getCachedSnapshot().lastCommandOutput).toMatch(/默认 Profile/);
  executor.mockClear();
  await expect(manager.runPluginAction({ action: 'enable', target: 'example' })).rejects.toThrow(/隔离/);
  await expect(manager.runMcpAction({ action: 'remove', name: 'example' })).rejects.toThrow(/隔离/);
  expect(executor).not.toHaveBeenCalled();
  const grouped = { sessionId: 's', configOptions: [{ id: 'model', name: 'Model', options: [
    { group: 'provider-A', name: 'A', options: [{ value: 'a', name: 'Model A' }] },
    { group: 'provider-B', name: 'B', options: [{ value: 'b', name: 'Model B' }] },
  ] }] } as unknown as AcpSessionNewResult;
  expect(declaredModels(grouped)?.map(m => m.modelId)).toEqual(['a', 'b']);
  grouped.configOptions![0].id = 'provider.model-selector';
  grouped.configOptions![0].category = 'model';
  expect(declaredModels(grouped)?.map(m => m.modelId)).toEqual(['a', 'b']);
});

it('reports the categorized model and uses grouped modes and efforts for real session configuration calls', async () => {
  const client = new AcpClient(), sessions = new SessionMultiplexer(client);
  client.initializeResult = { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fixture', version: '1' } };
  vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
  const group = (values: string[]) => [{ group: 'g', name: 'Group', options: values.map(value => ({ value, name: value })) }];
  const options = [{ id: 'provider.model', category: 'model', currentValue: 'alpha', options: group(['alpha', 'beta']) },
    { id: 'mode', currentValue: 'default', options: group(['default', 'plan']) },
    { id: 'thought_level', currentValue: 'high', options: group(['low', 'high']) }];
  const request = vi.spyOn(client, 'request').mockImplementation(async (method, raw) => {
    if (method === 'session/new') return { sessionId: 's', configOptions: options };
    const { configId, value } = raw as { configId: string; value: string };
    if (method === 'session/set_config_option') options.find(opt => opt.id === configId)!.currentValue = value;
    return { configOptions: options };
  });
  const session = await sessions.createSession({ cwd: tempDir() });
  expect(sessions.reportedChoice('s', 'model')).toBe('alpha');
  expect(session.availableEfforts?.map(e => e.value)).toEqual(['low', 'high']);
  expect(sessions.supportsMode('s', 'plan')).toBe(true);
  expect(sessions['options'].supportsEffort('s', 'low')).toBe(true);
  expect((await sessions.setSessionMode('s', 'plan')).executionMode).toBe('plan');
  expect((await sessions.setSessionEffort('s', 'low')).reasoningEffort).toBe('low');
  await sessions.setSessionModel('s', 'beta');
  expect(sessions.reportedChoice('s', 'model')).toBe('beta');
  expect(request.mock.calls.filter(([method]) => method === 'session/set_config_option').map(([, params]) => params))
    .toEqual(['mode', 'thought_level', 'provider.model'].map((configId, i) => ({ sessionId: 's', configId, value: ['plan', 'low', 'beta'][i] })));
});

it('requires a manual quota refresh to rearm polling after cooldown expiry', async () => {
  const client = new AcpClient(), core = new CoreService({ dataDir: tempDir(), acp: client });
  clean.push(() => core.dispose());
  const deadline = vi.spyOn(client, 'cooldownUntilMs', 'get').mockReturnValue(Date.now() - 100);
  const probe = vi.spyOn(quota, 'readAccountQuota').mockResolvedValue({ profileId: 'default', buckets: [], checkedAt: '' });
  await expect(core.getAccountQuota()).rejects.toThrow(/手动刷新/);
  expect(probe).not.toHaveBeenCalled();
  probe.mockRejectedValueOnce(Error('transport failed'));
  await expect(core.getAccountQuota(true)).rejects.toThrow('transport failed');
  await expect(core.getAccountQuota()).rejects.toThrow(/手动刷新/);
  probe.mockRejectedValueOnce(new quota.AccountQuotaUnavailable('helper'));
  expect(await core.getAccountQuota(true)).toMatchObject({ unavailable: 'helper' });
  await expect(core.getAccountQuota()).rejects.toThrow(/手动刷新/);
  const ok = { profileId: 'default', buckets: [], checkedAt: '' };
  let finish!: (value: typeof ok) => void;
  probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = core.getAccountQuota(true);
  await expect(core.getAccountQuota()).rejects.toThrow(/手动刷新/);
  deadline.mockReturnValue(Date.now() - 1); finish(ok); await pending;
  await expect(core.getAccountQuota()).rejects.toThrow(/手动刷新/);
  await core.getAccountQuota(true); await core.getAccountQuota();
  expect(probe).toHaveBeenCalledTimes(5);
});

it('keeps legacy empty rules inert and removable, preserves literal whitespace and enforces the shared validator on edits', () => {
  const disk = new ClientStore(tempDir());
  disk.write('approval-config.json', { mode: 'rules-only', allowPatterns: ['', '  ', '^git status$'], askPatterns: ['[bad'] });
  const core = new CoreService({ dataDir: disk.dataDir });
  clean.push(() => core.dispose());
  const engine: ApprovalEngine = core.approval;
  expect(engine.getConfig().allowPatterns).toEqual(['', '  ', '^git status$']);
  expect(engine.getConfig().askPatterns).toEqual([]);
  expect(compileSafePattern('').test('anything')).toBe(false);
  expect(compileSafePattern('  ').test('x  y')).toBe(true);
  expect(compileSafePattern('  ').test('xy')).toBe(false);
  for (const invalid of [['', '  ', '  '], [' '], ['^a\\1'], Array(51).fill('ok')]) {
    expect(() => engine.updateConfig({ allowPatterns: invalid })).toThrow();
  }
  engine.updateConfig({ allowPatterns: ['  '] });
  engine.updateConfig({ allowPatterns: [] });
  expect(() => engine.updateConfig({ allowPatterns: [''] })).toThrow();
  expect(engine.updateConfig({ askPatterns: Array(50).fill('ok') }).askPatterns).toHaveLength(50);
});

it.each(['resolved error', 'rejected'] as const)('reports actual Finder fallback when openPath yields %s', async mode => {
  const property = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...property, value: 'darwin' });
    if (mode === 'rejected') shell.openPath.mockRejectedValueOnce(Error('failed'));
    else shell.openPath.mockResolvedValueOnce('failed');
    const result = await installDownloadedUpdate('/synthetic/Gravity.dmg', {} as AppUpdateState,
      { size: 1, name: 'Gravity.dmg', releaseTag: 'v1', downloadUrl: '', sha256: '' });
    expect(result).toMatchObject({ launched: false, message: expect.stringContaining('Finder') });
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/synthetic/Gravity.dmg');
  } finally { Object.defineProperty(process, 'platform', property); }
});

it('checks physical LOC, all static TypeScript dependencies (including types) and the ACP layer boundary', () => {
  const root = resolve('src/main');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts')).map(f => resolve(root, f));
  const names = new Set(files), edges = new Map<string, Set<string>>(), lines = new Map<string, number>();
  const backEdges: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    lines.set(file, source.replace(/\r?\n$/, '').split(/\r?\n/).length);
    const deps = new Set<string>();
    const visit = (n: ts.Node) => {
      let module: ts.Expression | ts.TypeNode | undefined;
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) module = n.moduleSpecifier;
      else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) module = n.argument.literal;
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) module = n.arguments[0];
      if (module && ts.isStringLiteralLike(module) && module.text.startsWith('.')) {
        const base = resolve(dirname(file), module.text);
        const dep = [base + '.ts', join(base, 'index.ts')].find(f => names.has(f));
        if (dep) deps.add(dep);
      }
      ts.forEachChild(n, visit);
    };
    visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
    edges.set(file, deps);
    if (relative(root, file).split(/[\\/]/)[0] === 'acp') {
      for (const dep of deps) if (relative(root, dep).split(/[\\/]/)[0] === 'services') backEdges.push(file + ' -> ' + dep);
    }
  }
  const visited = new Set<string>(), stack = new Set<string>();
  function traverse(file: string) {
    if (stack.has(file)) throw Error('Dependency cycle: ' + [...stack, file].join(' -> '));
    if (visited.has(file)) return;
    stack.add(file);
    edges.get(file)?.forEach(traverse);
    stack.delete(file);
    visited.add(file);
  }
  files.forEach(traverse);
  expect(backEdges).toEqual([]);
  const [largest, max] = [...lines].sort((a, b) => b[1] - a[1])[0];
  const core = lines.get(join(root, 'core-service.ts'))!, index = lines.get(join(root, 'index.ts'))!;
  expect(max).toBeLessThanOrEqual(650); expect(core).toBeLessThanOrEqual(420); expect(index).toBeLessThanOrEqual(160);
  console.info('V035_ARCH', JSON.stringify({ files: files.length, largest: relative(root, largest), max, core, index,
    edges: [...edges.values()].reduce((sum, dep) => sum + dep.size, 0), cycles: 0, reverse: backEdges.length }));
});

it('matches Implementation_Plan.md case-insensitively and downgrades .dmg/.mpkg/.app targets to reveal-in-folder', async () => {
  expect(hasPlanText('See docs/Implementation_Plan.md for steps')).toBe(true);
  const refs = [...planReferences([{
    id: 'm1', sessionId: 's1', role: 'assistant', content: 'Updated docs/Implementation_Plan.md', createdAt: '',
  }])];
  expect(refs).toEqual(['docs/Implementation_Plan.md']);

  const dir = tempDir();
  const dmg = join(dir, 'Gravity-0.3.5-mac-arm64.dmg');
  const mpkg = join(dir, 'Installer.mpkg');
  const appBundle = join(dir, 'Gravity.app');
  writeFileSync(dmg, 'dmg');
  writeFileSync(mpkg, 'mpkg');
  mkdirSync(appBundle);
  const opened: Array<{ target: string; mode: string; isDir?: boolean }> = [];
  const openTargetHandler = vi.fn(async (target: string, mode: string, isDir?: boolean) => {
    opened.push({ target, mode, isDir });
  });
  for (const [target, expectDir] of [[dmg, false], [mpkg, false], [appBundle, true]] as const) {
    const res = await openExternalTarget({ target, action: 'default-app' }, { openTargetHandler });
    expect(res.modeUsed).toBe('reveal-in-folder');
    expect(opened.at(-1)?.isDir).toBe(expectDir);
  }
});

it.runIf(process.platform === 'darwin')('handles macOS /tmp aliases, APFS case-insensitive symlink boundaries, and NFC/NFD equivalence', async () => {
  const base = mkdtempSync('/tmp/gravity-mac-PathCheck-');
  clean.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const canonicalBase = realpathSync.native(base);
  const wsName = 'MyProject';
  const wsAlias = join(base, wsName);
  const wsCanonical = join(canonicalBase, wsName);
  const outsideDir = join(canonicalBase, 'Outside');
  mkdirSync(wsCanonical);
  mkdirSync(outsideDir);

  const planFile = join(wsCanonical, 'implementation_plan.md');
  writeFileSync(planFile, '# macOS Plan\n', 'utf8');
  const aliasPlanPath = join(wsAlias, 'implementation_plan.md');
  const upperAliasPlanPath = aliasPlanPath.replace(/^\/tmp\//, '/TMP/');

  expect(sameLocalPath(planFile, aliasPlanPath)).toBe(true);
  expect(sameLocalPath(planFile, upperAliasPlanPath)).toBe(true);
  expect(localPathMember(wsCanonical, aliasPlanPath)).toBe('implementation_plan.md');

  // 1. PlanArtifactReader accepts /tmp alias reference when cwd is /private/tmp, and openExternalTarget accepts /tmp & file:///tmp
  const gen = {};
  const reader = new PlanArtifactReader(
    owner => owner.sessionId === 'mac-s1' ? {
      cwd: wsCanonical,
      homeDir: outsideDir,
      generation: gen,
      references: () => [aliasPlanPath],
    } : undefined,
    () => {},
  );
  clean.push(() => reader.clear());
  const snap = await reader.get({ profileId: 'default', sessionId: 'mac-s1' });
  expect(snap.status).toBe('ready');
  expect(snap.filePath).toBe(planFile);

  const handler = vi.fn(async () => {});
  for (const target of [aliasPlanPath, pathToFileURL(aliasPlanPath).href]) {
    const res = await openExternalTarget(
      { target, action: 'reveal-in-folder', sessionId: 'mac-s1', planArtifactOwner: { profileId: 'default', sessionId: 'mac-s1', revision: snap.revision } },
      { openTargetHandler: handler, homeDir: outsideDir },
      undefined,
      owner => reader.get(owner),
    );
    expect(res.opened).toBe(true);
    expect(res.resolvedTarget).toBe(planFile);
  }

  // 2. APFS case-insensitive workspace symlink escape must be blocked even when path changes case
  const outsidePng = join(outsideDir, 'secret.png');
  writeFileSync(outsidePng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  symlinkSync(outsidePng, join(wsCanonical, 'escape.png'));
  const lowerCaseEscape = join(base.toLowerCase(), wsName.toLowerCase(), 'escape.png');
  expect(resolveLocalTarget(lowerCaseEscape, { cwd: wsCanonical }, { homeDir: outsideDir }, true)).toEqual({ kind: 'forbidden' });

  // 3. WorkspaceFiles.readReference allows case-variant /tmp path inside workspace while rejecting symlink
  const noteFile = join(wsCanonical, 'Note.txt');
  writeFileSync(noteFile, 'hello-apfs', 'utf8');
  const wf = new WorkspaceFiles();
  const ref = await wf.readReference(wsAlias, join(base.toLowerCase(), wsName.toLowerCase(), 'note.txt'));
  expect(ref.text).toBe('hello-apfs');
  await expect(wf.readReference(wsAlias, join(base.toLowerCase(), wsName.toLowerCase(), 'escape.png'))).rejects.toThrow(/符号链接/);

  // 4. Unicode NFC vs NFD spelling on APFS & case-variant inline PNG preview (BUG-MAC-BE-01)
  const nfcFile = join(wsCanonical, 'caf\u00e9.md');
  const nfdFile = join(wsCanonical, 'cafe\u0301.md');
  writeFileSync(nfcFile, 'coffee', 'utf8');
  expect(sameLocalPath(nfcFile, nfdFile)).toBe(true);

  const assetsDir = join(wsCanonical, 'Assets');
  mkdirSync(assetsDir);
  const realPng = join(assetsDir, 'Logo.PNG');
  writeFileSync(realPng, Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc000000301010018dd8db00000000049454e44ae426082',
    'hex',
  ));
  const inspected = await inspectLocalTargets(
    { targets: ['./assets/logo.png'], cwd: wsCanonical, includePreviewData: true },
    { homeDir: outsideDir },
  );
  expect(inspected.items['./assets/logo.png']).toMatchObject({
    kind: 'image',
    exists: true,
    width: 1,
    height: 1,
    previewDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
  });
});

it('strips legacy layout.json keys so reviseMessage and switchConversationBranch succeed, and emits tree-updated on rollback', async () => {
  const dir = tempDir();
  const ws = tempDir();
  const store = new ClientStore(dir);
  // Real upgraded user layout.json from v0.2.x/v0.3.x containing legacy keys
  store.write('layout.json', {
    openTabSessionIds: [],
    activePrimarySessionId: null,
    splitSecondarySessionId: null,
    layoutMode: 'single',
    hideLegacyPollutionSessions: true,
    leftSidebarCollapsed: false,
    leftSidebarWidth: 225,
    rightInspectorCollapsed: false,
    rightInspectorWidth: 349,
    activeInspectorTab: 'context',
    splitRatio: 0.539,
    paneColumnRatio: 0.5,
    paneRowRatio: 0.5,
    composerHeight: 0,
  });

  const client = new AcpClient();
  client.initializeResult = {
    protocolVersion: 1,
    agentInfo: { name: 'fixture', version: '1' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
  };
  let seq = 0;
  vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
  vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(client, 'request').mockImplementation(async (method) => {
    if (method === 'session/new') return { sessionId: `sess-${++seq}` };
    if (method === 'session/load') return {};
    if (method === 'session/close') return {};
    if (method === 'session/prompt') return { stopReason: 'end_turn' };
    return {};
  });

  const core = new CoreService({ acp: client, dataDir: dir });
  clean.push(() => core.dispose());
  const root = await core.createSession({ cwd: ws });
  await core.saveWorkspaceLayout({ openTabSessionIds: [root.sessionId], activePrimarySessionId: root.sessionId });
  await core.sendPrompt({ sessionId: root.sessionId, text: 'first turn' });
  const msg = core.messages.get(root.sessionId)!.find(m => m.role === 'user')!;

  // 1) reviseMessage and switchConversationBranch must NOT fail with 工作台布局无效
  const branch = await core.reviseMessage({ sessionId: root.sessionId, messageId: msg.id, text: 'revised turn' });
  expect(branch.sessionId).not.toBe(root.sessionId);
  const savedLayout = store.read<Record<string, unknown>>('layout.json', {});
  expect(savedLayout).not.toHaveProperty('paneColumnRatio');
  expect(savedLayout).not.toHaveProperty('paneRowRatio');
  expect(savedLayout).not.toHaveProperty('composerHeight');

  const switched = await core.switchConversationBranch({ sessionId: root.sessionId, targetBranchId: root.sessionId });
  expect(switched.session.sessionId).toBe(root.sessionId);
  const switchedBack = await core.switchConversationBranch({ sessionId: root.sessionId, targetBranchId: branch.sessionId });
  expect(switchedBack.session.sessionId).toBe(branch.sessionId);

  // 2) Rollback after recordBranch must emit tree-updated so renderer never retains a ghost branch
  const treeUpdates: number[] = [];
  core.on('tree-updated', tree => treeUpdates.push(tree.totalBranches));
  const layoutSpy = vi.spyOn(core['settings'], 'saveWorkspaceLayout').mockImplementationOnce(() => {
    throw new Error('simulated layout failure');
  });
  await expect(core.reviseMessage({ sessionId: branch.sessionId, messageId: core.messages.get(branch.sessionId)!.find(m => m.role === 'user')!.id, text: 'fail me' }))
    .rejects.toThrow('simulated layout failure');
  layoutSpy.mockRestore();
  expect(treeUpdates.at(-1)).toBe(2);
  expect((await core.getConversationTree(root.sessionId)).totalBranches).toBe(2);

  // 3) Real agy Windows leading-slash location path normalization
  if (process.platform === 'win32') {
    const locRefs = [...planReferences([{
      id: 'm-loc', sessionId: 's1', role: 'assistant', content: '', createdAt: '',
      toolCalls: [{
        toolCallId: 't1', rawToolName: 'write_file', canonicalToolName: 'Write', compactTarget: 'implementation_plan.md',
        status: 'completed', argsSummary: '{}', startedAt: '',
        locations: [{ path: '/C:/work/implementation_plan.md' }],
      }],
    }])];
    expect(locRefs).toEqual(['C:/work/implementation_plan.md']);
  }
});
