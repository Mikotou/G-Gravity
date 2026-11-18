// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { ClientStore } from '../src/main/storage/client-store';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'gravity-qa-plugins-')); directories.push(directory);
  const home = path.join(directory, 'fake-home'); const workspace = path.join(directory, 'workspace'); mkdirSync(workspace, { recursive: true });
  const executor = vi.fn<CliExecutor>(async (_binary, args) => ({ stdout: args[0] === 'plugin' && args[1] === 'list' ? JSON.stringify({ plugins: [{ name: 'sample', enabled: true }] }) : args[0] === 'mcp' && args[1] === 'list' ? JSON.stringify({ mcpServers: { sample: { command: 'node', args: ['server.js'] } } }) : '完成' }));
  const manager = new PluginsManager({ store: new ClientStore(path.join(directory, 'client')), executor, homeDir: home, binaryPath: 'test-only-agy' });
  return { directory, home, workspace, executor, manager };
}

describe('Plugins/MCP/Skills 官方命令边界', () => {
  it('构造与缓存查询零CLI，显式刷新才以shell:false执行官方list', async () => {
    const { manager, executor, workspace } = setup();
    expect(executor).not.toHaveBeenCalled(); expect(manager.getCachedSnapshot().builtins.every((item) => item.badge === 'Built-in')).toBe(true);
    const snapshot = await manager.getSnapshot(workspace);
    expect(executor.mock.calls.map((call) => call[1])).toEqual([['plugin', 'list', '--json'], ['mcp', 'list']]);
    expect(executor.mock.calls.every((call) => call[2].shell === false)).toBe(true);
    expect(snapshot.plugins[0].name).toBe('sample'); expect(snapshot.mcpServers[0].commandOrUrl).toBe('node');
  });
  it.each(['install', 'uninstall', 'enable', 'disable'] as const)('插件 %s 使用独立参数，不改写官方配置', async (action) => {
    const { manager, executor, home } = setup(); mkdirSync(path.join(home, '.gemini'), { recursive: true });
    const officialConfig = path.join(home, '.gemini', 'settings.json'); writeFileSync(officialConfig, '{"synthetic":"unchanged"}');
    const before = readFileSync(officialConfig); await manager.runPluginAction({ action, target: 'sample@marketplace' });
    expect(executor.mock.calls[0][1]).toEqual(['plugin', action, 'sample@marketplace']);
    expect(executor.mock.calls[0][2].shell).toBe(false); expect(readFileSync(officialConfig).equals(before)).toBe(true);
  });
  it.each(['--config', '-f', 'target --force', 'a;evil', 'a\n--evil'])('危险插件目标 %s 在执行前拒绝', async (target) => {
    const { manager, executor } = setup(); await expect(manager.runPluginAction({ action: 'install', target })).rejects.toThrow('无效'); expect(executor).not.toHaveBeenCalled();
  });
  it('MCP add在用户参数前插入--分隔，内部flag与命令参数不会混淆', async () => {
    const { manager, executor } = setup();
    await manager.runMcpAction({ action: 'add', name: 'test-server', type: 'stdio', commandOrUrl: 'node', args: ['server.js', '--server-flag'], env: { TEST_MODE: '1' } });
    expect(executor.mock.calls[0][1]).toEqual(['mcp', 'add', '--type', 'stdio', '--env', 'TEST_MODE=1', 'test-server', '--', 'node', 'server.js', '--server-flag']);
    expect(executor.mock.calls[0][2].shell).toBe(false);
    await expect(manager.runMcpAction({ action: 'add', name: '--bad', commandOrUrl: 'node' })).rejects.toThrow('无效');
    await expect(manager.runMcpAction({ action: 'add', name: 'valid', commandOrUrl: '--settings' })).rejects.toThrow('无效');
  });
  it('公开Skill文件只读发现，开关仅写客户端偏好，不调用CLI或改源文件', async () => {
    const { manager, executor, workspace } = setup(); const skillPath = path.join(workspace, '.agents', 'skills', 'qa', 'SKILL.md');
    mkdirSync(path.dirname(skillPath), { recursive: true }); writeFileSync(skillPath, '---\nname: QA Skill\ndescription: Test only\n---\n合成技能');
    const before = readFileSync(skillPath); const snapshot = await manager.getSnapshot(workspace); expect(snapshot.skills).toHaveLength(1);
    const calls = executor.mock.calls.length; const updated = manager.toggleSkillEnabled(snapshot.skills[0].id, false);
    expect(updated.skills[0].enabled).toBe(false); expect(executor).toHaveBeenCalledTimes(calls); expect(readFileSync(skillPath).equals(before)).toBe(true);
  });
  it('并发显式操作不会启动重复管理命令', async () => {
    const { manager, executor } = setup(); let release!: (value: { stdout: string }) => void;
    executor.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const run = manager.runPluginAction({ action: 'enable', target: 'sample' });
    await expect(manager.runPluginAction({ action: 'disable', target: 'sample' })).rejects.toThrow('正在执行');
    release({ stdout: 'ok' }); await run; expect(executor.mock.calls.filter((call) => ['enable', 'disable'].includes(call[1][1]))).toHaveLength(1);
  });
});
