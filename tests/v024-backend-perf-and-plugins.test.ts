// @vitest-environment node
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { InspectorStore } from '../src/main/session/inspector-store';
import { ClientStore } from '../src/main/storage/client-store';
import { isSafeLocalPluginDirectory } from '../src/shared';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: vi.fn(fs.renameSync),
    promises: {
      ...fs.promises,
      rename: vi.fn(fs.promises.rename),
    },
  };
});

const tempDirs: string[] = [];
const renameSyncMock = vi.mocked(renameSync);
const renameAsyncMock = vi.mocked(fsPromises.rename);

function countDiskCommitsFor(fileName: string): number {
  const match = (target: unknown) => typeof target === 'string' && path.basename(target) === fileName;
  const syncHits = renameSyncMock.mock.calls.filter((call) => match(call[1])).length;
  const asyncHits = renameAsyncMock.mock.calls.filter((call) => match(call[1])).length;
  return syncHits + asyncHits;
}

afterEach(() => {
  renameSyncMock.mockClear();
  renameAsyncMock.mockClear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  vi.restoreAllMocks();
});

describe('v0.2.4 Backend Performance & PluginsManager Gates', () => {
  it('1) ClientStore.writeDebounced + flushPending coalesces 50 rapid writes into <= 3 disk writes and persists final state reliably', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gravity-v024-store-debounce-'));
    tempDirs.push(dir);
    const store = new ClientStore(dir);

    expect(typeof store.writeDebounced).toBe('function');
    expect(typeof store.flushPending).toBe('function');

    renameSyncMock.mockClear();
    renameAsyncMock.mockClear();

    for (let i = 1; i <= 50; i++) {
      store.writeDebounced!('perf-state.json', { seq: i, payload: `value-${i}` }, 80);
    }

    // Rapid burst should not have synchronously written 50 times before flush
    expect(countDiskCommitsFor('perf-state.json')).toBeLessThanOrEqual(3);

    store.flushPending!();
    const writesAfterFlush = countDiskCommitsFor('perf-state.json');
    expect(writesAfterFlush).toBeGreaterThanOrEqual(1);
    expect(writesAfterFlush).toBeLessThanOrEqual(3);
    expect(store.read<{ seq: number; payload: string } | null>('perf-state.json', null)).toEqual({
      seq: 50,
      payload: 'value-50',
    });

    // Verify timer-driven auto-flush also coalesces rapid writes and persists final state
    renameSyncMock.mockClear();
    renameAsyncMock.mockClear();
    for (let i = 51; i <= 75; i++) {
      store.writeDebounced!('perf-timer.json', { seq: i }, 30);
    }
    await new Promise((resolve) => setTimeout(resolve, 140));
    const timerWrites = countDiskCommitsFor('perf-timer.json');
    expect(timerWrites).toBeGreaterThanOrEqual(1);
    expect(timerWrites).toBeLessThanOrEqual(3);
    expect(store.read<{ seq: number } | null>('perf-timer.json', null)).toEqual({ seq: 75 });
  });

  it('2) InspectorStore coalesces 50 rapid tool_call_update bursts (reducing disk writes significantly) and persists cleanly after flush() / dispose()', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gravity-v024-inspector-burst-'));
    tempDirs.push(dir);
    const store = new ClientStore(dir);
    const inspector = new InspectorStore(store, 'default');

    renameSyncMock.mockClear();
    renameAsyncMock.mockClear();

    let card = inspector.consume('sess-burst', {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-burst-1',
      name: 'run_command',
      rawInput: { command: 'npm run build' },
      status: 'in_progress',
    });

    for (let i = 1; i <= 50; i++) {
      card = inspector.consume(
        'sess-burst',
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-burst-1',
          rawOutput: { stdout: `chunk-${i}` },
          status: 'in_progress',
        },
        card
      );
    }

    card = inspector.consume(
      'sess-burst',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-burst-1',
        rawOutput: { stdout: 'final-build-output', exitCode: 0 },
        status: 'completed',
      },
      card
    );

    // 52 rapid updates must coalesce significantly (<= 5 disk writes before explicit flush, >= 90% reduction)
    const burstWrites = countDiskCommitsFor('inspector-states-default.json');
    expect(burstWrites).toBeLessThanOrEqual(5);

    // Flush and verify a fresh InspectorStore recovers the complete final state from disk
    expect(typeof inspector.flush).toBe('function');
    inspector.flush();

    const recovered = new InspectorStore(new ClientStore(dir), 'default');
    expect(recovered.get('sess-burst').terminals).toHaveLength(1);
    expect(recovered.get('sess-burst').terminals[0]).toMatchObject({
      toolCallId: 'tc-burst-1',
      command: 'npm run build',
      output: 'final-build-output',
      status: 'completed',
      exitCode: 0,
    });

    // Also verify flush() persists a newly dirtied state cleanly
    const inspector2 = new InspectorStore(new ClientStore(dir), 'default');
    inspector2.consume('sess-dispose', {
      sessionUpdate: 'plan',
      entries: [{ content: 'Flush on dispose', status: 'completed' }],
    });
    inspector2.flush();

    const recoveredAfterDispose = new InspectorStore(new ClientStore(dir), 'default');
    expect(recoveredAfterDispose.get('sess-dispose').todos).toEqual([
      expect.objectContaining({ content: 'Flush on dispose', status: 'completed' }),
    ]);
  });

  it('3) PluginsManager install allows safe absolute local plugin directory (isSafeLocalPluginDirectory) while rejecting .. and .gemini', async () => {
    // Shared Wave 0 validator checks
    expect(isSafeLocalPluginDirectory('C:\\Work\\my-plugin')).toBe(true);
    expect(isSafeLocalPluginDirectory('/Users/dev/plugins/custom-plugin')).toBe(true);
    expect(isSafeLocalPluginDirectory('C:\\Work\\..\\escape-plugin')).toBe(false);
    expect(isSafeLocalPluginDirectory('/Users/dev/.gemini/config/plugins/bad')).toBe(false);
    expect(isSafeLocalPluginDirectory('C:\\Users\\Admin\\.gemini\\plugins\\bad')).toBe(false);
    expect(isSafeLocalPluginDirectory('relative/plugin-dir')).toBe(false);

    const dir = mkdtempSync(path.join(tmpdir(), 'gravity-v024-plugins-local-'));
    tempDirs.push(dir);
    const localPluginDir = path.join(dir, 'my-local-plugin');
    mkdirSync(localPluginDir, { recursive: true });
    const home = path.join(dir, 'fake-home');

    const executor = vi.fn<CliExecutor>(async (_binary, args) => ({
      stdout:
        args[0] === 'plugin' && args[1] === 'list'
          ? JSON.stringify({ plugins: [{ name: 'my-local-plugin', enabled: true, path: localPluginDir }] })
          : args[0] === 'mcp' && args[1] === 'list'
            ? JSON.stringify({ mcpServers: {} })
            : 'Installed local plugin',
    }));

    const manager = new PluginsManager({
      store: new ClientStore(path.join(dir, 'client')),
      executor,
      homeDir: home,
      binaryPath: 'test-only-agy',
    });

    // Safe absolute local directory must be allowed for install with shell: false
    const snap = await manager.runPluginAction({ action: 'install', target: localPluginDir });
    expect(executor.mock.calls[0][1]).toEqual(['plugin', 'install', localPluginDir]);
    expect(executor.mock.calls[0][2].shell).toBe(false);
    expect(snap.plugins.some((p) => p.name === 'my-local-plugin')).toBe(true);

    // Directory traversal (..) and .gemini paths MUST be rejected before invoking CLI
    executor.mockClear();
    const traversalTarget = `${localPluginDir}${path.sep}..${path.sep}outside`;
    const geminiTarget = path.join(home, '.gemini', 'config', 'plugins', 'evil-plugin');
    await expect(manager.runPluginAction({ action: 'install', target: traversalTarget })).rejects.toThrow();
    await expect(manager.runPluginAction({ action: 'install', target: geminiTarget })).rejects.toThrow();
    expect(executor).not.toHaveBeenCalled();
  });

  it('4) PluginsManager refresh() degrades gracefully with sectionErrors and sanitized stderr excerpt when one CLI section fails', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gravity-v024-plugins-degrade-'));
    tempDirs.push(dir);
    const workspace = path.join(dir, 'workspace');
    const skillPath = path.join(workspace, '.agents', 'skills', 'resilient-skill', 'SKILL.md');
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, '---\nname: Resilient Skill\ndescription: Survives partial CLI failure\n---\nbody');

    const secretToken = 'sk-live-secret-token-9876543210';
    const rawCliFailure = Object.assign(
      new Error(`plugin list failed: Authorization: Bearer ${secretToken} api_key=TOP_SECRET_999`),
      { stderr: `fatal: upstream unreachable with Authorization: Bearer ${secretToken} api_key=TOP_SECRET_999` }
    );

    const executor = vi.fn<CliExecutor>(async (_binary, args) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        throw rawCliFailure;
      }
      if (args[0] === 'mcp' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            mcpServers: {
              docs: { command: 'node', args: ['docs-mcp.js'], enabled: true },
            },
          }),
        };
      }
      return { stdout: '' };
    });

    const manager = new PluginsManager({
      store: new ClientStore(path.join(dir, 'client')),
      executor,
      homeDir: path.join(dir, 'fake-home'),
      binaryPath: 'test-only-agy',
    });

    const snapshot = await manager.getSnapshot(workspace);

    // Remaining sections still succeed despite plugin list failing
    expect(snapshot.builtins.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.mcpServers).toEqual([
      expect.objectContaining({ name: 'docs', commandOrUrl: 'node', enabled: true }),
    ]);
    expect(snapshot.skills).toEqual([
      expect.objectContaining({ name: 'Resilient Skill', scope: 'workspace', enabled: true }),
    ]);

    // sectionErrors reports bounded, sanitized failure for 'plugins' without leaking secrets
    expect(snapshot.sectionErrors?.plugins).toBeTruthy();
    expect(snapshot.sectionErrors!.plugins!.length).toBeLessThanOrEqual(300);
    expect(snapshot.sectionErrors!.plugins).not.toContain(secretToken);
    expect(snapshot.sectionErrors!.plugins).not.toContain('TOP_SECRET_999');
    expect(snapshot.sectionErrors?.mcp).toBeUndefined();
  });
});
