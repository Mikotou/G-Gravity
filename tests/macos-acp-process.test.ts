// @vitest-environment node
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, posix, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { MacAcpProcessGroup } from '../src/main/acp/mac-acp-process-group';
import { buildAgyEnvironment } from '../src/main/acp/agy-environment';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { ClientStore } from '../src/main/storage/client-store';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const version = { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fixture', version: '1' } };
const directories: string[] = [];
async function withDeadline<T>(result: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([result, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for the fixture')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FixtureChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  requested: Array<{ id: number; method: string }> = [];
  exitCode: number | null = null;
  constructor(readonly pid: number | undefined, private readonly answerInitialize = true) { super(); }
  stdin = new Writable({ write: (chunk, _encoding, done) => {
    const message = JSON.parse(chunk.toString());
    this.requested.push(message);
    if (this.answerInitialize && message.method === 'initialize') {
      queueMicrotask(() => this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: version }) + '\n'));
    }
    done();
  } });
}

function simulateMac() {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');
}

function simulateGroups(pids: number[], ignoreTerm = false) {
  const alive = new Set(pids);
  return vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (!alive.has(-target)) throw Object.assign(new Error('No such group'), { code: 'ESRCH' });
    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !ignoreTerm)) alive.delete(-target);
    return true;
  });
}

it('releases pipes after SIGTERM returns EPERM for an exited group leader', async () => {
  const child = new FixtureChild(71236);
  const group = new MacAcpProcessGroup(child, 71236);
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'EPERM' }); });
  child.exitCode = 2;
  child.emit('exit', 2);
  const stopped = group.close(false);
  child.emit('close', 2);
  await stopped;
  expect(signal.mock.calls).toEqual([[-71236, 'SIGTERM']]);
  expect([child.stdin, child.stdout, child.stderr].every(pipe => pipe.destroyed)).toBe(true);
});

it.each(['EPERM', 'EIO'])('rejects initialize on immediate exit with group signal error %s', async code => {
  simulateMac();
  const child = new FixtureChild(71237, false);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
  const client = new AcpClient({ spawn: () => child });
  const diagnostic = vi.fn();
  client.on('diagnostic', diagnostic);
  const starting = client.start();
  expect(child.requested[0].method).toBe('initialize');
  child.exitCode = 2;
  child.emit('exit', 2);
  child.emit('close', 2);
  await expect(withDeadline(starting, 950)).rejects.toThrow(/ACP.*退出/);
  if (code === 'EIO') expect(diagnostic).toHaveBeenCalled();
});

describe('macOS GUI 环境与独立 ACP 进程组', () => {
  it('保留继承目录的顺序，补齐临近工具和常见安装路径，不改写调用方环境', () => {
    const env = { PATH: '/custom:/usr/bin:/custom:/opt/homebrew/bin', CURRENT: 'present' };
    const result = buildAgyEnvironment('/Users/example/cli/bin/agy', env, 'darwin', '/Users/example');
    const entries = result.PATH!.split(':');
    expect(entries.slice(0, 4)).toEqual(['/custom', '/usr/bin', '/opt/homebrew/bin', '/Users/example/cli/bin']);
    expect(entries).toEqual(expect.arrayContaining(['/usr/local/bin', '/Users/example/.local/bin', '/Users/example/.npm-global/bin', '/Users/example/bin', '/bin']));
    expect(new Set(entries).size).toBe(entries.length);
    expect(result.CURRENT).toBe('present');
    expect(env.PATH).toBe('/custom:/usr/bin:/custom:/opt/homebrew/bin');
    expect(buildAgyEnvironment('/tools/agy', { PATH: './tools:/custom:/usr/bin' }, 'darwin', '/Users/example')
      .PATH?.split(':').slice(0, 4)).toEqual(['./tools', '/custom', '/usr/bin', '/tools']);
    expect(buildAgyEnvironment('/bin/agy', env, 'win32')).toEqual(env);
    expect(buildAgyEnvironment('/bin/agy', env, 'linux')).toEqual(env);
  });

  it('ACP 与插件管理的实际入口传入同一目录，保持 shell 关闭', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gravity-mac-process-'));
    directories.push(dir);
    simulateMac();
    const child = new FixtureChild(71231);
    const signal = simulateGroups([71231]);
    const launch = vi.fn((_binary: string, _args: string[], _options: SpawnOptions) => child);
    const binary = '/test tool/bin/agy';
    const client = new AcpClient({ binaryPath: binary, spawn: launch });
    const run = vi.fn<CliExecutor>().mockResolvedValue({ stdout: '[]' });
    const plugins = new PluginsManager({ binaryPath: binary, executor: run, store: new ClientStore(dir), homeDir: dir });
    await client.start();
    try {
      await plugins.getSnapshot();
      const opts = launch.mock.calls[0][2];
      expect(opts).toMatchObject({ shell: false, detached: true });
      expect(opts.env?.PATH?.split(':')).toContain('/test tool/bin');
      expect(run.mock.calls.map(call => call[2].env?.PATH)).toEqual([opts.env?.PATH, opts.env?.PATH]);
      expect(signal).not.toHaveBeenCalled();
    } finally {
      const stopped = client.stop();
      child.emit('close', 0);
      await stopped;
    }
  });

  it('断开后即使父进程已退出，也只清理本次进程组；重复关闭和新建连接互不影响', async () => {
    simulateMac();
    const a = new FixtureChild(71231), b = new FixtureChild(71232);
    const signal = simulateGroups([71231, 71232], true);
    const client = new AcpClient({ spawn: vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b) });
    await client.start();
    const stopped = client.stop();
    const stoppedAgain = client.stop();
    a.emit('exit', 0);
    const connectedAgain = client.start();
    a.emit('close', 0);
    await Promise.all([stopped, stoppedAgain, connectedAgain]);
    expect(signal).toHaveBeenCalledWith(-71231, 'SIGTERM');
    expect(signal).toHaveBeenCalledWith(-71231, 'SIGKILL');
    expect(signal.mock.calls.some(([pid]) => pid !== -71231)).toBe(false);
    a.emit('error', new Error('late stale callback'));
    expect(client.connected).toBe(true);
    const finalStop = client.stop(); b.emit('close', 0); await finalStop;
    expect(signal.mock.calls.filter(([, s]) => s === 'SIGKILL')).toEqual([[-71231, 'SIGKILL'], [-71232, 'SIGKILL']]);
  });

  it('父进程提前退出、后代仍持管道时接收最后的应答，随后释放组和断开状态', async () => {
    simulateMac();
    const child = new FixtureChild(71233);
    const signal = simulateGroups([71233]);
    const client = new AcpClient({ spawn: () => child });
    await client.start();
    const reply = client.request('session/list');
    const pending = client.request('session/prompt', {}, 0).catch(err => err.message);
    const disconnected = new Promise(resolve => client.once('disconnected', resolve));
    child.emit('exit', 0);
    await expect(client.request('session/list')).rejects.toThrow('正在关闭');
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessions: [] }, id: child.requested[1].id }) + '\n');
    expect(await reply).toEqual({ sessions: [] });
    await withDeadline(disconnected, 1800);
    expect(await pending).toMatch(/退出|关闭|停止/);
    await client.stop();
    expect(signal).toHaveBeenCalledWith(-71233, 'SIGTERM');
    expect(child.stdout.destroyed).toBe(true);
  });

  it('握手过程中管道异常、启动时没有 PID 时均不触碰其他进程', async () => {
    simulateMac();
    const signal = simulateGroups([71234]);
    const child = new FixtureChild(71234);
    const client = new AcpClient({ spawn: () => child });
    const boot = client.start();
    child.stdin.emit('error', new Error('fixture'));
    child.emit('close', 1);
    await expect(boot).rejects.toThrow('已关闭');
    await client.stop();
    expect(signal).toHaveBeenCalledWith(-71234, 'SIGTERM');
    signal.mockClear();
    const missing = new FixtureChild(undefined);
    const failed = new AcpClient({ spawn: () => missing }).start();
    missing.emit('error', new Error('ENOENT'));
    await expect(failed).rejects.toThrow('无法启动');
    expect(signal).not.toHaveBeenCalled();
  });

  it('同组已结束时接受 ESRCH，不对已经退出的同号父进程单独发信号', async () => {
    simulateMac();
    const child = new FixtureChild(71235);
    const signal = simulateGroups([]);
    const client = new AcpClient({ spawn: () => child });
    await client.start();
    const stopped = client.stop(); child.emit('close', 0); await stopped;
    expect(signal).toHaveBeenCalledWith(-71235, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('Issue #4.1 — macOS 静态工具链与版本管理器 PATH 探测', () => {
  /**
   * Create a real temp directory on disk whose POSIX-style absolute path (starting with '/', no ':')
   * resolves directly via Node fs APIs on both POSIX and Windows (same drive as process.cwd()).
   */
  function createPosixTempHome(): { fsPath: string; posixHome: string } {
    const sameDriveTmp =
      process.platform !== 'win32' ||
      parse(tmpdir()).root.toLowerCase() === parse(process.cwd()).root.toLowerCase();
    let baseDir = tmpdir();
    if (!sameDriveTmp) {
      const cacheBase = join(process.cwd(), 'node_modules', '.cache');
      mkdirSync(cacheBase, { recursive: true });
      baseDir = cacheBase;
    }
    const fsPath = mkdtempSync(join(baseDir, 'gravity-mac-toolchain-'));
    directories.push(fsPath);
    const posixHome =
      process.platform === 'win32'
        ? fsPath.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
        : fsPath;
    return { fsPath, posixHome };
  }

  it('静态探测真实存在的工具链目录并择取最高 semver nvm 版本，排序位于继承/标准目录之后、系统兜底目录之前', () => {
    const { fsPath, posixHome: tempHome } = createPosixTempHome();
    const existingRelDirs = [
      '.volta/bin',
      '.bun/bin',
      '.cargo/bin',
      '.pyenv/shims',
      '.local/share/mise/shims',
      '.nvm/versions/node/v20.11.0/bin',
      '.nvm/versions/node/v22.14.0/bin',
    ];
    for (const rel of existingRelDirs) {
      mkdirSync(join(fsPath, ...rel.split('/')), { recursive: true });
    }

    const inputEnv = { PATH: '/usr/bin:/bin', KEEP: '1' };
    const result = buildAgyEnvironment('/opt/homebrew/bin/agy', inputEnv, 'darwin', tempHome);
    const entries = result.PATH!.split(':');

    // Inherited PATH stays at the very front without mutating the caller env.
    expect(entries.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
    expect(inputEnv.PATH).toBe('/usr/bin:/bin');
    expect(result.KEEP).toBe('1');
    expect(new Set(entries).size).toBe(entries.length);

    const standardUnixDirs = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      posix.join(tempHome, '.local/bin'),
      posix.join(tempHome, '.npm-global/bin'),
      posix.join(tempHome, 'bin'),
    ];
    for (const dir of standardUnixDirs) {
      expect(entries).toContain(dir);
    }

    const expectedToolchains = [
      posix.join(tempHome, '.volta/bin'),
      posix.join(tempHome, '.bun/bin'),
      posix.join(tempHome, '.cargo/bin'),
      posix.join(tempHome, '.pyenv/shims'),
      posix.join(tempHome, '.local/share/mise/shims'),
      posix.join(tempHome, '.nvm/versions/node/v22.14.0/bin'),
    ];
    for (const dir of expectedToolchains) {
      expect(entries).toContain(dir);
    }
    // Picks highest semver nvm version (v22.14.0/bin) rather than lower v20.11.0/bin.
    expect(entries).not.toContain(posix.join(tempHome, '.nvm/versions/node/v20.11.0/bin'));

    // Ordering: inherited PATH + sibling + standard Unix dirs < discovered toolchains < system fallbacks.
    const lastStandardIdx = Math.max(...standardUnixDirs.map(dir => entries.indexOf(dir)));
    const systemFallbackDirs = ['/usr/sbin', '/sbin'];
    for (const fallback of systemFallbackDirs) {
      expect(entries).toContain(fallback);
    }
    const firstSystemFallbackIdx = Math.min(...systemFallbackDirs.map(dir => entries.indexOf(dir)));
    for (const dir of expectedToolchains) {
      const idx = entries.indexOf(dir);
      expect(idx).toBeGreaterThan(lastStandardIdx);
      expect(idx).toBeLessThan(firstSystemFallbackIdx);
    }

    // Absent toolchain directories must NOT be blindly polluted into PATH.
    expect(entries).not.toContain(posix.join(tempHome, '.asdf/shims'));
    expect(entries).not.toContain(posix.join(tempHome, '.rbenv/shims'));
    expect(entries).not.toContain(posix.join(tempHome, '.fnm/current/bin'));

    // Also verify all 4 system fallbacks (/usr/bin, /bin, /usr/sbin, /sbin) trail toolchains when not pre-inherited.
    const customEntries = buildAgyEnvironment('/custom/cli/agy', { PATH: '/custom/inherited' }, 'darwin', tempHome).PATH!.split(':');
    const customLastStandardIdx = Math.max(
      customEntries.indexOf('/custom/inherited'),
      customEntries.indexOf('/custom/cli'),
      ...standardUnixDirs.map(dir => customEntries.indexOf(dir)),
    );
    const customFirstSystemIdx = Math.min(...['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map(dir => customEntries.indexOf(dir)));
    for (const dir of expectedToolchains) {
      const idx = customEntries.indexOf(dir);
      expect(idx).toBeGreaterThan(customLastStandardIdx);
      expect(idx).toBeLessThan(customFirstSystemIdx);
    }
  });

  it('按数值 semver 而非字典序挑选最高 nvm 版本，空 home 不污染任何不存在的工具链目录', () => {
    const { fsPath: nvmFsPath, posixHome: nvmHome } = createPosixTempHome();
    for (const ver of ['v9.11.2', 'v20.11.0', 'v22.2.0', 'v22.14.0']) {
      mkdirSync(join(nvmFsPath, '.nvm', 'versions', 'node', ver, 'bin'), { recursive: true });
    }
    const nvmEntries = buildAgyEnvironment('/opt/homebrew/bin/agy', { PATH: '/usr/bin:/bin' }, 'darwin', nvmHome).PATH!.split(':');
    expect(nvmEntries).toContain(posix.join(nvmHome, '.nvm/versions/node/v22.14.0/bin'));
    expect(nvmEntries).not.toContain(posix.join(nvmHome, '.nvm/versions/node/v9.11.2/bin'));
    expect(nvmEntries).not.toContain(posix.join(nvmHome, '.nvm/versions/node/v22.2.0/bin'));

    const { posixHome: emptyHome } = createPosixTempHome();
    const emptyEntries = buildAgyEnvironment('/opt/homebrew/bin/agy', { PATH: '/usr/bin:/bin' }, 'darwin', emptyHome).PATH!.split(':');
    for (const absent of [
      '.volta/bin',
      '.bun/bin',
      '.cargo/bin',
      '.pyenv/shims',
      '.local/share/mise/shims',
      '.asdf/shims',
    ]) {
      expect(emptyEntries).not.toContain(posix.join(emptyHome, absent));
    }
    expect(emptyEntries.some(entry => entry.includes('/.nvm/'))).toBe(false);
  });

  it('纯静态文件系统发现（零子进程派生），且 win32 与 linux 环境完全保持原样', () => {
    const envSource = readFileSync(resolve(__dirname, '../src/main/acp/agy-environment.ts'), 'utf8');
    expect(envSource).not.toMatch(/child_process/);
    expect(envSource).not.toMatch(/(?<!\.)\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/);

    const { fsPath, posixHome: tempHome } = createPosixTempHome();
    for (const rel of ['.volta/bin', '.bun/bin', '.cargo/bin', '.nvm/versions/node/v22.14.0/bin']) {
      mkdirSync(join(fsPath, ...rel.split('/')), { recursive: true });
    }
    const winEnv = { PATH: 'C:\\Windows\\System32' };
    const linuxEnv = { PATH: '/usr/bin:/bin' };
    expect(buildAgyEnvironment('/opt/homebrew/bin/agy', winEnv, 'win32', tempHome)).toEqual(winEnv);
    expect(buildAgyEnvironment('/opt/homebrew/bin/agy', linuxEnv, 'linux', tempHome)).toEqual(linuxEnv);
  });
});

const nativePosix = platform.value === 'darwin' || platform.value === 'linux';
it.runIf(nativePosix)('原生 POSIX 管道中运行 Mac 启动路径，ACP 与插件子进程都能找到同目录工具', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gravity-mac-path-'));
  directories.push(dir);
  const bin = join(dir, 'tool bin');
  mkdirSync(bin);
  const binary = join(bin, 'agy'), entry = join(bin, 'fixture.cjs');
  const tool = join(bin, 'gravity-issue-path-check');
  writeFileSync(tool, '#!/bin/sh\nprintf verified-tool\n', { mode: 0o700 });
  writeFileSync(binary, '#!/bin/sh\nexec "$GRAVITY_FIXTURE_NODE" "$GRAVITY_FIXTURE_JS" "$@"\n', { mode: 0o700 });
  writeFileSync(entry, [
    "const name = require('node:child_process').execFileSync('gravity-issue-path-check', { encoding: 'utf8' });",
    "if (process.argv[2] === 'acp') {",
    "  require('node:readline').createInterface({input:process.stdin}).on('line', line => {",
    "    const m = JSON.parse(line);",
    "    if (m.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name,version:'1'}}}));",
    "  });",
    "} else { console.log(JSON.stringify(process.argv[2] === 'plugin' ? [{name}] : [])); }",
  ].join('\n'));
  simulateMac();
  vi.stubEnv('GRAVITY_FIXTURE_NODE', process.execPath);
  vi.stubEnv('GRAVITY_FIXTURE_JS', entry);
  const client = new AcpClient({ binaryPath: binary, requestTimeoutMs: 6000 });
  try {
    expect((await client.start()).agentInfo.name).toBe('verified-tool');
    const plugins = new PluginsManager({ binaryPath: binary, store: new ClientStore(dir), homeDir: dir });
    expect((await plugins.getSnapshot()).plugins[0].name).toBe('verified-tool');
    expect(process.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  } finally { await client.stop(); }
});

it.runIf(nativePosix)('原生 POSIX 进程组中运行 Mac 关闭路径，父进程先退出时释放持管道的后代，另一个进程仍运行', async () => {
  simulateMac();
  const echoParent = [
    "const {spawn}=require('node:child_process');",
    "const {createInterface}=require('node:readline');",
    "const descendant=spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:['ignore',1,2]});",
    "createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);",
    "if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'fixture',version:'1'}}}));",
    "if(m.method==='fixture/pid') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:descendant.pid}));",
    "if(m.method==='fixture/exit') process.exit(0);});",
  ].join('\n');
  let parent: ChildProcess | undefined;
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { stdio: 'ignore' });
  const client = new AcpClient({ spawn: (_binary, _args, options) => {
    parent = spawn(process.execPath, ['-e', echoParent], options);
    return parent;
  } });
  let pid: number | undefined;
  const exists = (n: number) => {
    try { process.kill(n, 0); return true; } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false; throw err; }
  };
  try {
    await client.start();
    pid = await client.request<number>('fixture/pid');
    expect(exists(pid)).toBe(true);
    const disconnected = new Promise(resolve => client.once('disconnected', resolve));
    client.notify('fixture/exit');
    await withDeadline(disconnected, 3000);
    await client.stop();
    for (let attempt = 0; attempt < 80 && exists(pid); attempt++) await delay(25);
    expect(exists(pid)).toBe(false);
    expect(exists(unrelated.pid!)).toBe(true);
  } finally {
    await client.stop();
    parent?.kill();
    if (pid && exists(pid)) process.kill(pid, 'SIGTERM');
    unrelated.kill();
  }
}, 9000);
