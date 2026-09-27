import { RedisClient } from "bun";
import { decide, windowPosition, type ConsumeOptions, type Decision, type RateLimitStore } from "./window";

interface Counters {
  index: number;
  current: number;
  previous: number;
}

/** Single-process store; JavaScript's single thread makes each consume() atomic. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, Counters>();
  private readonly sweeper: Timer;

  constructor(sweepIntervalMs = 60_000) {
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref();
  }

  async consume(key: string, { limit, windowMs, now }: ConsumeOptions): Promise<Decision> {
    const position = windowPosition(now, windowMs);
    const counters = this.shift(this.counters.get(key), position.index);
    const { allowed, remaining } = decide(counters.current, counters.previous, position, limit);
    if (allowed) counters.current++;
    this.counters.set(key, counters);
    return { allowed, remaining, resetSeconds: position.resetSeconds };
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.counters.clear();
  }

  /** Moves the counters forward to window `index`. */
  private shift(counters: Counters | undefined, index: number): Counters {
    if (!counters || counters.index < index - 1) return { index, current: 0, previous: 0 };
    if (counters.index === index - 1) return { index, current: 0, previous: counters.current };
    return counters;
  }

  private sweep(): void {
    const newest = Math.max(...[...this.counters.values()].map((c) => c.index), 0);
    for (const [key, counters] of this.counters) {
      if (counters.index < newest - 1) this.counters.delete(key);
    }
  }
}

/**
 * Reads both windows, decides and increments in one round trip, atomically, so concurrent
 * instances share one limit. The weighting mirrors decide() exactly.
 */
const CONSUME_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local previous = tonumber(redis.call("GET", KEYS[2]) or "0")
local estimate = previous * tonumber(ARGV[1]) + current
local limit = tonumber(ARGV[2])
if estimate + 1 > limit then
  return {0, current, previous}
end
current = redis.call("INCR", KEYS[1])
redis.call("PEXPIRE", KEYS[1], ARGV[3])
return {1, current, previous}
`;

export interface RedisRateLimitStoreOptions {
  url?: string;
  client?: RedisClient;
  /** Prepended to every key. Default: "ratelimit:". */
  prefix?: string;
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: RedisClient;
  private readonly ownsClient: boolean;
  private readonly prefix: string;

  constructor(options: RedisRateLimitStoreOptions) {
    this.client = options.client ?? new RedisClient(options.url);
    this.ownsClient = options.client === undefined;
    this.prefix = options.prefix ?? "ratelimit:";
  }

  async consume(key: string, { limit, windowMs, now }: ConsumeOptions): Promise<Decision> {
    const position = windowPosition(now, windowMs);
    const base = `${this.prefix}${key}`;
    const [allowedFlag, current, previous] = (await this.client.send("EVAL", [
      CONSUME_SCRIPT,
      "2",
      `${base}:${position.index}`,
      `${base}:${position.index - 1}`,
      String(position.previousWeight),
      String(limit),
      String(windowMs * 2),
    ])) as [number, number, number];

    const allowed = allowedFlag === 1;
    const used = previous * position.previousWeight + current;
    return { allowed, remaining: Math.max(0, Math.floor(limit - used)), resetSeconds: position.resetSeconds };
  }

  async close(): Promise<void> {
    if (this.ownsClient) this.client.close();
  }
}
