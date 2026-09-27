import {
  childTrace,
  createLogger,
  parseDuration,
  parseTraceparent,
  runWithTrace,
  type Duration,
  type Logger,
} from "@bun-hydrate/core";
import type { Container } from "@bun-hydrate/di";
import type { Completion, JobRecord } from "./adapter";
import { retryDelay } from "./backoff";
import { JobPayloadError, NonRetryableError, validatePayload, type JobContext, type JobDefinition } from "./define";
import type { Queue } from "./queue";

export interface WorkerOptions {
  queue: Queue;
  /** The jobs this worker runs. Jobs with other names are left for other workers (spec-6 D12). */
  handlers: readonly JobDefinition[];
  /** Services for `inject`; each run gets its own scope, disposed afterwards. */
  container?: Container;
  /** Default: every queue the handlers use. */
  queues?: readonly string[];
  /** Jobs in flight at once in this process. Default: 10. */
  concurrency?: number;
  logger?: Logger;
  /** Idle polling in ms: from `min`, doubling to `max` while there is nothing to do. Default: 200–2000. */
  poll?: { min: number; max: number };
  /** Lease length. Default: the longest handler timeout (at most 60s) + 30s; renewed every third of it. */
  lease?: Duration;
  /** How long stop() waits for jobs in flight before releasing them. Default: 25s. */
  shutdownTimeout?: Duration;
  /** Requeue expired leases and purge old jobs this often. Default: 1m. */
  maintenanceInterval?: Duration;
  /** Completed jobs with an idempotency key are kept this long. Default: 24h. */
  idempotencyWindow?: Duration;
  /** Dead jobs are kept this long. Default: 14d. */
  deadRetention?: Duration;
  /** Stop gracefully on SIGTERM and SIGINT. Default: true. */
  signals?: boolean;
  /** Called after each run, e.g. for metrics. */
  onFinished?: (event: JobFinishedEvent) => void;
  now?: () => number;
}

export interface JobFinishedEvent {
  queue: string;
  job: string;
  outcome: Completion["outcome"];
  durationMs: number;
  /** From when the job could first run to when this worker claimed it. */
  latencyMs: number;
}

class JobTimeoutError extends Error {
  override name = "JobTimeoutError";
  constructor(timeoutMs: number) {
    super(`JOB_TIMEOUT: the job ran longer than ${timeoutMs}ms`);
  }
}

class ShutdownAbort extends Error {
  override name = "ShutdownAbort";
  constructor() {
    super("The worker is shutting down");
  }
}

interface InFlight {
  controller: AbortController;
  done: Promise<void>;
}

const MAX_ERROR_LENGTH = 4096;

/** Runs jobs from a queue (spec-6 §4): leases, timeouts, retries, dead jobs and graceful stop. */
export class Worker {
  readonly id = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  private readonly handlers: Map<string, JobDefinition>;
  private readonly queues: readonly string[];
  private readonly concurrency: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private running: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private stopWaking: (() => Promise<void>) | undefined;
  private readonly onSignal = () => void this.stop();

  constructor(private readonly options: WorkerOptions) {
    this.handlers = new Map(options.handlers.map((handler) => [handler.name, handler]));
    this.queues = options.queues ?? [...new Set(options.handlers.map((handler) => handler.queue))];
    this.concurrency = options.concurrency ?? 10;
    this.logger = options.logger ?? createLogger();
    this.now = options.now ?? Date.now;
    const longest = Math.max(0, ...options.handlers.map((handler) => handler.timeoutMs));
    this.leaseMs = options.lease === undefined ? Math.min(longest, 60_000) + 30_000 : parseDuration(options.lease);

    for (const handler of options.handlers) {
      if (handler.inject.length > 0 && !options.container) {
        throw new Error(`Job "${handler.name}" injects services, so the worker needs a container`);
      }
    }
    if (this.handlers.size !== options.handlers.length) throw new Error("Two handlers share a job name");
  }

  /** Jobs running right now. */
  get active(): number {
    return this.inFlight.size;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const every = (interval: number, task: () => Promise<unknown>) => {
      const timer = setInterval(() => void task().catch((error) => this.logger.error("Worker task failed", { error })), interval);
      timer.unref();
      this.timers.push(timer);
    };
    every(Math.max(1, Math.floor(this.leaseMs / 3)), () => this.renewLeases());
    every(parseDuration(this.options.maintenanceInterval ?? "1m"), () => this.maintain());
    await this.maintain();
    this.stopWaking = await this.options.queue.adapter.onWake?.(() => this.wake?.());

    if (this.options.signals !== false) {
      process.once("SIGTERM", this.onSignal);
      process.once("SIGINT", this.onSignal);
    }
    this.logger.info("Worker started", { workerId: this.id, queues: this.queues, jobs: [...this.handlers.keys()], concurrency: this.concurrency });
    this.running = this.loop();
  }

  /** Stops claiming, waits for jobs in flight, then releases the ones still running (spec-6 §11). */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.wake?.();
      for (const timer of this.timers) clearInterval(timer);
      process.off("SIGTERM", this.onSignal);
      process.off("SIGINT", this.onSignal);

      const drained = Promise.all([...this.inFlight.values()].map((job) => job.done));
      const grace = parseDuration(this.options.shutdownTimeout ?? "25s");
      await Promise.race([drained, Bun.sleep(grace)]);
      for (const job of this.inFlight.values()) job.controller.abort(new ShutdownAbort());
      await Promise.all([...this.inFlight.values()].map((job) => job.done));
      await this.running;
      await this.stopWaking?.();
      this.logger.info("Worker stopped", { workerId: this.id });
    })();
    return this.stopping;
  }

  private async loop(): Promise<void> {
    const { min, max } = this.options.poll ?? { min: 200, max: 2_000 };
    let idle = min;
    while (!this.stopping) {
      const free = this.concurrency - this.inFlight.size;
      if (free <= 0) {
        await Promise.race([...this.inFlight.values()].map((job) => job.done));
        continue;
      }

      let claimed: JobRecord[] = [];
      try {
        const now = this.now();
        claimed = await this.options.queue.adapter.claim({
          queues: this.queues,
          names: [...this.handlers.keys()],
          limit: free,
          workerId: this.id,
          now,
          lockedUntil: now + this.leaseMs,
        });
      } catch (error) {
        this.logger.error("Claiming jobs failed", { error });
      }
      for (const record of claimed) this.track(record);

      if (claimed.length === free) {
        idle = min;
        continue;
      }
      idle = claimed.length > 0 ? min : idle;
      await this.sleep(idle);
      if (claimed.length === 0) idle = Math.min(idle * 2, max);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  private track(record: JobRecord): void {
    const controller = new AbortController();
    const done = this.execute(record, controller).finally(() => {
      this.inFlight.delete(record.id);
      this.wake?.();
    });
    this.inFlight.set(record.id, { controller, done });
  }

  private async execute(record: JobRecord, controller: AbortController): Promise<void> {
    const definition = this.handlers.get(record.name)!;
    const claimedAt = this.now();
    const startedAt = performance.now();
    const trace = childTrace(parseTraceparent(record.traceParent ?? null));
    const log = this.logger.child({ jobId: record.id, job: record.name, attempt: record.attempt, traceId: trace.traceId });
    const timer = setTimeout(() => controller.abort(new JobTimeoutError(definition.timeoutMs)), definition.timeoutMs);
    const scope = this.options.container?.createScope();

    let completion: Completion;
    try {
      const payload = await validatePayload(definition, parseJson(definition.name, record.payload));
      const context: JobContext<any> = {
        job: {
          id: record.id,
          name: record.name,
          queue: record.queue,
          attempt: record.attempt,
          maxAttempts: record.maxAttempts,
          signal: controller.signal,
          traceId: trace.traceId,
        },
        log,
        services: definition.inject.map((key: Parameters<Container["get"]>[0]) => scope!.get(key)),
      };
      await runWithTrace(trace, () => untilAborted(Promise.resolve().then(() => definition.handle(payload, context)), controller.signal));
      completion = { outcome: "completed", now: this.now(), keep: record.idempotencyKey !== undefined };
      log.info("Job completed", { durationMs: Math.round(performance.now() - startedAt) });
    } catch (error) {
      completion = this.failure(record, definition, error, controller.signal);
      const fields = { error: describeError(error), outcome: completion.outcome };
      if (completion.outcome === "dead") log.error("Job failed for good", fields);
      else if (completion.outcome === "retry") log.warn("Job failed; will retry", { ...fields, retryAt: new Date(completion.runAt).toISOString() });
      else log.info("Job released for another worker", fields);
    } finally {
      clearTimeout(timer);
      await scope?.dispose().catch((error) => log.error("Disposing the job's services failed", { error }));
    }

    const held = await this.options.queue.adapter.complete(record.id, this.id, completion).catch((error) => {
      log.error("Recording the job's outcome failed", { error });
      return true;
    });
    if (!held) log.warn("The job's lease was lost; its result was discarded");
    this.options.onFinished?.({
      queue: record.queue,
      job: record.name,
      outcome: completion.outcome,
      durationMs: performance.now() - startedAt,
      latencyMs: Math.max(0, claimedAt - record.runAt),
    });
  }

  private failure(record: JobRecord, definition: JobDefinition, error: unknown, signal: AbortSignal): Completion {
    const now = this.now();
    if (signal.aborted && signal.reason instanceof ShutdownAbort) return { outcome: "released", now };
    const message = describeError(error);
    const final = error instanceof NonRetryableError || error instanceof JobPayloadError || record.attempt >= record.maxAttempts;
    if (final) return { outcome: "dead", now, error: message };
    return { outcome: "retry", now, runAt: now + retryDelay(definition.retry, record.attempt), error: message };
  }

  private async renewLeases(): Promise<void> {
    const ids = [...this.inFlight.keys()];
    if (ids.length === 0) return;
    const held = new Set(await this.options.queue.adapter.renew(ids, this.id, this.now() + this.leaseMs));
    for (const id of ids) if (!held.has(id)) this.logger.warn("Lost the lease of a running job", { jobId: id });
  }

  private async maintain(): Promise<void> {
    const adapter = this.options.queue.adapter;
    const now = this.now();
    const requeued = await adapter.requeueExpired(now);
    if (requeued > 0) this.logger.warn("Requeued jobs whose worker stopped responding", { count: requeued });
    await adapter.purge({ state: "completed", finishedBefore: now - parseDuration(this.options.idempotencyWindow ?? "24h") });
    await adapter.purge({ state: "dead", finishedBefore: now - parseDuration(this.options.deadRetention ?? "14d") });
  }
}

export function createWorker(options: WorkerOptions): Worker {
  return new Worker(options);
}

function parseJson(job: string, payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    throw new JobPayloadError(job, [{ message: "stored payload is not valid JSON" }]);
  }
}

/** Settles with `work`, or rejects with the abort reason as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack.split("\n").slice(1).join("\n")}` : ""}` : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/**
 * Runs a worker inside the web process, started and stopped by the app's lifecycle (spec-6 D4):
 * for single-instance deployments, and for the memory adapter in development.
 */
export function startWorkerIn(app: { onStart(hook: () => Promise<() => Promise<void>>): unknown }, options: WorkerOptions): Worker {
  const worker = createWorker({ ...options, signals: false });
  app.onStart(async () => {
    await worker.start();
    return () => worker.stop();
  });
  return worker;
}
