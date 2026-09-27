import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createRedis } from "@bun-hydrate/redis";
import { createTestClient } from "@bun-hydrate/testing";
import { MemoryRateLimitStore, RedisRateLimitStore, peekJson, rateLimit, type RateLimitStore } from "../src/index";

const stores: { name: string; create: () => RateLimitStore }[] = [
  { name: "memory", create: () => new MemoryRateLimitStore() },
  ...(process.env.TEST_REDIS_URL
    ? [
        { name: "redis", create: () => new RedisRateLimitStore({ url: process.env.TEST_REDIS_URL! }) },
        {
          name: "redis (shared manager)",
          create: () => new RedisRateLimitStore({ redis: createRedis({ url: process.env.TEST_REDIS_URL!, prefix: `test:${crypto.randomUUID()}:` }) }),
        },
      ]
    : []),
];

describe.each(stores)("sliding window on $name", ({ create }) => {
  const key = () => `test:${crypto.randomUUID()}`;
  const policy = { limit: 10, windowMs: 60_000 };

  test("allows up to the limit within a window, then refuses", async () => {
    const store = create();
    const k = key();
    const decisions = [];
    for (let i = 0; i < 11; i++) decisions.push(await store.consume(k, { ...policy, now: 0 }));

    expect(decisions.slice(0, 10).every((d) => d.allowed)).toBe(true);
    expect(decisions[9]!.remaining).toBe(0);
    expect(decisions[10]).toMatchObject({ allowed: false, remaining: 0 });
    await store.close();
  });

  test("the previous window counts, weighted by how much of it still overlaps", async () => {
    const store = create();
    const k = key();
    for (let i = 0; i < 10; i++) await store.consume(k, { ...policy, now: 0 });

    // Start of the next window: the previous 10 still weigh 100% → full.
    expect((await store.consume(k, { ...policy, now: 60_000 })).allowed).toBe(false);
    // Halfway through: the previous window weighs 50% → 5 used, 5 left.
    const halfway = [];
    for (let i = 0; i < 6; i++) halfway.push((await store.consume(k, { ...policy, now: 90_000 })).allowed);
    expect(halfway).toEqual([true, true, true, true, true, false]);
    await store.close();
  });

  test("refused requests are not counted, so a client that waits recovers on schedule", async () => {
    const store = create();
    const k = key();
    for (let i = 0; i < 30; i++) await store.consume(k, { ...policy, now: 0 });

    // Two windows later the old requests no longer overlap at all.
    expect((await store.consume(k, { ...policy, now: 120_000 })).remaining).toBe(9);
    await store.close();
  });

  test("reports the seconds until the current window ends", async () => {
    const store = create();
    expect((await store.consume(key(), { ...policy, now: 45_000 })).resetSeconds).toBe(15);
    await store.close();
  });
});

describe("rateLimit() middleware", () => {
  function createApp(options: Partial<Parameters<typeof rateLimit>[0]> = {}) {
    const app = new App({ logger: createLogger({ level: "silent" }), health: false, securityHeaders: false })
      .use(rateLimit({ limit: 2, window: "1m", ...options }))
      .get("/", () => "ok");
    return createTestClient(app);
  }

  test("adds RateLimit headers and refuses with 429 + Retry-After", async () => {
    const client = createApp();
    const first = await client.get("/");
    await client.get("/");
    const third = await client.get("/");

    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-policy")).toBe('"default";q=2;w=60');
    expect(first.headers.get("ratelimit")).toMatch(/^"default";r=1;t=\d+$/);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await third.json()).error.code).toBe("TOO_MANY_REQUESTS");
    expect(third.headers.get("ratelimit")).toMatch(/^"default";r=0;t=\d+$/);
  });

  test("limits per client IP by default", async () => {
    const app = new App({ logger: createLogger({ level: "silent" }), health: false })
      .use(rateLimit({ limit: 1, window: "1m" }))
      .get("/", () => "ok");
    const from = (address: string) => ({ requestIP: () => ({ address }) });

    expect((await app.fetch(new Request("http://localhost/"), from("203.0.113.1"))).status).toBe(200);
    expect((await app.fetch(new Request("http://localhost/"), from("203.0.113.1"))).status).toBe(429);
    expect((await app.fetch(new Request("http://localhost/"), from("203.0.113.2"))).status).toBe(200);
  });

  test("a custom key function, e.g. per account, and a named policy", async () => {
    const client = createApp({ name: "login", key: (ctx) => ctx.headers.get("x-account") ?? "anonymous" });

    await client.get("/").header("x-account", "a");
    await client.get("/").header("x-account", "a");
    expect((await client.get("/").header("x-account", "a")).status).toBe(429);
    const other = await client.get("/").header("x-account", "b");
    expect(other.status).toBe(200);
    expect(other.headers.get("ratelimit-policy")).toBe('"login";q=2;w=60');
  });

  const brokenStore: RateLimitStore = {
    consume: async () => {
      throw new Error("redis down");
    },
    close: async () => {},
  };

  test("fails open by default when the store is down", async () => {
    const decisions: string[] = [];
    const client = createApp({ store: brokenStore, onDecision: (d) => void decisions.push(d.decision) });

    expect((await client.get("/")).status).toBe(200);
    expect(decisions).toEqual(["store_error"]);
  });

  test("failClosed turns a store outage into 503", async () => {
    const res = await createApp({ store: brokenStore, failClosed: true }).get("/");

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("RATE_LIMIT_UNAVAILABLE");
  });

  test("reports each decision", async () => {
    const decisions: string[] = [];
    const client = createApp({ limit: 1, onDecision: (d) => void decisions.push(`${d.name}:${d.decision}`) });
    await client.get("/");
    await client.get("/");

    expect(decisions).toEqual(["default:allowed", "default:limited"]);
  });

  test("an invalid window fails at construction", () => {
    expect(() => rateLimit({ limit: 1, window: "soon" as "1m" })).toThrow("Invalid duration");
    expect(() => rateLimit({ limit: 0, window: "1m" })).toThrow("rateLimit(): limit must be a positive integer");
  });
});

describe("peekJson", () => {
  test("reads the JSON body without consuming it for the handler", async () => {
    const app = new App({ logger: createLogger({ level: "silent" }), health: false })
      .use(rateLimit({ limit: 1, window: "1m", key: async (ctx) => `login:${(await peekJson<{ email?: string }>(ctx))?.email ?? ""}` }))
      .post("/login", async (ctx) => ctx.body.json());
    const client = createTestClient(app);

    expect(await (await client.post("/login").json({ email: "a@example.com" })).json()).toEqual({ email: "a@example.com" });
    expect((await client.post("/login").json({ email: "a@example.com" })).status).toBe(429);
    expect((await client.post("/login").json({ email: "b@example.com" })).status).toBe(200);
    // Invalid JSON: the limiter keys it as "login:" instead of crashing; the handler then rejects it.
    expect((await client.post("/login").text("not json")).status).toBe(400);
  });
});
