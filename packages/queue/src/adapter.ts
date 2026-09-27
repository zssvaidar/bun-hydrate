/**
 * The storage contract behind jobs (spec-6 §5.1). Adapters hold state; they never read a clock:
 * every time comes in as an argument, so the same contract tests drive every adapter
 * deterministically. Times are epoch milliseconds.
 */

export type JobState = "pending" | "active" | "completed" | "dead";

export interface NewJob {
  /** UUIDv7, so ids sort by creation time. */
  id: string;
  queue: string;
  name: string;
  /** JSON. */
  payload: string;
  /** 0–9, higher first. */
  priority: number;
  maxAttempts: number;
  /** Not before this time. */
  runAt: number;
  idempotencyKey?: string;
  traceParent?: string;
  createdAt: number;
}

export interface JobRecord extends NewJob {
  state: JobState;
  /** Number of claims so far. */
  attempt: number;
  lockedUntil?: number;
  lockedBy?: string;
  lastError?: string;
  finishedAt?: number;
}

export interface EnqueueResult {
  id: string;
  /** A job with the same idempotency key already existed; nothing was added. */
  deduplicated: boolean;
}

export interface ClaimRequest {
  queues: readonly string[];
  /** Only jobs this worker can run (spec-6 D12). */
  names: readonly string[];
  limit: number;
  workerId: string;
  now: number;
  /** Lease end for claimed jobs. */
  lockedUntil: number;
}

export type Completion =
  /** `keep`: retain the row as completed (it has an idempotency key); otherwise it is deleted. */
  | { outcome: "completed"; now: number; keep: boolean }
  | { outcome: "retry"; now: number; runAt: number; error: string }
  | { outcome: "dead"; now: number; error: string }
  /** Graceful shutdown: back to pending at once, and this claim does not count as an attempt. */
  | { outcome: "released"; now: number };

export interface JobFilter {
  state?: JobState;
  queue?: string;
  name?: string;
  limit?: number;
  /** From the previous page's `nextCursor`. */
  cursor?: string;
}

export interface JobPage {
  /** Newest first. */
  items: JobRecord[];
  nextCursor: string | null;
}

export interface PurgeFilter {
  state: "completed" | "dead";
  /** Only jobs that finished before this time. */
  finishedBefore: number;
}

export type JobCounts = Record<string, Record<JobState, number>>;

export interface QueueAdapter {
  enqueue(jobs: readonly NewJob[]): Promise<EnqueueResult[]>;
  claim(request: ClaimRequest): Promise<JobRecord[]>;
  /** Extends leases this worker still holds; returns the ids it still holds. */
  renew(ids: readonly string[], workerId: string, lockedUntil: number): Promise<string[]>;
  /** Returns false when the worker no longer holds the lease: the result is discarded. */
  complete(id: string, workerId: string, completion: Completion): Promise<boolean>;
  /** Active jobs whose lease ended: back to pending (counting the attempt), or dead when none are left. */
  requeueExpired(now: number): Promise<number>;
  get(id: string): Promise<JobRecord | undefined>;
  list(filter?: JobFilter): Promise<JobPage>;
  counts(): Promise<JobCounts>;
  /** Dead jobs back to pending with a fresh set of attempts. */
  retry(ids: readonly string[], now: number): Promise<number>;
  purge(filter: PurgeFilter): Promise<number>;
  /** Optional: calls `listener` when jobs are enqueued, so idle workers don't wait for their next poll. */
  onWake?(listener: () => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export const JOB_STATES: readonly JobState[] = ["pending", "active", "completed", "dead"];

export function emptyCounts(): Record<JobState, number> {
  return { pending: 0, active: 0, completed: 0, dead: 0 };
}
