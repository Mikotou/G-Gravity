import { DatabaseSync } from 'node:sqlite';
import {
  SWARM_PAGE_SIZE, swarmMessageMentions, type SwarmActionEvent, type SwarmBoardMessage,
  type SwarmHistoryCursor, type SwarmTopologyState, type SwarmWorkerNode,
} from '../../shared/swarm-contract';
type Row = Record<string, unknown>;
function decode<T>(row?: Row): T | undefined {
  if (!row) return;
  const value = JSON.parse(String(row.data));
  value.rowId = Number(row.row_id);
  return value;
}

/** All queries run inside the archive transaction of one session. Pagination uses stable insertion keys. */
export class SwarmSessionLog {
  readonly changedWorkers = new Map<number, SwarmWorkerNode>();
  replaying = false;
  constructor(
    readonly database: DatabaseSync,
    readonly sessionId: string
  ) {}
  ensure(): void {
    this.database.prepare('INSERT OR IGNORE INTO sessions(sid) VALUES (?)').run(this.sessionId);
  }
  touch(now: string): void {
    this.database.prepare('UPDATE sessions SET updated=? WHERE sid=?').run(now, this.sessionId);
  }
  title(): string {
    return String(
      this.database.prepare('SELECT title FROM sessions WHERE sid=?').get(this.sessionId)?.title || ''
    );
  }
  setTitle(title: string): void {
    this.database.prepare('UPDATE sessions SET title=? WHERE sid=?').run(title, this.sessionId);
  }
  seen(id: string): boolean {
    return !!this.database.prepare('SELECT 1 FROM calls WHERE sid=? AND id=?').get(this.sessionId, id);
  }
  markSeen(id: string): void {
    this.database.prepare('INSERT OR IGNORE INTO calls VALUES (?,?)').run(this.sessionId, id);
  }
  checked(): boolean {
    return !!this.database.prepare('SELECT checked FROM sessions WHERE sid=?').get(this.sessionId)?.checked;
  }
  markChecked(): void {
    this.ensure();
    this.database.prepare('UPDATE sessions SET checked=1 WHERE sid=?').run(this.sessionId);
  }
  byId(id: string): SwarmWorkerNode | undefined {
    return decode(
      this.database
        .prepare('SELECT row_id,data FROM workers WHERE sid=? AND identity=?')
        .get(this.sessionId, id)
    );
  }
  byName(name: string): SwarmWorkerNode | undefined {
    const rows = this.database
      .prepare('SELECT row_id,data FROM workers WHERE sid=? AND name=? LIMIT 2')
      .all(this.sessionId, name);
    return rows.length === 1 ? decode(rows[0]) : undefined;
  }
  member(value: string): SwarmWorkerNode | undefined {
    return value ? this.byId(value) || this.byName(value) : undefined;
  }
  matching(field: 'status' | 'kind', value: string): SwarmWorkerNode[] {
    return this.database
      .prepare('SELECT row_id,data FROM workers WHERE sid=? AND ' + field + '=?')
      .all(this.sessionId, value)
      .map((row) => decode<SwarmWorkerNode>(row)!);
  }
  put(worker: SwarmWorkerNode): void {
    const { rowId, ...data } = worker;
    const args = [data.id, data.name, data.status, data.kind, JSON.stringify(data)];
    const id =
      rowId ??
      Number(
        this.database
          .prepare('INSERT INTO workers(identity,name,status,kind,data,sid) VALUES (?,?,?,?,?,?)')
          .run(...args, this.sessionId).lastInsertRowid
      );
    if (rowId !== undefined)
      this.database
        .prepare('UPDATE workers SET identity=?,name=?,status=?,kind=?,data=? WHERE row_id=? AND sid=?')
        .run(...args, id, this.sessionId);
    this.changedWorkers.set(id, { ...data, rowId: id });
  }
  addEvent(event: SwarmActionEvent, legacy = false): void {
    if (this.replaying) {
      const match = this.database
        .prepare(
          "SELECT row_id FROM events WHERE sid=? AND legacy=1 AND json_extract(data,'$.eventType')=? AND json_extract(data,'$.actorName')=? AND json_extract(data,'$.summaryZh')=? ORDER BY row_id LIMIT 1"
        )
        .get(this.sessionId, event.eventType, event.actorName, event.summaryZh);
      if (match) {
        this.database.prepare('UPDATE events SET legacy=0 WHERE row_id=?').run(match.row_id);
        return;
      }
    }
    this.database
      .prepare('INSERT INTO events(sid,legacy,data) VALUES (?,?,?)')
      .run(this.sessionId, Number(legacy), JSON.stringify(event));
  }
  nextSeq(): number {
    return (
      Number(this.database.prepare('SELECT MAX(seq) AS n FROM board WHERE sid=?').get(this.sessionId)?.n || 0) +
      1
    );
  }
  private mergeBoardMentions(row: Row | undefined, item: SwarmBoardMessage): void {
    if (!row || !item.mentions.length) return;
    const stored = decode<SwarmBoardMessage>(row);
    if (!stored || stored.content !== item.content) return;
    const previous = swarmMessageMentions('', stored.mentions);
    const merged = new Set([...previous, ...item.mentions]);
    if (merged.size !== previous.length) this.database.prepare(
      "UPDATE board SET data=json_set(data,'$.mentions',json(?)) WHERE sid=? AND row_id=?"
    ).run(JSON.stringify([...merged]), this.sessionId, Number(row.row_id));
  }
  alreadyRead(item: SwarmBoardMessage, sourceId: string, timestamp: string, occurrence: number): boolean {
    const byContent = "SELECT row_id,data FROM board WHERE sid=? AND sender=? AND channel=? AND content=? AND (?='' OR json_extract(data,'$.timestamp')=?) ORDER BY row_id";
    const args = [this.sessionId, item.sender, item.channel, item.content, timestamp, timestamp];
    if (sourceId) {
      const source = JSON.stringify([item.sender, item.channel, sourceId]);
      const known = !this.database
        .prepare('INSERT OR IGNORE INTO board_sources VALUES (?,?)')
        .run(this.sessionId, source).changes;
      if (known && item.mentions.length) {
        const matches = this.database.prepare(byContent + ' LIMIT 2').all(...args);
        if (matches.length === 1) this.mergeBoardMentions(matches[0], item);
      }
      return known;
    }
    const row = this.database.prepare(byContent + ' LIMIT 1 OFFSET ?').get(...args, occurrence);
    this.mergeBoardMentions(row, item);
    return !!row;
  }
  addBoard(item: SwarmBoardMessage, official: boolean, legacy = false, replay = false): boolean {
    if (replay) {
      const match = this.database
        .prepare(
          'SELECT row_id,data FROM board WHERE sid=? AND sender=? AND channel=? AND content=? AND legacy=1 AND (? IS NULL OR seq=?) ORDER BY row_id LIMIT 1'
        )
        .get(this.sessionId, item.sender, item.channel, item.content, official ? item.seq : null, item.seq);
      if (match) {
        this.mergeBoardMentions(match, item);
        this.database.prepare('UPDATE board SET legacy=0 WHERE row_id=?').run(match.row_id);
        return false;
      }
    }
    const result = this.database
      .prepare(
        'INSERT OR IGNORE INTO board(sid,sender,channel,seq,official_seq,content,legacy,data) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        this.sessionId,
        item.sender,
        item.channel,
        item.seq,
        official ? item.seq : null,
        item.content,
        Number(legacy),
        JSON.stringify(item)
      );
    if (result.changes)
      this.database.prepare('INSERT OR IGNORE INTO channels VALUES (?,?)').run(this.sessionId, item.channel);
    else if (official && item.mentions.length)
      this.mergeBoardMentions(this.database.prepare(
        'SELECT row_id,data FROM board WHERE sid=? AND sender=? AND channel=? AND official_seq=?'
      ).get(this.sessionId, item.sender, item.channel, item.seq), item);
    return !!result.changes;
  }
  state(before?: SwarmHistoryCursor): SwarmTopologyState {
    const page = <T>(table: 'workers' | 'board' | 'events', cursor: number | null | undefined) => {
      if (cursor === null) return { items: [] as T[], earlier: null };
      if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1))
        throw Error('无效的 Swarm 历史位置');
      const rows = this.database
        .prepare('SELECT row_id,data FROM ' + table + ' WHERE sid=? AND row_id<? ORDER BY row_id DESC LIMIT ?')
        .all(this.sessionId, cursor ?? Number.MAX_SAFE_INTEGER, SWARM_PAGE_SIZE + 1);
      const more = rows.length > SWARM_PAGE_SIZE;
      if (more) rows.pop();
      rows.reverse();
      return { items: rows.map((row) => decode<T>(row)!), earlier: more ? Number(rows[0].row_id) : null };
    };
    const workerPage = page<SwarmWorkerNode>('workers', before?.workers);
    const boardPage = page<SwarmBoardMessage>('board', before?.boardMessages);
    const eventPage = page<SwarmActionEvent>('events', before?.actionTimeline);
    const header = this.database.prepare('SELECT title,updated FROM sessions WHERE sid=?').get(this.sessionId);
    const stats = { total: 0, working: 0, waiting: 0, completed: 0, killed: 0 };
    for (const row of this.database
      .prepare('SELECT status,n FROM worker_counts WHERE sid=?')
      .all(this.sessionId)) {
      const status = String(row.status);
      stats.total += Number(row.n);
      if (status === 'working' || status === 'waiting' || status === 'completed' || status === 'killed')
        stats[status] = Number(row.n);
    }
    return {
      sessionId: this.sessionId,
      swarmTitle: String(header?.title || ''),
      isActive: !!header?.updated,
      workers: workerPage.items,
      boardMessages: boardPage.items,
      actionTimeline: eventPage.items,
      earlier: {
        workers: workerPage.earlier,
        boardMessages: boardPage.earlier,
        actionTimeline: eventPage.earlier,
      },
      stats,
      channels: this.database
        .prepare('SELECT name FROM channels WHERE sid=? ORDER BY rowid')
        .all(this.sessionId)
        .map((row) => String(row.name)),
      updatedAt: String(header?.updated || ''),
    };
  }
}
