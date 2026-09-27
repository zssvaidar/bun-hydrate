import { parseDuration } from "@bun-hydrate/core";
import type { RetryPolicy } from "./define";

const BASE_MS = 10_000;
const CAP_MS = 60 * 60_000;
const JITTER = 0.2;

/**
 * Delay before the next try after `attempt` failed. Exponential: 10s, 20s, 40s, … capped at 1h,
 * with ±20% jitter so jobs that failed together don't retry together.
 */
export function retryDelay(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const { backoff } = policy;
  if (typeof backoff === "function") return backoff(attempt);
  if (backoff !== "exponential") return parseDuration(backoff);
  const exact = Math.min(CAP_MS, BASE_MS * 2 ** (attempt - 1));
  if (exact === CAP_MS) return CAP_MS;
  return Math.round(exact * (1 - JITTER + 2 * JITTER * random()));
}
