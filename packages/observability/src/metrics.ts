import { monitorEventLoopDelay } from "node:perf_hooks";
import { timingSafeEqual } from "node:crypto";
import { parseDuration, type Duration, type Handler, type Logger, type Middleware, type PubSub } from "@bun-hydrate/core";
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
  /** `onDispatch` for createQueue and `onFinished` for createWorker (spec-6 §13). */
  jobObserver(): {
    onDispatch(event: { queue: string; job: string; deduplicated: boolean }): void;
    onFinished(event: { queue: string; job: string; outcome: string; durationMs: number; latencyMs: number }): void;
  };
  /** Samples `counts()` of a queue adapter into the `jobs` gauge. Default: every 15s. Returns a stop function. */
  observeQueueDepth(source: { counts(): Promise<Record<string, Record<string, number>>> }, options?: { interval?: Duration }): () => void;
  /** `onEmitted` and `onListenerFailed` for createEventBus. */
  eventObserver(): {
    onEmitted(event: { event: string; broadcast: boolean }): void;
    onListenerFailed(event: { event: string; listener: string }): void;
  };
  /** Wraps an App's pubsub to count messages out and in. */
  observePubSub(pubsub: PubSub): PubSub;
  /** Wraps a Storage to count operations and failures. */
  observeStorage<T extends object>(storage: T, adapter: string): T;
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
  const dispatched = registry.counter("jobs_dispatched_total", "Jobs dispatched", ["queue", "job", "deduplicated"]);
  const finished = registry.counter("jobs_finished_total", "Job runs by outcome", ["queue", "job", "outcome"]);
  const jobDuration = registry.histogram("job_duration_seconds", "Job run duration", ["queue", "job"], [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300]);
  const jobLatency = registry.histogram(
    "job_queue_latency_seconds",
    "Time from when a job could run to when a worker started it",
    ["queue", "job"],
    [0.05, 0.25, 1, 5, 15, 60, 300, 900, 3600],
  );
  const depth = registry.gauge("jobs", "Jobs by queue and state (sampled)", ["queue", "state"]);
  const emitted = registry.counter("events_emitted_total", "Events emitted", ["event", "broadcast"]);
  const listenerFailures = registry.counter("event_listener_failures_total", "In-process event listeners that threw", ["event", "listener"]);
  const pubsubMessages = registry.counter("pubsub_messages_total", "WebSocket fan-out messages", ["direction", "outcome"]);
  const storageOperations = registry.counter("storage_operations_total", "Storage operations", ["adapter", "operation", "outcome"]);
  const samplers = new Set<ReturnType<typeof setInterval>>();

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

    jobObserver: () => ({
      onDispatch: ({ queue, job, deduplicated }) => dispatched.inc({ queue, job, deduplicated: String(deduplicated) }),
      onFinished: ({ queue, job, outcome, durationMs, latencyMs }) => {
        finished.inc({ queue, job, outcome });
        jobDuration.observe({ queue, job }, durationMs / 1000);
        jobLatency.observe({ queue, job }, latencyMs / 1000);
      },
    }),

    observeQueueDepth: (source, { interval = "15s" } = {}) => {
      const sample = async () => {
        try {
          for (const [queue, states] of Object.entries(await source.counts())) {
            for (const [state, count] of Object.entries(states)) depth.set({ queue, state }, count);
          }
        } catch (error) {
          options.logger?.warn("Sampling queue depth failed", { error });
        }
      };
      void sample();
      const timer = setInterval(sample, parseDuration(interval));
      timer.unref();
      samplers.add(timer);
      return () => {
        clearInterval(timer);
        samplers.delete(timer);
      };
    },

    eventObserver: () => ({
      onEmitted: ({ event, broadcast }) => emitted.inc({ event, broadcast: String(broadcast) }),
      onListenerFailed: ({ event, listener }) => listenerFailures.inc({ event, listener }),
    }),

    observePubSub: (pubsub) => ({
      async publish(topic, message) {
        try {
          await pubsub.publish(topic, message);
          pubsubMessages.inc({ direction: "out", outcome: "ok" });
        } catch (error) {
          pubsubMessages.inc({ direction: "out", outcome: "error" });
          throw error;
        }
      },
      subscribe: (deliver) =>
        pubsub.subscribe((topic, message) => {
          pubsubMessages.inc({ direction: "in", outcome: "ok" });
          deliver(topic, message);
        }),
    }),

    observeStorage: (storage, adapter) => observeMethods(storage, ["put", "get", "head", "exists", "delete", "list", "signedUrl"], (operation, outcome) =>
      storageOperations.inc({ adapter, operation, outcome }),
    ),

    render,
    close: () => {
      loopDelay?.disable();
      for (const timer of samplers) clearInterval(timer);
      samplers.clear();
    },
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

/** A proxy that reports each call of `methods` (async) as ok or error; other properties pass through. */
function observeMethods<T extends object>(target: T, methods: readonly string[], report: (method: string, outcome: "ok" | "error") => void): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof property !== "string" || !methods.includes(property) || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          const result = await value.apply(object, args);
          report(property, "ok");
          return result;
        } catch (error) {
          report(property, "error");
          throw error;
        }
      };
    },
  });
}
