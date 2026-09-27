import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database, type QueryEvent } from "../src/index";

let db: Database;
let events: QueryEvent[];

beforeEach(async () => {
  events = [];
  db = createDatabase({ url: "sqlite://:memory:", onQuery: (event) => void events.push(event) });
  await db.raw`create table items (id integer primary key, label text not null)`;
});

afterEach(() => db.close());

const operations = () => events.map((event) => event.operation);

describe("query instrumentation (onQuery)", () => {
  test("tagged-template queries report their operation and duration", async () => {
    await db.sql`insert into items ${db.sql({ id: 1, label: "a" })}`;
    await db.sql`select * from items`;
    await db.sql`update items set label = ${"b"} where id = ${1}`;
    await db.sql`delete from items where id = ${1}`;

    expect(operations()).toEqual(["insert", "select", "update", "delete"]);
    expect(events.every((event) => event.durationMs >= 0 && event.failed === false)).toBe(true);
  });

  test("results are unchanged, including helpers and modifiers", async () => {
    await db.sql`insert into items ${db.sql([{ id: 1, label: "a" }, { id: 2, label: "b" }])}`;

    expect(await db.sql<{ label: string }[]>`select label from items order by id`).toEqual([{ label: "a" }, { label: "b" }]);
    expect(await db.sql`select label from items order by id`.values()).toEqual([["a"], ["b"]]);
  });

  test("unsafe queries are timed too", async () => {
    await db.sql.unsafe("select 1");
    expect(operations()).toEqual(["select"]);
  });

  test("failed queries are reported as failed and still throw", async () => {
    // Not expect(...).rejects: Bun's SQL queries are lazy and only run when .then() is called.
    const error = await db.sql`select * from missing_table`.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(events).toEqual([expect.objectContaining({ operation: "select", failed: true })]);
  });

  test("transactions and savepoints behave exactly as before, and their queries are timed", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx`insert into items ${tx({ id: 1, label: "explicit" })}`;
        await db.sql`insert into items ${db.sql({ id: 2, label: "ambient" })}`;
        await db
          .transaction(async () => {
            await db.sql`insert into items ${db.sql({ id: 3, label: "inner" })}`;
            throw new Error("inner fails");
          })
          .catch(() => {});
        throw new Error("outer fails");
      }),
    ).rejects.toThrow("outer fails");

    expect(await db.raw<{ n: number }[]>`select count(*) as n from items`).toEqual([{ n: 0 }]);
    expect(operations().filter((op) => op === "insert")).toHaveLength(3);
  });

  test("awaiting the same query twice reports it once", async () => {
    const query = db.sql`select 1`;
    await query;
    await query;
    expect(events).toHaveLength(1);
  });

  test("db.raw is the untouched escape hatch", async () => {
    await db.raw`select 1`;
    expect(events).toEqual([]);
  });
});
