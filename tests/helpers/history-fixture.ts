import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 全部为测试自建内容，绝不枚举真实用户 ~/.gemini。 */
export function createHistoryFixture() {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gravity-qa-history-')));
  const root = path.join(directory, '.gemini', 'antigravity');
  const logDirectory = path.join(root, 'brain', 'history-001', '.system_generated', 'logs');
  mkdirSync(logDirectory, { recursive: true });
  const transcript = path.join(logDirectory, 'transcript.jsonl');
  writeFileSync(transcript, [
    { role: 'user', content: '请检查测试项目', timestamp: '2026-11-17T00:00:00Z' },
    { role: 'assistant', content: '已完成只读检查。', timestamp: '2026-11-17T00:00:01Z' },
  ].map((value) => JSON.stringify(value)).join('\n') + '\n');
  const databasePath = path.join(root, 'conversation_summaries.db');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE conversation_summaries (id TEXT, conversation_id TEXT, title TEXT, summary TEXT, cwd TEXT, workspace_path TEXT, updated_at TEXT)');
  database.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?)').run('history-001', 'history-001', '只读历史测试', '测试合成会话摘要', 'F:\\synthetic-history', 'F:\\synthetic-history', '2026-11-17T00:00:01Z');
  database.close();
  const sensitiveNames = ['oauth_token.json', 'cookies.json', 'installation_id', 'state.pbtxt', 'refresh_token.json'];
  const decoys = sensitiveNames.map((name) => path.join(root, name));
  for (const file of decoys) writeFileSync(file, 'synthetic-sensitive-decoy-do-not-read');
  return { directory, root, transcript, databasePath, decoys };
}

/** 排除 atime（纯读取可能更新访问时间）；字节、数量、mtime/ctime、mode 与目录项必须不变。 */
export function snapshotHistoryTree(root: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  function walk(current: string) {
    const stat = lstatSync(current); const relative = path.relative(root, current) || '.';
    entries[relative] = { type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode,
      sha256: stat.isFile() ? createHash('sha256').update(readFileSync(current)).digest('hex') : undefined };
    if (stat.isDirectory()) for (const child of readdirSync(current).sort()) walk(path.join(current, child));
  }
  walk(root); return entries;
}
