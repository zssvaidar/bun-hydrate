import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQL, type TransactionSQL } from "bun";

export type Dialect = "postgres" | "mysql" | "sqlite";

export interface DatabaseOptions {
  /** postgres://…, mysql://…, sqlite://path or sqlite://:memory: */
  url: string;
  /** Maximum pool size (Postgres/MySQL). */
  max?: number;
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
  private readonly activeTransaction = new AsyncLocalStorage<SQL>();

  constructor(options: DatabaseOptions) {
    this.dialect = dialectOf(options.url);
    if (this.dialect === "sqlite") ensureSqliteDirectory(options.url);
    this.raw = new SQL(options.url, options.max === undefined ? {} : { max: options.max });
    if (this.dialect === "sqlite") {
      // SQLite ignores foreign keys unless each connection opts in. Started immediately so it
      // runs before any query issued after construction (SQLite uses one connection).
      void this.raw.unsafe("PRAGMA foreign_keys = ON").execute();
    }
  }

  /** The current transaction if called inside `transaction()`, otherwise the pool. */
  get sql(): SQL {
    return this.activeTransaction.getStore() ?? this.raw;
  }

  /**
   * Commits if `work` resolves, rolls back if it throws (and rethrows). Called inside another
   * transaction, it becomes a savepoint, so an inner failure only undoes the inner block.
   */
  transaction<T>(work: (tx: SQL) => Promise<T>): Promise<T> {
    const run = (tx: SQL) => this.activeTransaction.run(tx, () => work(tx));
    const outer = this.activeTransaction.getStore() as TransactionSQL | undefined;
    return (outer ? outer.savepoint(run) : this.raw.begin(run)) as Promise<T>;
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

/** SQLite can create the file but not its directory, and says only "unable to open database file". */
function ensureSqliteDirectory(url: string): void {
  const path = url.replace(/^(sqlite|file):(\/\/)?/i, "").split("?")[0]!;
  if (path === "" || path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true });
}

export function createDatabase(options: DatabaseOptions): Database {
  return new Database(options);
}
