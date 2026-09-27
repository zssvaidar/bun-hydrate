import {
  emptyCounts,
  type ClaimRequest,
  type Completion,
  type EnqueueResult,
  type JobCounts,
  type JobFilter,
  type JobPage,
  type JobRecord,
  type NewJob,
  type PurgeFilter,
  type QueueAdapter,
} from "./adapter";

export const LEASE_EXPIRED = "lease expired: the worker stopped responding";

/** Claim order: higher priority, then earlier runAt, then creation (id). */
export function claimOrder(a: JobRecord, b: JobRecord): number {
  return b.priority - a.priority || a.runAt - b.runAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Jobs in this process only: for tests, and for an embedded worker in development (spec-6 §5.2). */
export class MemoryQueueAdapter implements QueueAdapter {
  private readonly jobs = new Map<string, JobRecord>();

  async enqueue(jobs: readonly NewJob[]): Promise<EnqueueResult[]> {
    return jobs.map((job) => {
      const existing = job.idempotencyKey ? this.byKey(job.idempotencyKey) : undefined;
      if (existing) return { id: existing.id, deduplicated: true };
      this.jobs.set(job.id, { ...job, state: "pending", attempt: 0 });
      return { id: job.id, deduplicated: false };
    });
  }

  async claim({ queues, names, limit, workerId, now, lockedUntil }: ClaimRequest): Promise<JobRecord[]> {
    const due = [...this.jobs.values()]
      .filter((job) => job.state === "pending" && job.runAt <= now && queues.includes(job.queue) && names.includes(job.name))
      .sort(claimOrder)
      .slice(0, limit);
    for (const job of due) Object.assign(job, { state: "active", attempt: job.attempt + 1, lockedBy: workerId, lockedUntil });
    return due.map((job) => ({ ...job }));
  }

  async renew(ids: readonly string[], workerId: string, lockedUntil: number): Promise<string[]> {
    return ids.filter((id) => {
      const job = this.jobs.get(id);
      if (job?.state !== "active" || job.lockedBy !== workerId) return false;
      job.lockedUntil = lockedUntil;
      return true;
    });
  }

  async complete(id: string, workerId: string, completion: Completion): Promise<boolean> {
    const job = this.jobs.get(id);
    if (job?.state !== "active" || job.lockedBy !== workerId) return false;
    const unlocked = { lockedBy: undefined, lockedUntil: undefined };

    switch (completion.outcome) {
      case "completed":
        if (completion.keep) Object.assign(job, unlocked, { state: "completed", finishedAt: completion.now });
        else this.jobs.delete(id);
        break;
      case "retry":
        Object.assign(job, unlocked, { state: "pending", runAt: completion.runAt, lastError: completion.error });
        break;
      case "dead":
        Object.assign(job, unlocked, { state: "dead", finishedAt: completion.now, lastError: completion.error });
        break;
      case "released":
        Object.assign(job, unlocked, { state: "pending", runAt: completion.now, attempt: job.attempt - 1 });
        break;
    }
    return true;
  }

  async requeueExpired(now: number): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state !== "active" || (job.lockedUntil ?? 0) >= now) continue;
      const exhausted = job.attempt >= job.maxAttempts;
      Object.assign(job, { lockedBy: undefined, lockedUntil: undefined, lastError: LEASE_EXPIRED });
      Object.assign(job, exhausted ? { state: "dead", finishedAt: now } : { state: "pending", runAt: now });
      count++;
    }
    return count;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(id);
    return job && { ...job };
  }

  async list({ state, queue, name, limit = 50, cursor }: JobFilter = {}): Promise<JobPage> {
    const matching = [...this.jobs.values()]
      .filter((job) => (!state || job.state === state) && (!queue || job.queue === queue) && (!name || job.name === name))
      .filter((job) => cursor === undefined || job.id < cursor)
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    const items = matching.slice(0, limit).map((job) => ({ ...job }));
    return { items, nextCursor: matching.length > limit ? items.at(-1)!.id : null };
  }

  async counts(): Promise<JobCounts> {
    const counts: JobCounts = {};
    for (const job of this.jobs.values()) (counts[job.queue] ??= emptyCounts())[job.state]++;
    return counts;
  }

  async retry(ids: readonly string[], now: number): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job?.state !== "dead") continue;
      Object.assign(job, { state: "pending", attempt: 0, runAt: now, finishedAt: undefined });
      count++;
    }
    return count;
  }

  async purge({ state, finishedBefore }: PurgeFilter): Promise<number> {
    let count = 0;
    for (const [id, job] of this.jobs) {
      if (job.state === state && (job.finishedAt ?? Infinity) < finishedBefore) {
        this.jobs.delete(id);
        count++;
      }
    }
    return count;
  }

  async close(): Promise<void> {}

  private byKey(key: string): JobRecord | undefined {
    for (const job of this.jobs.values()) if (job.idempotencyKey === key) return job;
    return undefined;
  }
}
