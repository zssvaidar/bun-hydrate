import { parseDuration, type Duration, type Logger } from "@bun-hydrate/core";
import type { Key } from "@bun-hydrate/di";
import type { StandardSchemaV1 } from "@bun-hydrate/validation";

export type Backoff = "exponential" | Duration | ((attempt: number) => number);

export interface RetryPolicy {
  /** Total tries, including the first. */
  attempts: number;
  backoff: Backoff;
}

type Resolved<Deps extends readonly Key<unknown>[]> = {
  -readonly [I in keyof Deps]: Deps[I] extends Key<infer T> ? T : never;
};

export interface JobContext<Deps extends readonly Key<unknown>[] = []> {
  job: {
    id: string;
    name: string;
    queue: string;
    /** 1 on the first try. */
    attempt: number;
    maxAttempts: number;
    /** Aborted on timeout and on shutdown: pass it to fetch, queries and sleeps. */
    signal: AbortSignal;
    traceId: string;
  };
  /** Bound to jobId, job, attempt and traceId. */
  log: Logger;
  /** Resolved from the worker's container, in `inject` order, per run. */
  services: Resolved<Deps>;
}

export interface JobSpec<Payload, Deps extends readonly Key<unknown>[]> {
  /** Stable identifier stored with each job: renaming it orphans jobs already queued. */
  name: string;
  payload: StandardSchemaV1<unknown, Payload>;
  /** Default: "default". Workers choose which queues they serve. */
  queue?: string;
  /** 0–9, higher runs first. Default: 0. */
  priority?: number;
  /** Default: 3 attempts, exponential backoff from 10s. */
  retry?: Partial<RetryPolicy>;
  /** Default: 5m. The handler's `job.signal` aborts after this. */
  timeout?: Duration;
  inject?: Deps;
  handle(payload: Payload, context: JobContext<Deps>): unknown;
}

export interface JobDefinition<Payload = any, Deps extends readonly Key<unknown>[] = any> {
  readonly name: string;
  readonly queue: string;
  readonly priority: number;
  readonly retry: RetryPolicy;
  readonly timeoutMs: number;
  readonly payload: StandardSchemaV1<unknown, Payload>;
  readonly inject: Deps;
  handle(payload: Payload, context: JobContext<Deps>): unknown;
}

export type JobPayload<Definition> = Definition extends JobDefinition<infer Payload> ? Payload : never;

const NAME = /^[a-z0-9][a-z0-9._:-]{0,199}$/;

/** A background job (spec-6 §3.1): a named, validated payload and the code that handles it. */
export function defineJob<Payload, const Deps extends readonly Key<unknown>[] = []>(
  spec: JobSpec<Payload, Deps>,
): JobDefinition<Payload, Deps> {
  if (!NAME.test(spec.name)) throw new Error(`Job names are 1-200 characters of a-z, 0-9, ., _, : and - (got "${spec.name}")`);
  const priority = spec.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
    throw new Error(`Job "${spec.name}": priority must be an integer from 0 to 9`);
  }
  const retry: RetryPolicy = { attempts: 3, backoff: "exponential", ...spec.retry };
  if (!Number.isInteger(retry.attempts) || retry.attempts < 1) throw new Error(`Job "${spec.name}": retry.attempts must be at least 1`);

  return {
    name: spec.name,
    queue: spec.queue ?? "default",
    priority,
    retry,
    timeoutMs: parseDuration(spec.timeout ?? "5m"),
    payload: spec.payload,
    inject: spec.inject ?? ([] as unknown as Deps),
    handle: spec.handle,
  };
}

/** Throw from a handler to skip the remaining attempts: the job goes straight to dead. */
export class NonRetryableError extends Error {
  override name = "NonRetryableError";
}

/** A payload that does not match the job's schema, at dispatch or when the job runs. */
export class JobPayloadError extends Error {
  override name = "JobPayloadError";
  constructor(
    readonly job: string,
    readonly issues: readonly StandardSchemaV1.Issue[],
  ) {
    super(`Invalid payload for job "${job}": ${issues.map(describeIssue).join("; ")}`);
  }
}

function describeIssue(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment)).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Validates a payload against a job's schema, returning the schema's output. */
export async function validatePayload<Payload>(definition: JobDefinition<Payload>, payload: unknown): Promise<Payload> {
  const result = await definition.payload["~standard"].validate(payload);
  if (result.issues) throw new JobPayloadError(definition.name, result.issues);
  return result.value;
}
