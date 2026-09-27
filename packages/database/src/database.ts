import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQL, type TransactionSQL } from "bun";
import { instrumentSql, type QueryObserver } from "./instrument";

export type Dialect = "postgres" | "mysql" | "sqlite";

export interface DatabaseOptions {
  /** postgres://…, mysql://…, sqlite://path or sqlite://:memory: */
  url: string;
  /** Maximum pool size (Postgres/MySQL). */
  max?: number;
  /** Called after every query made through `db.sql` (not `db.raw`), e.g. for duration metrics. */
  onQuery?: QueryObserver;
  /** Receives errors thrown by `afterCommit` callbacks (the commit has already happened). Default: console.error. */
  onAfterCommitError?: (error: unknown) => void;
}

type AfterCommit = () => unknown;

/** A running transaction or savepoint, with the callbacks to run once everything commits. */
interface ActiveTransaction {
  sql: SQL;
  afterCommit: AfterCommit[];
}

export function dialectOf(url: string): Dialect {
  const scheme = url.split(":")[0]!.toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") return "postgres";
  if (scheme === "mysql") return "mysql";
  if (scheme === "sqlite" || scheme === "file") return "sqlite";
  // Only the scheme is echoed: the rest of a database URL usually holds credentials.
  throw new Error(`Unsupported database URL "${scheme}://…": use postgres://, mysql:// or sqlite://`);
}

/**
 * A thin layer over Bun.SQL (spec-4 §4). `db.sql` is transaction-aware: inside
 * `db.transaction()` it is the transaction, so repositories never need a `tx` parameter.
 */
export class Database implements AsyncDisposable {
  readonly dialect: Dialect;
  /** The underlying Bun.SQL client — the escape hatch for anything this class doesn't cover. */
  readonly raw: SQL;
  private readonly activeTransaction = new AsyncLocalStorage<ActiveTransaction>();
  private readonly onQuery: QueryObserver | undefined;
  private readonly onAfterCommitError: (error: unknown) => void;
  private readonly instrumented = new WeakMap<SQL, SQL>();

  constructor(options: DatabaseOptions) {
    this.dialect = dialectOf(options.url);
    this.onQuery = options.onQuery;
    this.onAfterCommitError = options.onAfterCommitError ?? ((error) => console.error("afterCommit callback failed", error));
    if (this.dialect === "sqlite") ensureSqliteDirectory(options.url);
    this.raw = new SQL(options.url, options.max === undefined ? {} : { max: options.max });
    if (this.dialect === "sqlite") {
      // SQLite ignores foreign keys unless each connection opts in. Started immediately so they
      // run before any query issued after construction (SQLite uses one connection).
      void this.raw.unsafe("PRAGMA foreign_keys = ON").execute();
      if (isSqliteFile(options.url)) {
        // Web and worker processes share the file (spec-6 §5.3): readers don't block the writer,
        // and a writer waits for the lock instead of failing at once with SQLITE_BUSY.
        void this.raw.unsafe("PRAGMA journal_mode = WAL").execute();
        void this.raw.unsafe("PRAGMA busy_timeout = 5000").execute();
      }
    }
  }

  /** The current transaction if called inside `transaction()`, otherwise the pool. */
  get sql(): SQL {
    return this.observed(this.activeTransaction.getStore()?.sql ?? this.raw);
  }

  /**
   * Commits if `work` resolves, rolls back if it throws (and rethrows). Called inside another
   * transaction, it becomes a savepoint, so an inner failure only undoes the inner block.
   */
  async transaction<T>(work: (tx: SQL) => Promise<T>): Promise<T> {
    const outer = this.activeTransaction.getStore();
    const afterCommit: AfterCommit[] = [];
    const run = (tx: SQL) => this.activeTransaction.run({ sql: tx, afterCommit }, () => work(this.observed(tx)));

    if (outer) {
      const result = (await (outer.sql as TransactionSQL).savepoint(run)) as T;
      outer.afterCommit.push(...afterCommit); // the savepoint held: its callbacks wait for the outer commit
      return result;
    }
    const result = (await this.raw.begin(run)) as T;
    await this.runAfterCommit(afterCommit);
    return result;
  }

  /**
   * Runs `callback` once the outermost transaction commits, or right away outside one. Dropped if
   * the transaction (or the savepoint it was registered in) rolls back. Errors are reported to
   * `onAfterCommitError`, never thrown: the data is already committed.
   */
  async afterCommit(callback: AfterCommit): Promise<void> {
    const active = this.activeTransaction.getStore();
    if (active) active.afterCommit.push(callback);
    else await this.runAfterCommit([callback]);
  }

  private async runAfterCommit(callbacks: AfterCommit[]): Promise<void> {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        this.onAfterCommitError(error);
      }
    }
  }

  private observed(sql: SQL): SQL {
    if (!this.onQuery) return sql;
    let wrapped = this.instrumented.get(sql);
    if (!wrapped) this.instrumented.set(sql, (wrapped = instrumentSql(sql, this.onQuery)));
    return wrapped;
  }

  /** For readiness checks: true if the database answers. */
  async ping(): Promise<boolean> {
    try {
      await this.raw`select 1`;
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.raw.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** The file path of a SQLite URL, or undefined for an in-memory database. */
function sqlitePath(url: string): string | undefined {
  const path = url.replace(/^(sqlite|file):(\/\/)?/i, "").split("?")[0]!;
  return path === "" || path === ":memory:" ? undefined : path;
}

function isSqliteFile(url: string): boolean {
  return sqlitePath(url) !== undefined;
}

/** SQLite can create the file but not its directory, and says only "unable to open database file". */
function ensureSqliteDirectory(url: string): void {
  const path = sqlitePath(url);
  if (path) mkdirSync(dirname(path), { recursive: true });
}

export function createDatabase(options: DatabaseOptions): Database {
  return new Database(options);
}
