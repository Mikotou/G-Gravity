// @vitest-environment node
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createHistoryFixture, snapshotHistoryTree } from './helpers/history-fixture';

describe('历史只读强断言测试基础设施（尚非业务导入器）', () => {
  it('测试摘要 DB 可用 readOnly 打开，读取或失败写入均不改变源树', () => {
    const fixture = createHistoryFixture();
    try {
      const before = snapshotHistoryTree(fixture.root);
      const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        expect(database.prepare('SELECT title FROM conversation_summaries').get()!.title).toBe('只读历史测试');
        expect(() => database.exec("DELETE FROM conversation_summaries")).toThrow(/readonly|read.only/i);
      } finally { database.close(); }
      expect(snapshotHistoryTree(fixture.root)).toEqual(before);
      expect(fixture.decoys).toHaveLength(5);
    } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
  });
});
