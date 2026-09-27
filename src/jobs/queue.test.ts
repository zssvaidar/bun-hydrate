import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { defineJob, type Queue } from "@bun-hydrate/queue";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { schema } from "@bun-hydrate/validation";
import { AppQueue, installJobs } from "./queue";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const ping = defineJob({ name: "queue-test-ping", payload: schema.object({}), handle: () => {} });

let db: Database;
let queue: Queue;

beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
  const container = new Container().value(Database, db);
  installJobs(container);
  queue = container.get(AppQueue);
});

afterEach(() => db.close());

test("a job dispatched in a transaction is committed or rolled back with it", async () => {
  await db.transaction(async () => {
    await queue.dispatch(ping, {});
    throw new Error("roll back");
  }).catch(() => {});
  expect(await queue.adapter.counts()).toEqual({});

  await db.transaction(() => queue.dispatch(ping, {}));
  expect((await queue.adapter.counts()).default?.pending).toBe(1);
});
