import { currentTrace, formatTraceparent, parseDuration, type Duration } from "@bun-hydrate/core";
import type { Database } from "@bun-hydrate/database";
import type { EnqueueResult, NewJob, QueueAdapter } from "./adapter";
import { validatePayload, type JobDefinition } from "./define";

export interface DispatchOptions {
  /** Run no earlier than this long from now. */
  delay?: Duration;
  /** Run no earlier than this time. */
  runAt?: Date;
  /** Overrides the job's default priority (0–9). */
  priority?: number;
  /** At most one job with this key exists while pending, active or retained (spec-6 §3.1). */
  idempotencyKey?: string;
}

export interface DispatchResult extends EnqueueResult {
  /** Dispatched inside a transaction to a non-transactional adapter: enqueued when it commits. */
  deferred?: true;
}

export interface QueueOptions {
  adapter: QueueAdapter & { transactional?: boolean };
  /** Lets dispatch inside db.transaction() wait for the commit when the adapter can't join it. */
  db?: Database;
  now?: () => number;
  onDispatch?: (event: { queue: string; job: string; deduplicated: boolean }) => void;
}

/** Dispatches jobs (spec-6 §3.1). The adapter decides where they wait; workers run them. */
export class Queue {
  readonly adapter: QueueAdapter & { transactional?: boolean };
  private readonly now: () => number;

  constructor(private readonly options: QueueOptions) {
    this.adapter = options.adapter;
    this.now = options.now ?? Date.now;
  }

  async dispatch<Payload>(definition: JobDefinition<Payload>, payload: NoInfer<Payload>, options: DispatchOptions = {}): Promise<DispatchResult> {
    const value = await validatePayload(definition, payload);
    const now = this.now();
    const trace = currentTrace();
    const job: NewJob = {
      id: Bun.randomUUIDv7(),
      queue: definition.queue,
      name: definition.name,
      payload: JSON.stringify(value),
      priority: options.priority ?? definition.priority,
      maxAttempts: definition.retry.attempts,
      runAt: options.runAt?.getTime() ?? now + (options.delay === undefined ? 0 : parseDuration(options.delay)),
      createdAt: now,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(trace ? { traceParent: formatTraceparent(trace) } : {}),
    };

    const enqueue = async () => {
      const [result] = await this.adapter.enqueue([job]);
      this.options.onDispatch?.({ queue: job.queue, job: job.name, deduplicated: result!.deduplicated });
      return result!;
    };

    const { db } = this.options;
    if (db && !this.adapter.transactional && db.inTransaction) {
      await db.afterCommit(enqueue);
      return { id: job.id, deduplicated: false, deferred: true };
    }
    return enqueue();
  }
}

export function createQueue(options: QueueOptions): Queue {
  return new Queue(options);
}
