export interface ConsumeOptions {
  limit: number;
  windowMs: number;
  now: number;
}

export interface Decision {
  allowed: boolean;
  /** Requests left in the sliding window after this one. */
  remaining: number;
  /** Seconds until the current fixed window ends (when the estimate next drops). */
  resetSeconds: number;
}

export interface RateLimitStore {
  /** Counts one request if it fits the limit, atomically. Refused requests are not counted. */
  consume(key: string, options: ConsumeOptions): Promise<Decision>;
  close(): Promise<void>;
}

export interface WindowPosition {
  index: number;
  /** How much of the previous window still overlaps the sliding window, 0..1. */
  previousWeight: number;
  resetSeconds: number;
}

/**
 * Sliding-window counter (spec-5 §6): two fixed windows, the previous one weighted by how much
 * of it the sliding window still covers. O(1) state per key, no burst at window edges.
 */
export function windowPosition(now: number, windowMs: number): WindowPosition {
  const index = Math.floor(now / windowMs);
  const elapsed = now - index * windowMs;
  return {
    index,
    previousWeight: 1 - elapsed / windowMs,
    resetSeconds: Math.ceil((windowMs - elapsed) / 1000),
  };
}

export function decide(
  current: number,
  previous: number,
  position: WindowPosition,
  limit: number,
): { allowed: boolean; remaining: number } {
  const estimate = previous * position.previousWeight + current;
  const allowed = estimate + 1 <= limit;
  const used = allowed ? estimate + 1 : estimate;
  return { allowed, remaining: Math.max(0, Math.floor(limit - used)) };
}
