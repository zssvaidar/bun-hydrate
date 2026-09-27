import { Migrator, createDatabase, type Database } from "@bun-hydrate/database";

export interface TestDatabaseOptions {
  /** Directory of SQL migrations to apply. */
  migrations?: string;
}

/** A fresh, isolated in-memory SQLite database with the app's migrations applied. */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<Database> {
  const db = createDatabase({ url: "sqlite://:memory:" });
  if (options.migrations) await new Migrator({ db, directory: options.migrations }).migrate();
  return db;
}
