import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { App, createLogger } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { defineEvent } from "@bun-hydrate/events";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { schema } from "@bun-hydrate/validation";
import { MemoryQueueAdapter, createQueue } from "@bun-hydrate/queue";
import { AppQueue } from "../jobs/queue";
import { AppEvents, installEvents } from "./bus";

const MIGRATIONS = join(import.meta.dir, "../../migrations");
const Pinged = defineEvent("bus-test.pinged", schema.object({ n: schema.number() }));

let db: Database;
let container: Container;

beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
  // Durable listeners go to an in-memory queue here; src/jobs has the real one's tests.
  container = new Container().value(Database, db).value(AppQueue, createQueue({ adapter: new MemoryQueueAdapter() }));
  installEvents(new App({ logger: createLogger({ level: "silent" }), health: false }), container);
});

afterEach(() => db.close());

test("in-process listeners run after the emitting transaction commits, and never after a rollback", async () => {
  const events = container.get(AppEvents);
  const seen: number[] = [];
  events.on(Pinged, ({ n }) => void seen.push(n));

  await db.transaction(async () => {
    await events.emit(Pinged, { n: 1 });
    throw new Error("roll back");
  }).catch(() => {});
  await db.transaction(async () => {
    await events.emit(Pinged, { n: 2 });
    expect(seen).toEqual([]);
  });
  await events.idle();
  expect(seen).toEqual([2]);
});
