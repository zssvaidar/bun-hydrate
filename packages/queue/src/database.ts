import type { Database } from "@bun-hydrate/database";
import {
  emptyCounts,
  type ClaimRequest,
  type Completion,
  type EnqueueResult,
  type JobCounts,
  type JobFilter,
  type JobPage,
  type JobRecord,
  type JobState,
  type NewJob,
  type PurgeFilter,
  type QueueAdapter,
} from "./adapter";
import { LEASE_EXPIRED, claimOrder } from "./memory";

/** The `hydrate_jobs` table (spec-6 §5.3). `if not exists`, so a feature can be removed and added again. */
export const JOBS_MIGRATION = `-- migrate:up
create table if not exists hydrate_jobs (
  id varchar(36) primary key,
  queue varchar(64) not null,
  name varchar(200) not null,
  payload text not null,
  state varchar(16) not null,
  priority smallint not null default 0,
  attempt integer not null default 0,
  max_attempts integer not null,
  run_at bigint not null,
  locked_until bigint,
  locked_by varchar(64),
  idempotency_key varchar(255) unique,
  trace_parent varchar(55),
  last_error text,
  created_at bigint not null,
  finished_at bigint
);
create index if not exists hydrate_jobs_claim on hydrate_jobs (queue, state, run_at);
create index if not exists hydrate_jobs_locked on hydrate_jobs (state, locked_until);

-- migrate:down
drop table if exists hydrate_jobs;
`;

interface JobRow {
  id: string;
  queue: string;
  name: string;
  payload: string;
  state: JobState;
  priority: number | string;
  attempt: number | string;
  max_attempts: number | string;
  run_at: number | string | bigint;
  locked_until: number | string | bigint | null;
  locked_by: string | null;
  idempotency_key: string | null;
  trace_parent: string | null;
  last_error: string | null;
  created_at: number | string | bigint;
  finished_at: number | string | bigint | null;
}

const optional = <T>(value: T | null): T | undefined => (value === null ? undefined : value);
const optionalNumber = (value: number | string | bigint | null) => (value === null ? undefined : Number(value));

// Postgres returns bigint columns as strings; every adapter hands out plain numbers.
function toRecord(row: JobRow): JobRecord {
  const record: JobRecord = {
    id: row.id,
    queue: row.queue,
    name: row.name,
    payload: row.payload,
    state: row.state,
    priority: Number(row.priority),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    runAt: Number(row.run_at),
    createdAt: Number(row.created_at),
  };
  const optionalFields = {
    lockedUntil: optionalNumber(row.locked_until),
    lockedBy: optional(row.locked_by),
    idempotencyKey: optional(row.idempotency_key),
    traceParent: optional(row.trace_parent),
    lastError: optional(row.last_error),
    finishedAt: optionalNumber(row.finished_at),
  };
  for (const [key, value] of Object.entries(optionalFields)) if (value !== undefined) Object.assign(record, { [key]: value });
  return record;
}

export interface DatabaseQueueAdapterOptions {
  db: Database;
  /** Close the database with the adapter (when the adapter owns it). Default: false. */
  closeDatabase?: boolean;
}

/**
 * Jobs in the application database (spec-6 §5.3, the default: D1). Every statement goes through
 * `db.sql`, so a job dispatched inside `db.transaction()` commits or rolls back with it.
 */
export class DatabaseQueueAdapter implements QueueAdapter {
  readonly transactional = true;
  private readonly db: Database;

  constructor(private readonly options: DatabaseQueueAdapterOptions) {
    this.db = options.db;
    if (this.db.dialect !== "sqlite" && this.db.dialect !== "postgres") {
      throw new Error(`The database queue supports SQLite and Postgres; ${this.db.dialect} is not supported yet (use the Redis queue)`);
    }
  }

  async enqueue(jobs: readonly NewJob[]): Promise<EnqueueResult[]> {
    const results: EnqueueResult[] = [];
    for (const job of jobs) {
      // "on conflict do nothing" instead of catching a unique violation: in Postgres a failed
      // statement would abort the caller's whole transaction.
      const inserted = await this.db.sql`insert into hydrate_jobs ${this.db.sql({
        id: job.id,
        queue: job.queue,
        name: job.name,
        payload: job.payload,
        state: "pending",
        priority: job.priority,
        attempt: 0,
        max_attempts: job.maxAttempts,
        run_at: job.runAt,
        idempotency_key: job.idempotencyKey ?? null,
        trace_parent: job.traceParent ?? null,
        created_at: job.createdAt,
      })} on conflict do nothing returning id`;
      if (inserted.length > 0) {
        results.push({ id: job.id, deduplicated: false });
        continue;
      }
      const [existing] = await this.db.sql<{ id: string }[]>`select id from hydrate_jobs where idempotency_key = ${job.idempotencyKey ?? null}`;
      if (!existing) throw new Error(`Job ${job.id} could not be stored`);
      results.push({ id: existing.id, deduplicated: true });
    }
    return results;
  }

  async claim({ queues, names, limit, workerId, now, lockedUntil }: ClaimRequest): Promise<JobRecord[]> {
    if (queues.length === 0 || names.length === 0 || limit < 1) return [];
    const { sql } = this.db;
    // Postgres: SKIP LOCKED lets concurrent workers claim different rows without waiting.
    // SQLite has one writer at a time, so the single statement is already atomic.
    const lock = this.db.dialect === "postgres" ? sql`for update skip locked` : sql``;
    const rows = await sql<JobRow[]>`
      update hydrate_jobs
      set state = 'active', attempt = attempt + 1, locked_by = ${workerId}, locked_until = ${lockedUntil}
      where id in (
        select id from hydrate_jobs
        where state = 'pending' and run_at <= ${now} and queue in ${sql(queues)} and name in ${sql(names)}
        order by priority desc, run_at, id
        limit ${limit}
        ${lock}
      )
      returning *`;
    return rows.map(toRecord).sort(claimOrder);
  }

  async renew(ids: readonly string[], workerId: string, lockedUntil: number): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.sql<{ id: string }[]>`
      update hydrate_jobs set locked_until = ${lockedUntil}
      where id in ${this.db.sql(ids)} and locked_by = ${workerId} and state = 'active'
      returning id`;
    return ids.filter((id) => rows.some((row) => row.id === id));
  }

  async complete(id: string, workerId: string, completion: Completion): Promise<boolean> {
    const { sql } = this.db;
    const held = sql`id = ${id} and locked_by = ${workerId} and state = 'active'`;
    let result;
    switch (completion.outcome) {
      case "completed":
        result = completion.keep
          ? await sql`update hydrate_jobs set state = 'completed', finished_at = ${completion.now}, locked_by = null, locked_until = null where ${held}`
          : await sql`delete from hydrate_jobs where ${held}`;
        break;
      case "retry":
        result = await sql`update hydrate_jobs
          set state = 'pending', run_at = ${completion.runAt}, last_error = ${completion.error}, locked_by = null, locked_until = null
          where ${held}`;
        break;
      case "dead":
        result = await sql`update hydrate_jobs
          set state = 'dead', finished_at = ${completion.now}, last_error = ${completion.error}, locked_by = null, locked_until = null
          where ${held}`;
        break;
      case "released":
        result = await sql`update hydrate_jobs
          set state = 'pending', run_at = ${completion.now}, attempt = attempt - 1, locked_by = null, locked_until = null
          where ${held}`;
        break;
    }
    return result.count > 0;
  }

  async requeueExpired(now: number): Promise<number> {
    const { sql } = this.db;
    const expired = sql`state = 'active' and locked_until < ${now}`;
    const dead = await sql`update hydrate_jobs
      set state = 'dead', finished_at = ${now}, last_error = ${LEASE_EXPIRED}, locked_by = null, locked_until = null
      where ${expired} and attempt >= max_attempts`;
    const pending = await sql`update hydrate_jobs
      set state = 'pending', run_at = ${now}, last_error = ${LEASE_EXPIRED}, locked_by = null, locked_until = null
      where ${expired} and attempt < max_attempts`;
    return dead.count + pending.count;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const [row] = await this.db.sql<JobRow[]>`select * from hydrate_jobs where id = ${id}`;
    return row && toRecord(row);
  }

  async list({ state, queue, name, limit = 50, cursor }: JobFilter = {}): Promise<JobPage> {
    const { sql } = this.db;
    const conditions = [
      state && sql`state = ${state}`,
      queue && sql`queue = ${queue}`,
      name && sql`name = ${name}`,
      cursor && sql`id < ${cursor}`,
    ].filter(Boolean);
    const where = conditions.reduce((all, condition) => sql`${all} and ${condition}`, sql`1 = 1`);
    const rows = await sql<JobRow[]>`select * from hydrate_jobs where ${where} order by id desc limit ${limit + 1}`;
    const items = rows.slice(0, limit).map(toRecord);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  async counts(): Promise<JobCounts> {
    const rows = await this.db.sql<{ queue: string; state: JobState; count: number | string }[]>`
      select queue, state, count(*) as count from hydrate_jobs group by queue, state`;
    const counts: JobCounts = {};
    for (const row of rows) (counts[row.queue] ??= emptyCounts())[row.state] = Number(row.count);
    return counts;
  }

  async retry(ids: readonly string[], now: number): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db.sql`update hydrate_jobs
      set state = 'pending', attempt = 0, run_at = ${now}, finished_at = null
      where id in ${this.db.sql(ids)} and state = 'dead'`;
    return result.count;
  }

  async purge({ state, finishedBefore }: PurgeFilter): Promise<number> {
    const result = await this.db.sql`delete from hydrate_jobs where state = ${state} and finished_at < ${finishedBefore}`;
    return result.count;
  }

  async close(): Promise<void> {
    if (this.options.closeDatabase) await this.db.close();
  }
}
