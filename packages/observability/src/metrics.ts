import { monitorEventLoopDelay } from "node:perf_hooks";
import { timingSafeEqual } from "node:crypto";
import type { Handler, Logger, Middleware } from "@bun-hydrate/core";
import { Registry, type Counter, type Gauge, type Histogram } from "./registry";

export interface MetricsOptions {
  /** Maximum label combinations per metric (cardinality guard). Default: 1000. */
  maxSeries?: number;
  /** Collect process memory, uptime and event-loop lag. Default: true. */
  processMetrics?: boolean;
  logger?: Logger;
}

export interface Metrics {
  counter<L extends string = never>(name: string, help: string, labelNames?: readonly L[]): Counter<L>;
  gauge<L extends string = never>(name: string, help: string, labelNames?: readonly L[]): Gauge<L>;
  histogram<L extends string = never>(name: string, help: string, labelNames?: readonly L[], buckets?: number[]): Histogram<L>;
  /** Global middleware recording request count, duration and in-flight requests by route pattern. */
  http(): Middleware;
  /** `GET /metrics`; with a token, requires `Authorization: Bearer <token>`. */
  endpoint(options?: { token?: string }): Handler;
  /** Pass as MemoryCache/RedisCache `onLookup`. */
  cacheObserver(cache: string): (result: "hit" | "miss") => void;
  /** Pass as rateLimit `onDecision`. */
  rateLimitObserver(): (event: { name: string; decision: string }) => void;
  /** Pass as Database `onQuery` (see instrumentDatabase). */
  queryObserver(): (event: { operation: string; durationMs: number }) => void;
  render(): string;
  close(): void;
}

const UNMATCHED = "<unmatched>";
const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Prometheus metrics with no dependencies (spec-5 §7). */
export function createMetrics(options: MetricsOptions = {}): Metrics {
  const registry = new Registry({ maxSeries: options.maxSeries ?? 1000, logger: options.logger });

  const requests = registry.counter("http_requests_total", "HTTP requests", ["method", "route", "status"]);
  const duration = registry.histogram("http_request_duration_seconds", "HTTP request duration", ["method", "route"]);
  const inFlight = registry.gauge("http_requests_in_flight", "HTTP requests being handled");
  inFlight.set({}, 0);
  const cacheRequests = registry.counter("cache_requests_total", "Cache lookups", ["cache", "result"]);
  const rateLimits = registry.counter("rate_limit_decisions_total", "Rate limit decisions", ["limiter", "decision"]);
  const queries = registry.histogram("db_query_duration_seconds", "Database query duration", ["operation"]);

  let loopDelay: ReturnType<typeof monitorEventLoopDelay> | undefined;
  const processGauges = options.processMetrics ?? true ? registerProcessMetrics(registry) : undefined;
  if (processGauges) {
    loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
  }

  const render = () => {
    if (processGauges) {
      const memory = process.memoryUsage();
      processGauges.rss.set({}, memory.rss);
      processGauges.heap.set({}, memory.heapUsed);
      processGauges.uptime.set({}, Math.round(process.uptime()));
      processGauges.lag.set({ quantile: "0.5" }, (loopDelay?.percentile(50) ?? 0) / 1e9);
      processGauges.lag.set({ quantile: "0.99" }, (loopDelay?.percentile(99) ?? 0) / 1e9);
    }
    return registry.render();
  };

  return {
    counter: (name, help, labels) => registry.counter(name, help, labels),
    gauge: (name, help, labels) => registry.gauge(name, help, labels),
    histogram: (name, help, labels, buckets) => registry.histogram(name, help, labels, buckets),

    http: () => async (ctx, next) => {
      const startedAt = performance.now();
      inFlight.inc();
      try {
        const response = await next();
        const route = ctx.route ?? UNMATCHED;
        requests.inc({ method: ctx.method, route, status: String(response.status) });
        duration.observe({ method: ctx.method, route }, (performance.now() - startedAt) / 1000);
        return response;
      } finally {
        inFlight.dec();
      }
    },

    endpoint: ({ token } = {}) => (ctx) => {
      if (token !== undefined) {
        const presented = ctx.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
        if (!tokensEqual(presented, token)) {
          return new Response("Unauthorized\n", { status: 401, headers: { "www-authenticate": 'Bearer realm="metrics"' } });
        }
      }
      return new Response(render(), { headers: { "content-type": CONTENT_TYPE, "cache-control": "no-store" } });
    },

    cacheObserver: (cache) => (result) => cacheRequests.inc({ cache, result }),
    rateLimitObserver: () => (event) => rateLimits.inc({ limiter: event.name, decision: event.decision }),
    queryObserver: () => (event) => queries.observe({ operation: event.operation }, event.durationMs / 1000),
    render,
    close: () => loopDelay?.disable(),
  };
}

function registerProcessMetrics(registry: Registry) {
  return {
    rss: registry.gauge("process_resident_memory_bytes", "Resident memory"),
    heap: registry.gauge("process_heap_bytes", "JavaScript heap in use"),
    uptime: registry.gauge("process_uptime_seconds", "Process uptime"),
    lag: registry.gauge("process_eventloop_lag_seconds", "Event loop delay", ["quantile"]),
  };
}
