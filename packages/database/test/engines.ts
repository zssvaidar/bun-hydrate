import { createDatabase, type Database } from "../src/index";

export interface Engine {
  name: string;
  open: () => Database;
}

/** SQLite always; Postgres too when TEST_POSTGRES_URL points at a disposable database. */
export const engines: Engine[] = [
  { name: "sqlite", open: () => createDatabase({ url: "sqlite://:memory:" }) },
  ...(process.env.TEST_POSTGRES_URL
    ? [{ name: "postgres", open: () => createDatabase({ url: process.env.TEST_POSTGRES_URL! }) }]
    : []),
];

export async function dropTables(db: Database, ...tables: string[]) {
  for (const table of tables) await db.sql.unsafe(`drop table if exists ${table}`);
}
