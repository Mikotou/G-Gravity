import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ClientStore } from '../storage/client-store';
import { SwarmSessionLog } from './swarm-session-log';
import { importLegacy } from './swarm-legacy-migration';
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter(Boolean) : []);
const schema = `
  CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS workers(row_id INTEGER PRIMARY KEY, sid TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE, identity TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(sid,identity));
  CREATE INDEX IF NOT EXISTS worker_page ON workers(sid,row_id);
  CREATE INDEX IF NOT EXISTS worker_name ON workers(sid,name);
  CREATE INDEX IF NOT EXISTS worker_status ON workers(sid,status);
  CREATE TABLE IF NOT EXISTS worker_counts(sid TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE, status TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(sid,status));
  CREATE TRIGGER IF NOT EXISTS worker_add AFTER INSERT ON workers BEGIN
    INSERT INTO worker_counts VALUES (NEW.sid,NEW.status,1) ON CONFLICT(sid,status) DO UPDATE SET n=n+1;
  END;
  CREATE TRIGGER IF NOT EXISTS worker_change AFTER UPDATE OF status ON workers WHEN OLD.status!=NEW.status BEGIN
    UPDATE worker_counts SET n=n-1 WHERE sid=OLD.sid AND status=OLD.status;
    INSERT INTO worker_counts VALUES (NEW.sid,NEW.status,1) ON CONFLICT(sid,status) DO UPDATE SET n=n+1;
  END;
  CREATE TABLE IF NOT EXISTS board(row_id INTEGER PRIMARY KEY, sid TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE, sender TEXT NOT NULL, channel TEXT NOT NULL, seq INTEGER NOT NULL, official_seq INTEGER, content TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, UNIQUE(sid,sender,channel,official_seq));
  CREATE INDEX IF NOT EXISTS board_page ON board(sid,row_id);
  CREATE INDEX IF NOT EXISTS board_seq ON board(sid,seq);
  CREATE INDEX IF NOT EXISTS board_legacy ON board(sid,sender,channel,legacy);
  CREATE TABLE IF NOT EXISTS board_sources(sid TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE, source_id TEXT NOT NULL, PRIMARY KEY(sid,source_id));
  CREATE TABLE IF NOT EXISTS channels(sid TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE, name TEXT NOT NULL, PRIMARY KEY(sid,name));
  CREATE TABLE IF NOT EXISTS events(row_id INTEGER PRIMARY KEY, sid TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE, legacy INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS event_page ON events(sid,row_id);
  CREATE INDEX IF NOT EXISTS legacy_event ON events(sid,legacy);
  CREATE TABLE IF NOT EXISTS calls(sid TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(sid,id));
  CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY);
`;
export class SwarmArchive {
  private database?: DatabaseSync;
  private busyTimeout = 3000;
  withoutLockWait<T>(operation: () => T): T {
    const previous = this.busyTimeout;
    this.busyTimeout = 0;
    try { this.database?.exec('PRAGMA busy_timeout=0'); return operation(); }
    finally {
      this.busyTimeout = previous;
      this.database?.exec('PRAGMA busy_timeout=' + previous);
    }
  }
  private readonly file?: string;
  constructor(
    private store?: ClientStore,
    private profile?: string,
    private owned?: ReadonlySet<string>
  ) {
    if (store)
      this.file = join(
        store.dataDir,
        'swarm-v2-' +
          createHash('sha256')
            .update(profile || '')
            .digest('hex') +
          '.sqlite'
      );
  }
  private open<T>(operation: (database: DatabaseSync) => T): T {
    if (!this.database) {
      const db = new DatabaseSync(this.file || ':memory:');
      try {
        db.exec('PRAGMA busy_timeout=' + this.busyTimeout + '; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(schema);
          if (!db.prepare("SELECT 1 FROM metadata WHERE key='legacy-imported'").get()) {
            importLegacy(db, this.store, this.profile, this.owned);
            db.prepare("INSERT INTO metadata VALUES ('legacy-imported')").run();
          }
          db.exec("UPDATE workers SET status='unconfirmed',data=json_remove(json_set(data,'$.status','unconfirmed'),'$.currentAction','$.currentCallId') WHERE status='working'");
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        this.database = db;
      } catch (error) {
        db.close();
        throw error;
      }
    }
    return operation(this.database);
  }
  read<T>(sessionId: string, operation: (log: SwarmSessionLog) => T): T {
    return this.open((database) => operation(new SwarmSessionLog(database, sessionId)));
  }
  write<T>(sessionId: string, operation: (log: SwarmSessionLog) => T): T {
    return this.open((database) => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = operation(new SwarmSessionLog(database, sessionId));
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });
  }
  remove(sessionId: string): void {
    this.write(sessionId, (log) => log.database.prepare('DELETE FROM sessions WHERE sid=?').run(sessionId));
    if (!this.store) return;
    const name = this.profile ? 'swarm-states-' + this.profile + '.json' : 'swarm-states.json';
    const files = new Set([name]);
    const ambiguous = list<string>(this.store.read('swarm-legacy-ambiguous-v2.json', []));
    if (
      (!this.profile || this.owned?.has(sessionId) || this.profile === 'default') &&
      !ambiguous.includes(sessionId)
    ) {
      files.add('swarm-states.json');
    }
    for (const file of files) {
      const data = this.store.read<Record<string, unknown> | null>(file, null);
      if (data && Object.hasOwn(data, sessionId)) {
        delete data[sessionId];
        this.store.write(file, data);
      }
    }
  }
  close(): void {
    this.database?.close();
    this.database = undefined;
  }

}
