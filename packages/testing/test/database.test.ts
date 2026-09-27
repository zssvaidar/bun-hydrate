import { describe, expect, test } from "bun:test";
import { createTestDatabase } from "../src/database";

const migrations = `${import.meta.dir}/fixtures/migrations`;

describe("createTestDatabase", () => {
  test("returns an in-memory SQLite database with the migrations applied", async () => {
    const db = await createTestDatabase({ migrations });

    await db.sql`insert into notes ${db.sql({ id: 1, body: "hello" })}`;
    expect(await db.sql<{ body: string }[]>`select body from notes`).toEqual([{ body: "hello" }]);
    expect(db.dialect).toBe("sqlite");
    await db.close();
  });

  test("every database is isolated", async () => {
    const first = await createTestDatabase({ migrations });
    const second = await createTestDatabase({ migrations });

    await first.sql`insert into notes ${first.sql({ id: 1, body: "only in first" })}`;
    expect(await second.sql<unknown[]>`select * from notes`).toEqual([]);
    await Promise.all([first.close(), second.close()]);
  });

  test("works without migrations", async () => {
    const db = await createTestDatabase();
    expect(await db.ping()).toBe(true);
    await db.close();
  });
});
