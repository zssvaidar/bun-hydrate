import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type Database } from "../src/index";
import { dropTables, engines } from "./engines";

describe.each(engines)("db.afterCommit() on $name", ({ open }) => {
  let db: Database;
  const calls: string[] = [];

  beforeEach(async () => {
    db = open();
    calls.length = 0;
    await dropTables(db, "notes");
    await db.sql`create table notes (id integer primary key)`;
  });

  afterEach(async () => {
    await dropTables(db, "notes");
    await db.close();
  });

  test("runs after the outermost transaction commits, in registration order", async () => {
    await db.transaction(async () => {
      await db.afterCommit(() => void calls.push("first"));
      await db.sql`insert into notes (id) values (1)`;
      await db.afterCommit(() => void calls.push("second"));
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(["first", "second"]);
  });

  test("is dropped when the transaction rolls back", async () => {
    await db
      .transaction(async () => {
        await db.afterCommit(() => void calls.push("never"));
        throw new Error("boom");
      })
      .catch(() => {});
    expect(calls).toEqual([]);
  });

  test("callbacks of a rolled-back savepoint are dropped; the rest run on commit", async () => {
    await db.transaction(async () => {
      await db.afterCommit(() => void calls.push("outer"));
      await db
        .transaction(async () => {
          await db.afterCommit(() => void calls.push("inner, rolled back"));
          throw new Error("inner fails");
        })
        .catch(() => {});
      await db.transaction(async () => {
        await db.afterCommit(() => void calls.push("inner, kept"));
      });
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(["outer", "inner, kept"]);
  });

  test("runs at once outside a transaction", async () => {
    await db.afterCommit(() => void calls.push("now"));
    expect(calls).toEqual(["now"]);
  });
});

test("a failing callback never fails the committed transaction; it is reported", async () => {
  const errors: unknown[] = [];
  const db = createDatabase({ url: "sqlite://:memory:", onAfterCommitError: (error) => void errors.push(error) });
  const result = await db.transaction(async () => {
    await db.afterCommit(() => {
      throw new Error("listener bug");
    });
    return "committed";
  });
  expect(result).toBe("committed");
  expect(errors).toEqual([expect.objectContaining({ message: "listener bug" })]);
  await db.close();
});

describe("SQLite file databases", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hydrate-sqlite-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("use WAL and wait for locks, so a web and a worker process can share the file", async () => {
    const db = createDatabase({ url: `sqlite://${join(dir, "app.sqlite")}` });
    const [{ journal_mode }] = await db.sql`pragma journal_mode`;
    const [{ timeout }] = await db.sql`pragma busy_timeout`;
    expect(journal_mode).toBe("wal");
    expect(timeout).toBe(5000);
    await db.close();
  });
});
