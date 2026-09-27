import { describe, expect, test } from "bun:test";
import { childTrace, formatTraceparent, runWithTrace } from "@bun-hydrate/core";
import { createDatabase } from "@bun-hydrate/database";
import { schema } from "@bun-hydrate/validation";
import { MemoryQueueAdapter, createQueue, defineJob, retryDelay, JobPayloadError } from "../src";

const NOW = Date.UTC(2026, 0, 1);

const sendWelcome = defineJob({
  name: "send-welcome",
  payload: schema.object({ email: schema.email().trim() }),
  async handle() {},
});

describe("defineJob", () => {
  test("fills in the defaults", () => {
    expect(sendWelcome).toMatchObject({
      name: "send-welcome",
      queue: "default",
      priority: 0,
      timeoutMs: 5 * 60_000,
      retry: { attempts: 3, backoff: "exponential" },
      inject: [],
    });
  });

  test("rejects names and settings that cannot work", () => {
    const base = { payload: schema.object({}), handle() {} };
    expect(() => defineJob({ ...base, name: "" })).toThrow("Job names are 1-200 characters of a-z, 0-9, ., _, : and -");
    expect(() => defineJob({ ...base, name: "Send Email" })).toThrow("Job names are");
    expect(() => defineJob({ ...base, name: "x", priority: 12 })).toThrow("priority must be an integer from 0 to 9");
    expect(() => defineJob({ ...base, name: "x", retry: { attempts: 0 } })).toThrow("retry.attempts must be at least 1");
  });
});

describe("dispatch", () => {
  const setup = () => {
    const adapter = new MemoryQueueAdapter();
    return { adapter, queue: createQueue({ adapter, now: () => NOW }) };
  };

  test("validates the payload and stores the schema's output", async () => {
    const { adapter, queue } = setup();
    const { id, deduplicated } = await queue.dispatch(sendWelcome, { email: "  ada@example.com " });

    expect(deduplicated).toBe(false);
    expect(await adapter.get(id)).toMatchObject({
      name: "send-welcome",
      queue: "default",
      payload: JSON.stringify({ email: "ada@example.com" }),
      state: "pending",
      maxAttempts: 3,
      runAt: NOW,
      createdAt: NOW,
    });
  });

  test("refuses an invalid payload at the caller, with the problems listed", async () => {
    const { queue } = setup();
    const error = await queue.dispatch(sendWelcome, { email: "nope" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobPayloadError);
    expect(error.message).toBe('Invalid payload for job "send-welcome": email: Must be a valid email address');
  });

  test("delay, runAt, priority and idempotency keys", async () => {
    const { adapter, queue } = setup();
    const delayed = await queue.dispatch(sendWelcome, { email: "a@b.co" }, { delay: "5m", priority: 7, idempotencyKey: "welcome:a" });
    const again = await queue.dispatch(sendWelcome, { email: "a@b.co" }, { idempotencyKey: "welcome:a" });
    const scheduled = await queue.dispatch(sendWelcome, { email: "c@d.co" }, { runAt: new Date(NOW + 3_600_000) });

    expect(await adapter.get(delayed.id)).toMatchObject({ runAt: NOW + 300_000, priority: 7, idempotencyKey: "welcome:a" });
    expect(again).toEqual({ id: delayed.id, deduplicated: true });
    expect((await adapter.get(scheduled.id))?.runAt).toBe(NOW + 3_600_000);
  });

  test("carries the current trace, so the job continues the request's trace", async () => {
    const { adapter, queue } = setup();
    const trace = childTrace(undefined);
    const { id } = await runWithTrace(trace, () => queue.dispatch(sendWelcome, { email: "a@b.co" }));
    expect((await adapter.get(id))?.traceParent).toBe(formatTraceparent(trace));
  });

  test("with a non-transactional adapter, dispatch inside a transaction waits for the commit", async () => {
    const db = createDatabase({ url: "sqlite://:memory:" });
    const adapter = new MemoryQueueAdapter();
    const queue = createQueue({ adapter, db, now: () => NOW });

    const rolledBack = await db
      .transaction(async () => {
        await queue.dispatch(sendWelcome, { email: "gone@b.co" });
        throw new Error("rollback");
      })
      .catch(() => "rolled back");
    expect(rolledBack).toBe("rolled back");

    await db.transaction(async () => {
      const result = await queue.dispatch(sendWelcome, { email: "kept@b.co" });
      expect(result.deferred).toBe(true);
      expect((await adapter.list()).items).toEqual([]);
    });
    expect((await adapter.list()).items.map((job) => JSON.parse(job.payload).email)).toEqual(["kept@b.co"]);
    await db.close();
  });
});

describe("retryDelay", () => {
  test("exponential from 10s, doubling, ±20% jitter, capped at 1h", () => {
    const exact = (attempt: number) => retryDelay({ attempts: 20, backoff: "exponential" }, attempt, () => 0.5);
    expect([1, 2, 3, 4].map(exact)).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(exact(20)).toBe(3_600_000);
    expect(retryDelay({ attempts: 5, backoff: "exponential" }, 1, () => 0)).toBe(8_000);
    expect(retryDelay({ attempts: 5, backoff: "exponential" }, 1, () => 1)).toBe(12_000);
  });

  test("fixed durations and functions", () => {
    expect(retryDelay({ attempts: 5, backoff: "30s" }, 3)).toBe(30_000);
    expect(retryDelay({ attempts: 5, backoff: (attempt) => attempt * 1_000 }, 4)).toBe(4_000);
  });
});
