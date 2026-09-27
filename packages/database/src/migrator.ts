import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "./database";

export interface MigratorOptions {
  db: Database;
  directory: string;
  /** Injectable clock for `create()`. */
  now?: () => Date;
}

export interface AppliedMigration {
  name: string;
  batch: number;
  appliedAt: string;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: string[];
  /** Recorded as applied, but the file no longer exists — usually a branch mix-up. */
  missing: string[];
}

export interface ParsedMigration {
  up: string;
  down: string | undefined;
}

const UP_MARKER = /^--\s*migrate:up\s*$/im;
const DOWN_MARKER = /^--\s*migrate:down\s*$/im;
const TABLE = "hydrate_migrations";
/** Arbitrary but fixed: every instance must contend for the same Postgres advisory lock. */
const POSTGRES_LOCK_KEY = 7_243_981_022;

export function parseMigration(name: string, text: string): ParsedMigration {
  const up = UP_MARKER.exec(text);
  if (!up) throw new Error(`Migration ${name} has no \`-- migrate:up\` section`);

  const afterUp = text.slice(up.index + up[0].length);
  const down = DOWN_MARKER.exec(afterUp);
  const upSql = (down ? afterUp.slice(0, down.index) : afterUp).trim();
  const downSql = down ? afterUp.slice(down.index + down[0].length).trim() : "";
  return { up: upSql, down: downSql === "" ? undefined : downSql };
}

/** Plain-SQL migrations tracked in `hydrate_migrations` (spec-4 §4.4). */
export class Migrator {
  private readonly db: Database;
  private readonly directory: string;
  private readonly now: () => Date;

  constructor(options: MigratorOptions) {
    this.db = options.db;
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
  }

  /** Writes an empty migration named `<UTC timestamp>_<name>.sql` and returns its path. */
  async create(name: string): Promise<string> {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!slug) throw new Error(`"${name}" is not a usable migration name`);

    const timestamp = this.now().toISOString().replace(/\D/g, "").slice(0, 14);
    const path = join(this.directory, `${timestamp}_${slug}.sql`);
    await mkdir(this.directory, { recursive: true });
    await Bun.write(path, "-- migrate:up\n\n\n-- migrate:down\n\n");
    return path;
  }

  /** Applies every pending migration, in name order, as one batch. Each file runs in its own transaction. */
  migrate(): Promise<string[]> {
    return this.exclusive(async () => {
      const applied = new Set((await this.appliedMigrations()).map((migration) => migration.name));
      const pending = (await this.migrationFiles()).filter((name) => !applied.has(name));
      const batch = (await this.lastBatch()) + 1;

      for (const name of pending) {
        const { up } = parseMigration(name, await this.read(name));
        await this.run(name, async () => {
          if (up) await this.db.sql.unsafe(up);
          await this.db.sql`insert into ${this.db.sql(TABLE)} ${this.db.sql({
            name,
            batch,
            applied_at: new Date().toISOString(),
          })}`;
        });
      }
      return pending;
    });
  }

  /** Undoes the last batch, or the last `steps` migrations regardless of batch. */
  rollback(options: { steps?: number } = {}): Promise<string[]> {
    return this.exclusive(async () => {
      const newestFirst = (await this.appliedMigrations()).reverse();
      const lastBatch = newestFirst[0]?.batch;
      const targets =
        options.steps === undefined
          ? newestFirst.filter((migration) => migration.batch === lastBatch)
          : newestFirst.slice(0, options.steps);

      for (const { name } of targets) {
        const { down } = parseMigration(name, await this.read(name));
        if (!down) throw new Error(`Migration ${name} has no \`-- migrate:down\` section and cannot be rolled back`);
        await this.run(name, async () => {
          await this.db.sql.unsafe(down);
          await this.db.sql`delete from ${this.db.sql(TABLE)} where name = ${name}`;
        });
      }
      return targets.map((migration) => migration.name);
    });
  }

  async status(): Promise<MigrationStatus> {
    await this.ensureTable();
    const applied = await this.appliedMigrations();
    const files = await this.migrationFiles();
    const appliedNames = new Set(applied.map((migration) => migration.name));
    const fileNames = new Set(files);

    return {
      applied,
      pending: files.filter((name) => !appliedNames.has(name)),
      missing: applied.map((migration) => migration.name).filter((name) => !fileNames.has(name)),
    };
  }

  private async run(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await this.db.transaction(work);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${name} failed: ${reason}`, { cause: error });
    }
  }

  /** On Postgres, holds an advisory lock so concurrently starting instances migrate one at a time. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.db.dialect !== "postgres") {
      await this.ensureTable();
      return work();
    }

    const connection = await this.db.raw.reserve();
    try {
      await connection`select pg_advisory_lock(${POSTGRES_LOCK_KEY})`;
      await this.ensureTable();
      return await work();
    } finally {
      await connection`select pg_advisory_unlock(${POSTGRES_LOCK_KEY})`;
      connection.release();
    }
  }

  private async ensureTable(): Promise<void> {
    await this.db.sql.unsafe(
      `create table if not exists ${TABLE} (name varchar(255) primary key, batch integer not null, applied_at varchar(32) not null)`,
    );
  }

  private async appliedMigrations(): Promise<AppliedMigration[]> {
    const rows: { name: string; batch: number; applied_at: string }[] = await this.db.sql`
      select name, batch, applied_at from ${this.db.sql(TABLE)} order by batch, name`;
    return rows.map((row) => ({ name: row.name, batch: Number(row.batch), appliedAt: row.applied_at }));
  }

  private async lastBatch(): Promise<number> {
    const [row] = await this.db.sql`select max(batch) as batch from ${this.db.sql(TABLE)}`;
    return Number(row?.batch ?? 0);
  }

  private async migrationFiles(): Promise<string[]> {
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    return entries
      .filter((file) => file.endsWith(".sql"))
      .map((file) => file.slice(0, -".sql".length))
      .sort();
  }

  private async read(name: string): Promise<string> {
    const file = Bun.file(join(this.directory, `${name}.sql`));
    if (!(await file.exists())) throw new Error(`Migration file ${name}.sql not found in ${this.directory}`);
    return file.text();
  }
}
