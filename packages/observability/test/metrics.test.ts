import { afterEach, describe, expect, test } from "bun:test";
import { App, Router, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { createMetrics, type Metrics } from "../src/index";

const created: Metrics[] = [];
function metrics(options: Parameters<typeof createMetrics>[0] = {}) {
  const instance = createMetrics({ processMetrics: false, ...options });
  created.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of created.splice(0)) instance.close();
});

/** Parses exposition text into { "name{labels}": value } for assertions. */
function samples(text: string): Record<string, number> {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.lastIndexOf(" ");
        return [line.slice(0, index), Number(line.slice(index + 1))];
      }),
  );
}

describe("registry and exposition format", () => {
  test("counters with labels, HELP and TYPE lines", () => {
    const m = metrics();
    const signups = m.counter("signups_total", "Accounts created", ["plan"]);
    signups.inc({ plan: "free" });
    signups.inc({ plan: "free" });
    signups.inc({ plan: "pro" }, 3);

    const text = m.render();
    expect(text).toContain("# HELP signups_total Accounts created\n# TYPE signups_total counter\n");
    expect(samples(text)).toMatchObject({ 'signups_total{plan="free"}': 2, 'signups_total{plan="pro"}': 3 });
  });

  test("counters only go up", () => {
    expect(() => metrics().counter("c_total", "c").inc({}, -1)).toThrow("Counters can only increase");
  });

  test("gauges set, increase and decrease", () => {
    const m = metrics();
    const queue = m.gauge("queue_depth", "Jobs waiting");
    queue.set({}, 5);
    queue.inc();
    queue.dec({}, 2);
    expect(samples(m.render())).toMatchObject({ queue_depth: 4 });
  });

  test("histograms expose cumulative buckets, sum and count", () => {
    const m = metrics();
    const latency = m.histogram("job_seconds", "Job time", ["job"], [0.1, 1]);
    latency.observe({ job: "email" }, 0.05);
    latency.observe({ job: "email" }, 0.5);
    latency.observe({ job: "email" }, 5);

    expect(samples(m.render())).toMatchObject({
      'job_seconds_bucket{job="email",le="0.1"}': 1,
      'job_seconds_bucket{job="email",le="1"}': 2,
      'job_seconds_bucket{job="email",le="+Inf"}': 3,
      'job_seconds_sum{job="email"}': 5.55,
      'job_seconds_count{job="email"}': 3,
    });
  });

  test("label values are escaped", () => {
    const m = metrics();
    m.counter("weird_total", "w", ["value"]).inc({ value: 'a"b\\c\nd' });
    expect(m.render()).toContain('weird_total{value="a\\"b\\\\c\\nd"} 1');
  });

  test("invalid names, unknown labels and duplicate metrics are programming errors", () => {
    const m = metrics();
    expect(() => m.counter("bad-name", "x")).toThrow('Invalid metric name "bad-name"');
    m.counter("dupe_total", "x");
    expect(() => m.counter("dupe_total", "x")).toThrow('Metric "dupe_total" is already registered');
    expect(() => m.counter("l_total", "x", ["a"]).inc({ b: "1" } as never)).toThrow('Unknown label "b" for l_total');
  });

  test("new label combinations beyond maxSeries are dropped with a single warning", () => {
    const lines: string[] = [];
    const m = metrics({ maxSeries: 3, logger: createLogger({ format: "json", write: (l) => void lines.push(l) }) });
    const byUser = m.counter("by_user_total", "Accidentally unbounded", ["user"]);
    for (let i = 0; i < 10; i++) byUser.inc({ user: `u${i}` });

    expect(Object.keys(samples(m.render())).filter((key) => key.startsWith("by_user_total"))).toHaveLength(3);
    expect(lines.filter((l) => l.includes("by_user_total"))).toHaveLength(1);
  });
});

describe("http() middleware", () => {
  function createApp(m: Metrics) {
    const users = new Router().get("/:id", (ctx) => ({ id: ctx.params.id }));
    return createTestClient(
      new App({ logger: createLogger({ level: "silent" }), health: false })
        .use(m.http())
        .route("/users", users)
        .get("/boom", () => {
          throw new Error("boom");
        }),
    );
  }

  test("counts requests by method, route pattern and status, never raw paths", async () => {
    const m = metrics();
    const client = createApp(m);
    await client.get("/users/1");
    await client.get("/users/2");
    await client.get("/nope/123");
    await client.get("/boom");

    const values = samples(m.render());
    expect(values['http_requests_total{method="GET",route="/users/:id",status="200"}']).toBe(2);
    expect(values['http_requests_total{method="GET",route="<unmatched>",status="404"}']).toBe(1);
    expect(values['http_requests_total{method="GET",route="/boom",status="500"}']).toBe(1);
    expect(m.render()).not.toContain("/users/1");
  });

  test("records durations and in-flight requests", async () => {
    const m = metrics();
    await createApp(m).get("/users/1");
    const values = samples(m.render());

    expect(values['http_request_duration_seconds_count{method="GET",route="/users/:id"}']).toBe(1);
    expect(values.http_requests_in_flight).toBe(0);
  });
});

describe("endpoint()", () => {
  test("serves the exposition format", async () => {
    const m = metrics();
    m.counter("hits_total", "h").inc();
    const client = createTestClient(new App({ logger: createLogger({ level: "silent" }), health: false }).get("/metrics", m.endpoint()));
    const res = await client.get("/metrics");

    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await res.text()).toContain("hits_total 1");
  });

  test("requires the bearer token when one is configured", async () => {
    const m = metrics();
    const client = createTestClient(
      new App({ logger: createLogger({ level: "silent" }), health: false }).get("/metrics", m.endpoint({ token: "t0ken" })),
    );

    expect((await client.get("/metrics")).status).toBe(401);
    expect((await client.get("/metrics").header("authorization", "Bearer wrong")).status).toBe(401);
    expect((await client.get("/metrics").header("authorization", "Bearer t0ken")).status).toBe(200);
  });
});

describe("integrations", () => {
  test("cache and rate-limit observers feed their counters", () => {
    const m = metrics();
    const onLookup = m.cacheObserver("users");
    onLookup("hit");
    onLookup("miss");
    onLookup("hit");
    const onDecision = m.rateLimitObserver();
    onDecision({ name: "login", decision: "limited" });

    expect(samples(m.render())).toMatchObject({
      'cache_requests_total{cache="users",result="hit"}': 2,
      'cache_requests_total{cache="users",result="miss"}': 1,
      'rate_limit_decisions_total{limiter="login",decision="limited"}': 1,
    });
  });

  test("process metrics include memory, uptime and event-loop lag", async () => {
    const m = createMetrics();
    created.push(m);
    await Bun.sleep(50);
    const values = samples(m.render());

    expect(values.process_resident_memory_bytes).toBeGreaterThan(0);
    expect(values.process_heap_bytes).toBeGreaterThan(0);
    expect(values.process_uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(values['process_eventloop_lag_seconds{quantile="0.99"}']).toBeGreaterThanOrEqual(0);
  });

  test("metrics never keep the process alive", async () => {
    const script = `
      import { createMetrics } from "${import.meta.dir}/../src/index";
      const m = createMetrics();
      m.counter("x_total", "x").inc();
    `;
    const child = Bun.spawn(["bun", "-e", script]);
    const startedAt = performance.now();

    expect(await child.exited).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });
});
