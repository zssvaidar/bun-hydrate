import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database, createDatabase, isForeignKeyViolation, isUniqueViolation } from "../src/index";
import { dropTables, engines } from "./engines";

describe.each(engines)("Database on $name", ({ open }) => {
  let db: Database;

  beforeEach(async () => {
    db = open();
    await dropTables(db, "entries", "owners");
    await db.sql`create table owners (id integer primary key)`;
    await db.sql`create table entries (
      id integer primary key,
      label varchar(50) not null unique,
      owner_id integer references owners(id)
    )`;
  });

  afterEach(async () => {
    await dropTables(db, "entries", "owners");
    await db.close();
  });

  const labels = async () => (await db.sql`select label from entries order by id`).map((row: { label: string }) => row.label);

  /** A repository-style function: it only uses db.sql and knows nothing about transactions. */
  const insertEntry = (id: number, label: string) => db.sql`insert into entries ${db.sql({ id, label })}`;

  test("runs parameterized queries", async () => {
    await insertEntry(1, "a'; drop table entries; --");
    const rows = await db.sql`select label from entries where id = ${1}`;
    expect(rows[0].label).toBe("a'; drop table entries; --");
  });

  test("a transaction commits when the callback succeeds", async () => {
    const result = await db.transaction(async () => {
      await insertEntry(1, "one");
      return "done";
    });

    expect(result).toBe("done");
    expect(await labels()).toEqual(["one"]);
  });

  test("a thrown error rolls back every write made through db.sql, and is rethrown", async () => {
    await expect(
      db.transaction(async () => {
        await insertEntry(1, "one");
        await insertEntry(2, "two");
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");

    expect(await labels()).toEqual([]);
  });

  test("the callback also receives the transaction explicitly", async () => {
    await db.transaction(async (tx) => {
      await tx`insert into entries ${tx({ id: 1, label: "explicit" })}`;
    });
    expect(await labels()).toEqual(["explicit"]);
  });

  test("nested transactions are savepoints: an inner failure rolls back only the inner block", async () => {
    await db.transaction(async () => {
      await insertEntry(1, "outer");
      await db
        .transaction(async () => {
          await insertEntry(2, "inner");
          throw new Error("inner failed");
        })
        .catch(() => {});
      await insertEntry(3, "after");
    });

    expect(await labels()).toEqual(["outer", "after"]);
  });

  test("concurrent transactions do not leak into each other", async () => {
    const results = await Promise.allSettled([
      db.transaction(async () => {
        await insertEntry(1, "kept");
      }),
      db.transaction(async () => {
        await insertEntry(2, "discarded");
        throw new Error("second fails");
      }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(await labels()).toEqual(["kept"]);
  });

  test("outside a transaction, db.sql is the pool again", async () => {
    await db.transaction(async () => {
      await insertEntry(1, "one");
    });
    expect(db.sql).toBe(db.raw);
  });

  test("normalizes unique and foreign key violations across engines", async () => {
    await insertEntry(1, "taken");
    const duplicate = await insertEntry(2, "taken").catch((error: unknown) => error);
    const orphan = await db.sql`insert into entries ${db.sql({ id: 3, label: "x", owner_id: 999 })}`.catch(
      (error: unknown) => error,
    );

    expect(isUniqueViolation(duplicate)).toBe(true);
    expect(isForeignKeyViolation(duplicate)).toBe(false);
    expect(isForeignKeyViolation(orphan)).toBe(true);
    expect(isUniqueViolation(new Error("unrelated"))).toBe(false);
    expect(isUniqueViolation("not an error")).toBe(false);
  });

  test("ping() reports whether the database answers", async () => {
    expect(await db.ping()).toBe(true);
  });
});

describe("createDatabase", () => {
  test("detects the dialect from the URL", async () => {
    const sqlite = createDatabase({ url: "sqlite://:memory:" });
    expect(sqlite.dialect).toBe("sqlite");
    expect(sqlite).toBeInstanceOf(Database);
    await sqlite.close();

    expect(() => createDatabase({ url: "oracle://nope" })).toThrow(
      'Unsupported database URL "oracle://…": use postgres://, mysql:// or sqlite://',
    );
  });

  test("ping() is false once the database is closed", async () => {
    const db = createDatabase({ url: "sqlite://:memory:" });
    await db.close();
    expect(await db.ping()).toBe(false);
  });
});
