import { afterEach, describe, expect, test } from "bun:test";
import { childTrace, createLogger, currentTrace, formatTraceparent, runWithTrace, type LogFields } from "@bun-hydrate/core";
import { Container, token } from "@bun-hydrate/di";
import { schema } from "@bun-hydrate/validation";
import {
  MemoryQueueAdapter,
  NonRetryableError,
  createQueue,
  createWorker,
  defineJob,
  type JobDefinition,
  type Worker,
  type WorkerOptions,
} from "../src";

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

const silent = createLogger({ level: "silent" });
const noBackoff = { attempts: 3, backoff: () => 0 };

function setup(handlers: JobDefinition[], options: Partial<WorkerOptions> = {}) {
  const adapter = new MemoryQueueAdapter();
  const queue = createQueue({ adapter });
  const worker = createWorker({ queue, handlers, logger: silent, poll: { min: 5, max: 20 }, signals: false, ...options });
  workers.push(worker);
  return { adapter, queue, worker };
}

/** Resolves once `check` passes, polling briefly; fails the test after 2s. */
async function eventually(check: () => boolean | Promise<boolean>, what = "condition"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("worker", () => {
  test("runs jobs with their validated payload and services, then deletes them", async () => {
    const Greeter = token<(name: string) => string>("Greeter");
    const seen: string[] = [];
    const greet = defineJob({
      name: "greet",
      payload: schema.object({ name: schema.string().trim() }),
      inject: [Greeter] as const,
      handle: ({ name }, { services: [greeter], job }) => void seen.push(`${greeter(name)} (attempt ${job.attempt})`),
    });
    const container = new Container().value(Greeter, (name) => `hello ${name}`);
    const { queue, adapter, worker } = setup([greet], { container });

    const { id } = await queue.dispatch(greet, { name: " Ada " });
    await worker.start();
    await eventually(() => seen.length === 1);

    expect(seen).toEqual(["hello Ada (attempt 1)"]);
    await eventually(async () => (await adapter.get(id)) === undefined, "deletion");
  });

  test("keeps at most `concurrency` jobs in flight", async () => {
    let running = 0;
    let peak = 0;
    const slow = defineJob({
      name: "slow",
      payload: schema.object({}),
      async handle() {
        peak = Math.max(peak, ++running);
        await Bun.sleep(20);
        running--;
      },
    });
    const { queue, adapter, worker } = setup([slow], { concurrency: 3 });
    for (let i = 0; i < 10; i++) await queue.dispatch(slow, {});

    await worker.start();
    await eventually(async () => (await adapter.list()).items.length === 0, "all jobs done");
    expect(peak).toBe(3);
  });

  test("failures are retried with backoff until they succeed", async () => {
    let calls = 0;
    const flaky = defineJob({
      name: "flaky",
      payload: schema.object({}),
      retry: noBackoff,
      handle() {
        if (++calls < 3) throw new Error(`try ${calls} failed`);
      },
    });
    const { queue, adapter, worker } = setup([flaky]);
    const { id } = await queue.dispatch(flaky, {}, { idempotencyKey: "flaky-1" });

    await worker.start();
    await eventually(async () => (await adapter.get(id))?.state === "completed");
    expect(await adapter.get(id)).toMatchObject({ attempt: 3, lastError: expect.stringContaining("try 2 failed") });
  });

  test("the retry time follows the job's backoff", async () => {
    const failing = defineJob({ name: "failing", payload: schema.object({}), retry: { attempts: 5, backoff: "1h" }, handle() {
      throw new Error("down");
    } });
    const { queue, adapter, worker } = setup([failing]);
    const { id } = await queue.dispatch(failing, {});

    const before = Date.now();
    await worker.start();
    await eventually(async () => (await adapter.get(id))?.attempt === 1 && (await adapter.get(id))?.state === "pending");
    expect((await adapter.get(id))!.runAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  test("after the last attempt, or on NonRetryableError, the job is dead with its error", async () => {
    const hopeless = defineJob({ name: "hopeless", payload: schema.object({}), retry: noBackoff, handle() {
      throw new Error("always fails");
    } });
    const refused = defineJob({ name: "refused", payload: schema.object({}), handle() {
      throw new NonRetryableError("address does not exist");
    } });
    const { queue, adapter, worker } = setup([hopeless, refused]);
    const a = await queue.dispatch(hopeless, {});
    const b = await queue.dispatch(refused, {});

    await worker.start();
    await eventually(async () => (await adapter.get(a.id))?.state === "dead" && (await adapter.get(b.id))?.state === "dead");
    expect(await adapter.get(a.id)).toMatchObject({ attempt: 3, lastError: expect.stringContaining("always fails") });
    expect(await adapter.get(b.id)).toMatchObject({ attempt: 1, lastError: expect.stringContaining("NonRetryableError: address does not exist") });
  });

  test("a payload that no longer matches the schema goes to dead without running the handler", async () => {
    let ran = false;
    const strict = defineJob({ name: "strict", payload: schema.object({ id: schema.uuid() }), handle: () => void (ran = true) });
    const { adapter, worker } = setup([strict]);
    const now = Date.now();
    await adapter.enqueue([{ id: Bun.randomUUIDv7(), queue: "default", name: "strict", payload: '{"id":"not-a-uuid"}', priority: 0, maxAttempts: 3, runAt: now, createdAt: now }]);

    await worker.start();
    await eventually(async () => (await adapter.list({ state: "dead" })).items.length === 1);
    expect(ran).toBe(false);
    expect((await adapter.list({ state: "dead" })).items[0]!.lastError).toContain('Invalid payload for job "strict": id: Must be a valid UUID');
  });

  test("a job that runs past its timeout is aborted through job.signal and retried", async () => {
    let aborted = false;
    const stuck = defineJob({
      name: "stuck",
      payload: schema.object({}),
      timeout: 30,
      retry: { attempts: 2, backoff: "1h" },
      async handle(_payload, { job }) {
        job.signal.addEventListener("abort", () => void (aborted = true));
        await Bun.sleep(1_000);
      },
    });
    const { queue, adapter, worker } = setup([stuck]);
    const { id } = await queue.dispatch(stuck, {});

    await worker.start();
    await eventually(async () => (await adapter.get(id))?.state === "pending" && (await adapter.get(id))?.attempt === 1);
    expect(aborted).toBe(true);
    expect((await adapter.get(id))?.lastError).toContain("JOB_TIMEOUT");
  });

  test("jobs this worker has no handler for are never claimed", async () => {
    const known = defineJob({ name: "known", payload: schema.object({}), handle() {} });
    const other = defineJob({ name: "other", payload: schema.object({}), handle() {} });
    const { queue, adapter, worker } = setup([known]);
    const { id } = await queue.dispatch(other, {});
    await queue.dispatch(known, {});

    await worker.start();
    await eventually(async () => (await adapter.list()).items.length === 1);
    expect(await adapter.get(id)).toMatchObject({ state: "pending", attempt: 0 });
  });

  test("stop() waits for jobs in flight to finish", async () => {
    let finished = false;
    const short = defineJob({ name: "short", payload: schema.object({}), async handle() {
      await Bun.sleep(40);
      finished = true;
    } });
    const { queue, worker } = setup([short]);
    await queue.dispatch(short, {});
    await worker.start();
    await eventually(() => worker.active === 1);

    await worker.stop();
    expect(finished).toBe(true);
  });

  test("stop() releases jobs that don't finish in time: pending again, the attempt not counted", async () => {
    const long = defineJob({ name: "long", payload: schema.object({}), async handle(_p, { job }) {
      await new Promise((resolve) => job.signal.addEventListener("abort", resolve));
    } });
    const { queue, adapter, worker } = setup([long], { shutdownTimeout: 50 });
    const { id } = await queue.dispatch(long, {});
    await worker.start();
    await eventually(() => worker.active === 1);

    await worker.stop();
    expect(await adapter.get(id)).toMatchObject({ state: "pending", attempt: 0 });
  });

  test("the handler runs in the dispatcher's trace, and its logs say which job it is", async () => {
    const lines: LogFields[] = [];
    const logger = createLogger({ level: "info", format: "json", write: (line) => void lines.push(JSON.parse(line)) });
    let traceInside: string | undefined;
    const traced = defineJob({ name: "traced", payload: schema.object({}), handle(_p, { log }) {
      traceInside = currentTrace()?.traceId;
      log.info("working");
    } });
    const { queue, worker } = setup([traced], { logger });
    const request = childTrace(undefined);
    const { id } = await runWithTrace(request, () => queue.dispatch(traced, {}));

    await worker.start();
    await eventually(() => traceInside !== undefined);
    expect(traceInside).toBe(request.traceId);
    expect(lines.find((line) => line.msg === "working")).toMatchObject({ jobId: id, job: "traced", attempt: 1, traceId: request.traceId });
    expect(formatTraceparent(request)).toStartWith("00-");
  });

  test("services come from a scope per run, disposed afterwards", async () => {
    const disposed: string[] = [];
    class Connection {
      readonly id = crypto.randomUUID();
      [Symbol.dispose]() {
        disposed.push(this.id);
      }
    }
    const used: string[] = [];
    const job = defineJob({ name: "scoped", payload: schema.object({}), inject: [Connection] as const, handle: (_p, { services: [c] }) => void used.push(c.id) });
    const container = new Container().bind(Connection, { lifetime: "scoped" });
    const { queue, worker } = setup([job], { container });
    await queue.dispatch(job, {});
    await queue.dispatch(job, {});

    await worker.start();
    await eventually(() => disposed.length === 2);
    expect(new Set(used).size).toBe(2);
    expect(disposed.sort()).toEqual(used.sort());
  });

  test("leases are renewed while a job runs", async () => {
    let release!: () => void;
    const held = defineJob({ name: "held", payload: schema.object({}), async handle() {
      await new Promise<void>((resolve) => (release = resolve));
    } });
    const { queue, adapter, worker } = setup([held], { lease: 90 });
    const { id } = await queue.dispatch(held, {});
    await worker.start();
    await eventually(() => worker.active === 1);

    const first = (await adapter.get(id))!.lockedUntil!;
    await Bun.sleep(80);
    expect((await adapter.get(id))!.lockedUntil!).toBeGreaterThan(first);
    release();
  });

  test("jobs left by a worker that died are picked up once their lease expires", async () => {
    const recover = defineJob({ name: "recover", payload: schema.object({}), handle() {} });
    const { queue, adapter, worker } = setup([recover], { maintenanceInterval: 10 });
    const { id } = await queue.dispatch(recover, {}, { idempotencyKey: "recover-1" });
    const now = Date.now();
    await adapter.claim({ queues: ["default"], names: ["recover"], limit: 1, workerId: "crashed", now, lockedUntil: now + 20 });

    await worker.start();
    await eventually(async () => (await adapter.get(id))?.state === "completed");
    expect((await adapter.get(id))?.attempt).toBe(2);
  });
});

describe("schedules", () => {
  test("two workers on the same schedule dispatch one job per slot", async () => {
    const runs: string[] = [];
    const tick = defineJob({ name: "tick", payload: schema.object({ label: schema.string() }), handle: ({ label }) => void runs.push(label) });
    // A clock 50ms before the next minute boundary, so the test doesn't wait for a real one.
    const real = Date.now();
    const offset = Math.ceil((real + 1) / 60_000) * 60_000 - 50 - real;
    const now = () => Date.now() + offset;
    const adapter = new MemoryQueueAdapter();
    const queue = createQueue({ adapter, now });
    const make = () => {
      const worker = createWorker({ queue, handlers: [tick], logger: silent, poll: { min: 5, max: 10 }, signals: false, now });
      worker.schedule(tick, "* * * * *", { payload: { label: "every minute" } });
      workers.push(worker);
      return worker;
    };
    const [a, b] = [make(), make()];

    await Promise.all([a.start(), b.start()]);
    await eventually(() => runs.length >= 1, "the scheduled run");
    await Bun.sleep(50);
    expect(runs).toEqual(["every minute"]);
  });

  test("a schedule's cron and timezone are checked when it is added", () => {
    const tick = defineJob({ name: "tick", payload: schema.object({}), handle() {} });
    const { worker } = setup([tick]);
    expect(() => worker.schedule(tick, "* * *")).toThrow("Cron expressions have 5 fields");
    expect(() => worker.schedule(tick, "* * * * *", { timezone: "Nowhere/Land" })).toThrow('Unknown timezone "Nowhere/Land"');
    const other = defineJob({ name: "other", payload: schema.object({}), handle() {} });
    expect(() => worker.schedule(other, "* * * * *")).toThrow('Scheduled job "other" has no handler in this worker');
  });
});
