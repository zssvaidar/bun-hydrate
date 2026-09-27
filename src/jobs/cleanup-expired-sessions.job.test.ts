import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSessionStore, SessionManager } from "@bun-hydrate/auth";
import type { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { createTestQueue } from "@bun-hydrate/testing/queue";
import { cleanupExpiredSessionsJob } from "./cleanup-expired-sessions.job";

const MIGRATIONS = join(import.meta.dir, "../../migrations");

let db: Database;
beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
});
afterEach(() => db.close());

test("deletes sessions that can no longer be used and keeps live ones", async () => {
  const store = new DatabaseSessionStore(db);
  const now = Date.now();
  await store.insert({ idHash: "expired", userId: "u1", createdAt: 0, lastSeenAt: 0, expiresAt: 1 });
  await store.insert({ idHash: "live", userId: "u1", createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 });
  const container = new Container().value(SessionManager, new SessionManager({ store, loadPrincipal: async () => undefined }));

  const queue = createTestQueue();
  await queue.dispatch(cleanupExpiredSessionsJob, {});
  await queue.runAll({ handlers: [cleanupExpiredSessionsJob], container });

  expect(await store.find("expired")).toBeUndefined();
  expect(await store.find("live")).toBeDefined();
});
