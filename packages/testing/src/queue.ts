import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLogger } from "@bun-hydrate/core";
import {
  MemoryQueueAdapter,
  createQueue,
  createWorker,
  type ClaimRequest,
  type JobDefinition,
  type NewJob,
  type Queue,
  type QueueAdapter,
  type WorkerOptions,
} from "@bun-hydrate/queue";

export interface QueueContractTarget {
  adapter: QueueAdapter;
  /** Removes whatever the adapter stored (tables, keys). */
  cleanup?: () => Promise<void>;
}

const T0 = Date.UTC(2026, 0, 1);
const LEASE = 30_000;

/**
 * The behaviour every queue adapter must have (spec-6 §5.1). Run it for your own adapter:
 * `queueContract("sqs", async () => ({ adapter: new SqsAdapter(…) }))`.
 */
export function queueContract(name: string, create: () => QueueContractTarget | Promise<QueueContractTarget>): void {
  describe(`queue adapter contract: ${name}`, () => {
    let target: QueueContractTarget;
    let adapter: QueueAdapter;
    let sequence = 0;

    beforeEach(async () => {
      target = await create();
      adapter = target.adapter;
    });

    afterEach(async () => {
      await target.cleanup?.();
      await adapter.close();
    });

    /** Ids are UUIDv7 from an increasing clock, so creation order is id order. */
    const job = (overrides: Partial<NewJob> = {}): NewJob => ({
      id: Bun.randomUUIDv7(undefined, T0 + ++sequence),
      queue: "default",
      name: "send-email",
      payload: JSON.stringify({ n: sequence }),
      priority: 0,
      maxAttempts: 3,
      runAt: T0,
      createdAt: T0,
      ...overrides,
    });

    const claim = (overrides: Partial<ClaimRequest> = {}) =>
      adapter.claim({
        queues: ["default"],
        names: ["send-email"],
        limit: 10,
        workerId: "w1",
        now: T0,
        lockedUntil: T0 + LEASE,
        ...overrides,
      });

    const ids = (jobs: readonly { id: string }[]) => jobs.map((j) => j.id);

    test("stores jobs exactly as given, and claiming makes them active under a lease", async () => {
      const original = job({ payload: '{"to":"ada@example.com","ü":"✓"}', priority: 3, traceParent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01" });
      expect(await adapter.enqueue([original])).toEqual([{ id: original.id, deduplicated: false }]);

      const [claimed] = await claim();
      expect(claimed).toMatchObject({ ...original, state: "active", attempt: 1, lockedBy: "w1", lockedUntil: T0 + LEASE });
      expect(await claim({ workerId: "w2" })).toEqual([]);
    });

    test("delayed jobs are claimed only once due", async () => {
      const later = job({ runAt: T0 + 60_000 });
      await adapter.enqueue([later]);

      expect(await claim()).toEqual([]);
      expect(ids(await claim({ now: T0 + 60_000, lockedUntil: T0 + 60_000 + LEASE }))).toEqual([later.id]);
    });

    test("higher priority first, then earlier runAt, then creation order; limit is respected", async () => {
      const a = job();
      const b = job({ priority: 5 });
      const c = job({ runAt: T0 - 1_000 });
      const d = job();
      await adapter.enqueue([a, b, c, d]);

      expect(ids(await claim({ limit: 3 }))).toEqual([b.id, c.id, a.id]);
      expect(ids(await claim())).toEqual([d.id]);
    });

    test("only the requested queues and job names are claimed", async () => {
      const mail = job({ queue: "mail" });
      const report = job({ name: "build-report" });
      const plain = job();
      await adapter.enqueue([mail, report, plain]);

      expect(ids(await claim())).toEqual([plain.id]);
      expect(ids(await claim({ queues: ["mail", "default"], names: ["send-email", "build-report"] }))).toEqual([mail.id, report.id]);
    });

    test("an idempotency key admits one job while it is pending, active or retained", async () => {
      const first = job({ idempotencyKey: "welcome:1" });
      const second = job({ idempotencyKey: "welcome:1" });

      expect(await adapter.enqueue([first])).toEqual([{ id: first.id, deduplicated: false }]);
      expect(await adapter.enqueue([second])).toEqual([{ id: first.id, deduplicated: true }]);
      await claim();
      expect(await adapter.enqueue([job({ idempotencyKey: "welcome:1" })])).toEqual([{ id: first.id, deduplicated: true }]);

      await adapter.complete(first.id, "w1", { outcome: "completed", now: T0 + 5, keep: true });
      expect(await adapter.enqueue([job({ idempotencyKey: "welcome:1" })])).toEqual([{ id: first.id, deduplicated: true }]);

      await adapter.purge({ state: "completed", finishedBefore: T0 + 10 });
      const third = job({ idempotencyKey: "welcome:1" });
      expect(await adapter.enqueue([third])).toEqual([{ id: third.id, deduplicated: false }]);
    });

    test("concurrent claimers never get the same job, and none is lost", async () => {
      const all = Array.from({ length: 200 }, () => job());
      await adapter.enqueue(all);

      const claimer = async (workerId: string) => {
        const mine: string[] = [];
        for (;;) {
          const batch = await claim({ workerId, limit: 7 });
          if (batch.length === 0) return mine;
          mine.push(...ids(batch));
        }
      };
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claimer(`w${i}`)));
      const claimed = results.flat();

      expect(claimed).toHaveLength(200);
      expect(new Set(claimed).size).toBe(200);
    });

    test("renew extends only leases the worker still holds", async () => {
      const a = job();
      const b = job();
      await adapter.enqueue([a, b]);
      await claim({ limit: 1 });
      await claim({ workerId: "w2", limit: 1 });

      expect(await adapter.renew([a.id, b.id], "w1", T0 + 90_000)).toEqual([a.id]);
      expect((await adapter.get(a.id))?.lockedUntil).toBe(T0 + 90_000);
      expect((await adapter.get(b.id))?.lockedUntil).toBe(T0 + LEASE);
    });

    test("completion deletes the job, or keeps it as completed when asked", async () => {
      const gone = job();
      const kept = job();
      await adapter.enqueue([gone, kept]);
      await claim();

      expect(await adapter.complete(gone.id, "w1", { outcome: "completed", now: T0 + 5, keep: false })).toBe(true);
      expect(await adapter.complete(kept.id, "w1", { outcome: "completed", now: T0 + 6, keep: true })).toBe(true);

      expect(await adapter.get(gone.id)).toBeUndefined();
      expect(await adapter.get(kept.id)).toMatchObject({ state: "completed", finishedAt: T0 + 6 });
    });

    test("a worker that lost its lease cannot complete the job", async () => {
      const lost = job();
      await adapter.enqueue([lost]);
      await claim();

      expect(await adapter.complete(lost.id, "someone-else", { outcome: "completed", now: T0, keep: false })).toBe(false);
      expect((await adapter.get(lost.id))?.state).toBe("active");
    });

    test("retry goes back to pending later, with the error; dead keeps the job and the error", async () => {
      const retried = job();
      const died = job();
      await adapter.enqueue([retried, died]);
      await claim();

      await adapter.complete(retried.id, "w1", { outcome: "retry", now: T0 + 1, runAt: T0 + 10_000, error: "SMTP timeout" });
      await adapter.complete(died.id, "w1", { outcome: "dead", now: T0 + 2, error: "bad address" });

      const pending = await adapter.get(retried.id);
      expect(pending).toMatchObject({ state: "pending", attempt: 1, runAt: T0 + 10_000, lastError: "SMTP timeout" });
      expect(pending?.lockedBy).toBeUndefined();
      expect(await adapter.get(died.id)).toMatchObject({ state: "dead", attempt: 1, finishedAt: T0 + 2, lastError: "bad address" });

      expect(await claim({ now: T0 + 9_999 })).toEqual([]);
      expect(await claim({ now: T0 + 10_000, lockedUntil: T0 + 10_000 + LEASE })).toEqual([expect.objectContaining({ id: retried.id, attempt: 2 })]);
    });

    test("released jobs (graceful stop) are pending at once, and the claim does not count", async () => {
      const stopped = job();
      await adapter.enqueue([stopped]);
      await claim();

      await adapter.complete(stopped.id, "w1", { outcome: "released", now: T0 + 3 });
      expect(await adapter.get(stopped.id)).toMatchObject({ state: "pending", attempt: 0, runAt: T0 + 3 });
    });

    test("expired leases go back to pending, or to dead when no attempts are left", async () => {
      const again = job();
      const last = job({ maxAttempts: 1 });
      await adapter.enqueue([again, last]);
      await claim();

      expect(await adapter.requeueExpired(T0 + LEASE - 1)).toBe(0);
      expect(await adapter.requeueExpired(T0 + LEASE + 1)).toBe(2);

      expect(await adapter.get(again.id)).toMatchObject({ state: "pending", attempt: 1, runAt: T0 + LEASE + 1 });
      expect((await adapter.get(again.id))?.lastError).toContain("lease expired");
      expect(await adapter.get(last.id)).toMatchObject({ state: "dead", finishedAt: T0 + LEASE + 1 });
    });

    test("retry() revives dead jobs with a fresh set of attempts", async () => {
      const died = job();
      await adapter.enqueue([died]);
      await claim();
      await adapter.complete(died.id, "w1", { outcome: "dead", now: T0 + 1, error: "boom" });

      expect(await adapter.retry([died.id], T0 + 100)).toBe(1);
      expect(await adapter.get(died.id)).toMatchObject({ state: "pending", attempt: 0, runAt: T0 + 100 });
      expect(await adapter.retry([died.id], T0 + 100)).toBe(0); // only dead jobs
    });

    test("purge removes finished jobs older than the cut-off", async () => {
      const old = job();
      const recent = job();
      await adapter.enqueue([old, recent]);
      await claim();
      await adapter.complete(old.id, "w1", { outcome: "dead", now: T0 + 1, error: "x" });
      await adapter.complete(recent.id, "w1", { outcome: "dead", now: T0 + 100, error: "x" });

      expect(await adapter.purge({ state: "dead", finishedBefore: T0 + 50 })).toBe(1);
      expect(await adapter.get(old.id)).toBeUndefined();
      expect(await adapter.get(recent.id)).toBeDefined();
    });

    test("counts by queue and state; list pages newest first with filters", async () => {
      const jobs = [job(), job(), job({ queue: "mail" }), job()];
      await adapter.enqueue(jobs);
      await claim({ limit: 1 });

      expect(await adapter.counts()).toEqual({
        default: { pending: 2, active: 1, completed: 0, dead: 0 },
        mail: { pending: 1, active: 0, completed: 0, dead: 0 },
      });

      const first = await adapter.list({ state: "pending", queue: "default", limit: 1 });
      expect(ids(first.items)).toEqual([jobs[3]!.id]);
      const second = await adapter.list({ state: "pending", queue: "default", limit: 1, cursor: first.nextCursor! });
      expect(ids(second.items)).toEqual([jobs[1]!.id]);
      expect(second.nextCursor).toBeNull();
      expect(ids((await adapter.list()).items)).toEqual(ids([...jobs].reverse()));
    });
  });
}

export interface TestQueue extends Queue {
  /** Payloads of this job's jobs that are still waiting, oldest first. */
  dispatched<Payload>(definition: JobDefinition<Payload>): Promise<Payload[]>;
  /** Runs every due job (and any they dispatch) to completion, then returns. */
  runAll(options: Omit<WorkerOptions, "queue">): Promise<void>;
}

/** A queue in memory for tests: see what was dispatched, and run it deterministically. */
export function createTestQueue(options: { now?: () => number } = {}): TestQueue {
  const adapter = new MemoryQueueAdapter();
  const now = options.now ?? Date.now;
  const queue = createQueue({ adapter, now });

  return Object.assign(queue, {
    async dispatched<Payload>(definition: JobDefinition<Payload>): Promise<Payload[]> {
      const { items } = await adapter.list({ name: definition.name, state: "pending", limit: 10_000 });
      return items.reverse().map((job) => JSON.parse(job.payload) as Payload);
    },
    async runAll(workerOptions: Omit<WorkerOptions, "queue">): Promise<void> {
      const worker = createWorker({ logger: createLogger({ level: "silent" }), poll: { min: 1, max: 5 }, signals: false, now, ...workerOptions, queue });
      const due = async () => (await adapter.list({ state: "pending", limit: 10_000 })).items.some((job) => job.runAt <= now());
      await worker.start();
      while (worker.active > 0 || (await due())) await Bun.sleep(2);
      await worker.stop();
    },
  });
}
