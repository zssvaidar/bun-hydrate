import { HttpError, TooManyRequestsError, parseDuration, withHeader, type Context, type Duration, type Middleware } from "@bun-hydrate/core";
import { MemoryRateLimitStore } from "./stores";
import type { RateLimitStore } from "./window";

export type RateLimitDecision = "allowed" | "limited" | "store_error";

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  window: Duration;
  /** Default: the client IP (resolved through trusted proxies only). */
  key?: (ctx: Context<any>) => string | Promise<string>;
  /** Shown in the RateLimit headers and metrics. Default: "default". */
  name?: string;
  /** Default: a MemoryRateLimitStore for this limiter. */
  store?: RateLimitStore;
  /** On store errors, refuse (503) instead of allowing. Default: false (fail open). */
  failClosed?: boolean;
  onDecision?: (event: { name: string; decision: RateLimitDecision }) => void;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

/** Sliding-window rate limiting with IETF RateLimit headers (spec-5 §6). */
export function rateLimit(options: RateLimitOptions): Middleware {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("rateLimit(): limit must be a positive integer");
  }
  const windowMs = parseDuration(options.window);
  const name = options.name ?? "default";
  const store = options.store ?? new MemoryRateLimitStore();
  const keyOf = options.key ?? ((ctx: Context<any>) => ctx.ip);
  const now = options.now ?? Date.now;
  const policyHeader = `"${name}";q=${options.limit};w=${Math.round(windowMs / 1000)}`;

  return async (ctx, next) => {
    let decision;
    try {
      decision = await store.consume(`${name}:${await keyOf(ctx)}`, { limit: options.limit, windowMs, now: now() });
    } catch (error) {
      options.onDecision?.({ name, decision: "store_error" });
      ctx.log.warn("Rate limit store failed", { limiter: name, failClosed: Boolean(options.failClosed), error });
      if (options.failClosed) {
        throw new HttpError(503, "Rate limiting is temporarily unavailable", { code: "RATE_LIMIT_UNAVAILABLE" });
      }
      return next();
    }

    options.onDecision?.({ name, decision: decision.allowed ? "allowed" : "limited" });
    const stateHeader = `"${name}";r=${decision.remaining};t=${decision.resetSeconds}`;

    if (!decision.allowed) {
      const error = new TooManyRequestsError(undefined, {
        retryAfter: decision.resetSeconds,
        headers: { "ratelimit-policy": policyHeader, ratelimit: stateHeader },
      });
      throw error;
    }

    let response = await next();
    response = withHeader(response, "ratelimit-policy", policyHeader);
    return withHeader(response, "ratelimit", stateHeader);
  };
}

/** Reads a JSON body without consuming it (e.g. to key a login limit by email). Invalid JSON → undefined. */
export async function peekJson<T = unknown>(ctx: Context<any>): Promise<T | undefined> {
  try {
    return (await ctx.request.clone().json()) as T;
  } catch {
    return undefined;
  }
}
