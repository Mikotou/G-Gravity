// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFiles } from '../src/main/workspace/workspace-files';
import { InspectorStore } from '../src/main/session/inspector-store';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe('工作区引用不越界、不触碰敏感内容', () => {
  function setup() {
    const directory = mkdtempSync(path.join(tmpdir(), 'gravity-qa-workspace-')); directories.push(directory);
    const workspace = path.join(directory, 'workspace'); mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'src', 'hello.ts'), 'export const hello = 1;');
    writeFileSync(path.join(workspace, '.env'), 'synthetic-sensitive'); writeFileSync(path.join(directory, 'outside.txt'), 'outside');
    return { workspace, files: new WorkspaceFiles() };
  }
  it('只列出安全相对文件路径并读取小型文本引用', async () => {
    const { workspace, files } = setup();
    expect(await files.list(workspace)).toEqual(['src/hello.ts']);
    expect(await files.list(workspace, 'HELLO')).toEqual(['src/hello.ts']);
    expect((await files.readReference(workspace, 'src/hello.ts')).text).toContain('export const hello');
  });
  it('拒绝路径穿越、敏感文件、二进制及超限内容', async () => {
    const { workspace, files } = setup();
    await expect(files.readReference(workspace, '../outside.txt')).rejects.toThrow('超出');
    await expect(files.readReference(workspace, '.env')).rejects.toThrow('敏感');
    writeFileSync(path.join(workspace, 'binary.dat'), Buffer.from([0, 1, 2]));
    await expect(files.readReference(workspace, 'binary.dat')).rejects.toThrow('二进制');
    writeFileSync(path.join(workspace, 'large.txt'), 'a'.repeat(512 * 1024 + 1));
    await expect(files.readReference(workspace, 'large.txt')).rejects.toThrow('512');
  });
});
describe('Inspector Diff / Files / Plan / Terminal 衍生状态', () => {
  it('保留原生长命令和终端内容块，兼容结构化参数和纯文本参数', () => {
    const inspector = new InspectorStore();
    const command = 'echo ' + 'long-argument '.repeat(80);
    for (const [id, rawInput] of [['str', command], ['object', { CommandLine: command }]] as const) {
      const call = inspector.consume('s', { sessionUpdate: 'tool_call', name: 'run_command', toolCallId: id, rawInput, status: 'in_progress' });
      inspector.consume('s', { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
        toolContent: [{ type: 'content', content: { type: 'text', text: '完整输出' } }], rawOutput: { ExitCode: 0 } }, call);
      expect(inspector.get('s').terminals.find(t => t.toolCallId === id)).toMatchObject({ command, output: '完整输出', exitCode: 0 });
    }
  });
  it('Edit/Write准确生成红绿Diff；完成更新不丢失原命令与输出', () => {
    const store = new InspectorStore();
    const edit = store.consume('a', { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'edit_file', status: 'completed', rawInput: { path: 'a.ts', oldText: 'old', newText: 'new' } });
    expect(edit!.canonicalToolName).toBe('Edit'); expect(edit!.diffPatch).toMatchObject({ filePath: 'a.ts', addedLines: 1, removedLines: 1 });
    const initial = store.consume('a', { sessionUpdate: 'tool_call', toolCallId: 'bash', title: 'run_command', status: 'in_progress', rawInput: { command: 'npm test' } });
    const complete = store.consume('a', { sessionUpdate: 'tool_call_update', toolCallId: 'bash', status: 'completed', rawOutput: { output: '测试通过', exitCode: 0 } }, initial);
    expect(complete!.canonicalToolName).toBe('Bash');
    expect(store.get('a').terminals).toHaveLength(1);
    expect(store.get('a').terminals[0]).toMatchObject({ command: 'npm test', status: 'completed', exitCode: 0 });
    expect(store.get('a').terminals[0].output).toContain('测试通过');
    expect(store.get('b').diffs).toEqual([]);
  });
  it('Plan待办状态准确且快照防外部修改', () => {
    const store = new InspectorStore(); store.consume('a', { sessionUpdate: 'plan', entries: [{ content: '实现', status: 'completed' }, { content: '验证', status: 'in_progress' }] });
    const snapshot = store.get('a'); expect(snapshot.todos.map((todo) => todo.status)).toEqual(['completed', 'in_progress']);
    snapshot.todos[0].content = '外部修改'; expect(store.get('a').todos[0].content).toBe('实现'); store.clear(); expect(store.get('a').todos).toEqual([]);
  });
});
