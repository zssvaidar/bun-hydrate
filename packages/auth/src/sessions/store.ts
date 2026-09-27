import type { Cache } from "@bun-hydrate/cache";
import type { Database } from "@bun-hydrate/database";

/** Timestamps are epoch milliseconds. `idHash` is SHA-256 of the cookie value, never the value itself. */
export interface SessionRecord {
  idHash: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  /** Absolute expiry, regardless of activity. */
  expiresAt: number;
  userAgent?: string;
  ip?: string;
}

export interface SessionStore {
  insert(record: SessionRecord): Promise<void>;
  find(idHash: string): Promise<SessionRecord | undefined>;
  touch(idHash: string, lastSeenAt: number): Promise<void>;
  delete(idHash: string): Promise<void>;
  /** Optional: stores that cannot enumerate a user's sessions leave it out. */
  deleteAllFor?(userId: string): Promise<number>;
  /** Optional: deletes sessions past `now`, or last seen before `idleBefore`. Stores whose entries expire on their own leave it out. */
  deleteExpired?(now: number, idleBefore: number): Promise<number>;
}

/** Portable across SQLite, Postgres and MySQL; bigint because epoch milliseconds overflow int4. */
export const SESSIONS_MIGRATION = `-- migrate:up
create table sessions (
  id_hash varchar(64) primary key,
  user_id varchar(64) not null,
  created_at bigint not null,
  last_seen_at bigint not null,
  expires_at bigint not null,
  user_agent varchar(512),
  ip varchar(64)
);
create index sessions_user_id on sessions (user_id);

-- migrate:down
drop table sessions;
`;

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number | bigint | string;
  last_seen_at: number | bigint | string;
  expires_at: number | bigint | string;
  user_agent: string | null;
  ip: string | null;
}

export class DatabaseSessionStore implements SessionStore {
  constructor(private readonly db: Database) {}

  async insert(record: SessionRecord): Promise<void> {
    await this.db.sql`insert into sessions ${this.db.sql({
      id_hash: record.idHash,
      user_id: record.userId,
      created_at: record.createdAt,
      last_seen_at: record.lastSeenAt,
      expires_at: record.expiresAt,
      user_agent: record.userAgent?.slice(0, 512) ?? null,
      ip: record.ip ?? null,
    })}`;
  }

  async find(idHash: string): Promise<SessionRecord | undefined> {
    const [row] = await this.db.sql<SessionRow[]>`select * from sessions where id_hash = ${idHash}`;
    return row && {
      idHash: row.id_hash,
      userId: row.user_id,
      // Postgres returns bigint columns as strings or BigInts depending on size.
      createdAt: Number(row.created_at),
      lastSeenAt: Number(row.last_seen_at),
      expiresAt: Number(row.expires_at),
      userAgent: row.user_agent ?? undefined,
      ip: row.ip ?? undefined,
    };
  }

  async touch(idHash: string, lastSeenAt: number): Promise<void> {
    await this.db.sql`update sessions set last_seen_at = ${lastSeenAt} where id_hash = ${idHash}`;
  }

  async delete(idHash: string): Promise<void> {
    await this.db.sql`delete from sessions where id_hash = ${idHash}`;
  }

  async deleteAllFor(userId: string): Promise<number> {
    const result = await this.db.sql`delete from sessions where user_id = ${userId}`;
    return result.count;
  }

  async deleteExpired(now: number, idleBefore: number): Promise<number> {
    const result = await this.db.sql`delete from sessions where expires_at <= ${now} or last_seen_at < ${idleBefore}`;
    return result.count;
  }
}

/** Sessions in any Cache (memory in tests, Redis in production). Entries expire with the session. */
export class CacheSessionStore implements SessionStore {
  private readonly cache: Cache;

  constructor(cache: Cache, private readonly now: () => number = Date.now) {
    this.cache = cache.namespace("session:");
  }

  async insert(record: SessionRecord): Promise<void> {
    await this.cache.set(record.idHash, record, this.ttlSeconds(record));
  }

  async find(idHash: string): Promise<SessionRecord | undefined> {
    return (await this.cache.get<SessionRecord>(idHash)) ?? undefined;
  }

  async touch(idHash: string, lastSeenAt: number): Promise<void> {
    const record = await this.find(idHash);
    if (record) await this.insert({ ...record, lastSeenAt });
  }

  delete(idHash: string): Promise<void> {
    return this.cache.delete(idHash);
  }

  private ttlSeconds(record: SessionRecord): number {
    return Math.max(1, Math.ceil((record.expiresAt - this.now()) / 1000));
  }
}
