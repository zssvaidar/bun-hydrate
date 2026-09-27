import { describe, expect, test } from "bun:test";
import { createDatabase, parseMigration, type Database } from "@bun-hydrate/database";
import { queueContract } from "@bun-hydrate/testing/queue";
import { schema } from "@bun-hydrate/validation";
import { createLogger } from "@bun-hydrate/core";
import { DatabaseQueueAdapter, JOBS_MIGRATION, createQueue, createWorker, defineJob } from "../src";

async function withJobsTable(db: Database): Promise<Database> {
  await db.sql.unsafe("drop table if exists hydrate_jobs");
  await db.sql.unsafe(parseMigration("jobs", JOBS_MIGRATION).up);
  return db;
}

queueContract("database (sqlite)", async () => {
  const db = await withJobsTable(createDatabase({ url: "sqlite://:memory:" }));
  return { adapter: new DatabaseQueueAdapter({ db, closeDatabase: true }) };
});

if (process.env.TEST_POSTGRES_URL) {
  queueContract("database (postgres)", async () => {
    const db = await withJobsTable(createDatabase({ url: process.env.TEST_POSTGRES_URL! }));
    return {
      adapter: new DatabaseQueueAdapter({ db, closeDatabase: true }),
      cleanup: async () => void (await db.sql.unsafe("drop table if exists hydrate_jobs")),
    };
  });
}

describe("database adapter specifics", () => {
  const ping = defineJob({ name: "ping", payload: schema.object({}), handle() {} });

  test("dispatch joins the caller's transaction: a rollback removes the job (spec-6 §5.3)", async () => {
    const db = await withJobsTable(createDatabase({ url: "sqlite://:memory:" }));
    const adapter = new DatabaseQueueAdapter({ db });
    const queue = createQueue({ adapter, db });

    await db
      .transaction(async () => {
        const result = await queue.dispatch(ping, {});
        expect(result.deferred).toBeUndefined(); // written in the transaction, not after it
        expect(await adapter.get(result.id)).toBeDefined();
        throw new Error("rollback");
      })
      .catch(() => {});

    expect((await adapter.list()).items).toEqual([]);
    await db.close();
  });

  test("a worker runs jobs from it, retries included", async () => {
    const db = await withJobsTable(createDatabase({ url: "sqlite://:memory:" }));
    const queue = createQueue({ adapter: new DatabaseQueueAdapter({ db }), db });
    let calls = 0;
    const flaky = defineJob({ name: "flaky", payload: schema.object({}), retry: { attempts: 3, backoff: () => 0 }, handle() {
      if (++calls === 1) throw new Error("first try fails");
    } });
    const worker = createWorker({ queue, handlers: [flaky], logger: createLogger({ level: "silent" }), poll: { min: 5, max: 10 }, signals: false });

    const { id } = await queue.dispatch(flaky, {}, { idempotencyKey: "flaky" });
    await worker.start();
    for (let i = 0; i < 200 && (await queue.adapter.get(id))?.state !== "completed"; i++) await Bun.sleep(10);
    await worker.stop();

    expect(await queue.adapter.get(id)).toMatchObject({ state: "completed", attempt: 2 });
    await db.close();
  });

  test("the migration's down section removes the table", () => {
    expect(parseMigration("jobs", JOBS_MIGRATION).down).toBe("drop table if exists hydrate_jobs;");
  });

  test("MySQL is refused with a clear message until it can be tested", () => {
    const db = { dialect: "mysql" } as Database;
    expect(() => new DatabaseQueueAdapter({ db })).toThrow("The database queue supports SQLite and Postgres");
  });
});
