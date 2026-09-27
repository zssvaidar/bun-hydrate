import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRedis } from "@bun-hydrate/redis";
import { MemoryCache, RedisCache, type Cache } from "../src/index";

interface Adapter {
  name: string;
  create: (options?: { onLookup?: (result: "hit" | "miss") => void }) => Cache & { close(): Promise<void> };
}

const adapters: Adapter[] = [
  { name: "memory", create: (options) => new MemoryCache({ ...options }) },
  ...(process.env.TEST_REDIS_URL
    ? [
        {
          name: "redis",
          create: (options?: { onLookup?: (result: "hit" | "miss") => void }) =>
            new RedisCache({ url: process.env.TEST_REDIS_URL!, prefix: `test:${crypto.randomUUID()}:`, ...options }),
        },
      ]
    : []),
];

describe.each(adapters)("Cache contract on $name", ({ create }) => {
  let cache: ReturnType<Adapter["create"]>;

  beforeEach(() => {
    cache = create();
  });

  afterEach(() => cache.close());

  test("get/set/has/delete round-trip JSON values", async () => {
    await cache.set("user:1", { id: 1, tags: ["a"], nested: { ok: true } });

    expect(await cache.get<object>("user:1")).toEqual({ id: 1, tags: ["a"], nested: { ok: true } });
    expect(await cache.has("user:1")).toBe(true);
    await cache.delete("user:1");
    expect(await cache.get<unknown>("user:1")).toBeNull();
    expect(await cache.has("user:1")).toBe(false);
  });

  test("values are copies: mutating a cached object never changes the cache", async () => {
    const value = { count: 1 };
    await cache.set("k", value);
    value.count = 99;
    const read = await cache.get<{ count: number }>("k");
    read!.count = 50;

    expect(await cache.get<object>("k")).toEqual({ count: 1 });
  });

  test("null and undefined cannot be cached", async () => {
    await expect(cache.set("k", null)).rejects.toThrow("Cannot cache null: it is indistinguishable from a miss");
    await expect(cache.set("k", undefined)).rejects.toThrow("Cannot cache undefined");
  });

  test("entries expire after their TTL (seconds)", async () => {
    await cache.set("short", "value", 1);
    expect(await cache.get<unknown>("short")).toBe("value");
    await Bun.sleep(1_100);
    expect(await cache.get<unknown>("short")).toBeNull();
  });

  test("namespaces prefix keys and do not see each other", async () => {
    const users = cache.namespace("users:");
    const orders = cache.namespace("orders:");
    await users.set("1", "ada");

    expect(await users.get<unknown>("1")).toBe("ada");
    expect(await cache.get<unknown>("users:1")).toBe("ada");
    expect(await orders.get<unknown>("1")).toBeNull();
  });

  test("remember loads once for 50 concurrent misses, then serves the cache", async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      await Bun.sleep(20);
      return { value: "expensive" };
    };

    const results = await Promise.all(Array.from({ length: 50 }, () => cache.remember("k", 60, load)));

    expect(loads).toBe(1);
    expect(results.every((result) => result.value === "expensive")).toBe(true);
    expect(await cache.remember("k", 60, load)).toEqual({ value: "expensive" });
    expect(loads).toBe(1);
  });

  test("remember does not cache a failed load, and the next call retries", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("db down");
      return "ok";
    };

    await expect(cache.remember("k", 60, flaky)).rejects.toThrow("db down");
    expect(await cache.remember("k", 60, flaky)).toBe("ok");
  });

  test("remember returns but does not cache null (e.g. not found)", async () => {
    let calls = 0;
    const missing = async () => {
      calls++;
      return null;
    };

    expect(await cache.remember("k", 60, missing)).toBeNull();
    expect(await cache.remember("k", 60, missing)).toBeNull();
    expect(calls).toBe(2);
  });

  test("reports hits and misses to onLookup", async () => {
    const results: string[] = [];
    const observed = create({ onLookup: (result) => void results.push(result) });
    await observed.set("k", 1);
    await observed.get<unknown>("k");
    await observed.get<unknown>("missing");
    await observed.close();

    expect(results).toEqual(["hit", "miss"]);
  });

  test("ping reports health", async () => {
    expect(await cache.ping()).toBe(true);
  });
});

describe("MemoryCache specifics", () => {
  test("evicts the least recently used entry beyond maxEntries", async () => {
    const cache = new MemoryCache({ maxEntries: 2 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.get<unknown>("a"); // a is now most recently used
    await cache.set("c", 3);

    expect(await cache.get<unknown>("b")).toBeNull();
    expect(await cache.get<unknown>("a")).toBe(1);
    expect(await cache.get<unknown>("c")).toBe(3);
    await cache.close();
  });

  test("uses an injectable clock for TTLs", async () => {
    let now = 1_000_000;
    const cache = new MemoryCache({ now: () => now });
    await cache.set("k", "v", 10);

    now += 9_999;
    expect(await cache.get<unknown>("k")).toBe("v");
    now += 2;
    expect(await cache.get<unknown>("k")).toBeNull();
    await cache.close();
  });

  test("rejects invalid TTLs", async () => {
    const cache = new MemoryCache();
    await expect(cache.set("k", 1, 0)).rejects.toThrow("TTL must be a positive number of seconds");
    await cache.close();
  });

  test("never keeps the process alive", async () => {
    const script = `
      import { MemoryCache } from "${import.meta.dir}/../src/index";
      const cache = new MemoryCache();
      await cache.set("k", 1, 60);
    `;
    const child = Bun.spawn(["bun", "-e", script]);
    const startedAt = performance.now();

    expect(await child.exited).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });
});

describe.skipIf(!process.env.TEST_REDIS_URL)("RedisCache specifics", () => {
  test("a closed Redis cache lets the process exit (spec-5 §14 risk)", async () => {
    const script = `
      import { RedisCache } from "${import.meta.dir}/../src/index";
      const cache = new RedisCache({ url: ${JSON.stringify(process.env.TEST_REDIS_URL)} });
      await cache.set("exit-check", 1, 5);
      await cache.get<unknown>("exit-check");
      await cache.close();
    `;
    const child = Bun.spawn(["bun", "-e", script]);
    const startedAt = performance.now();

    expect(await child.exited).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  test("shares a Redis connection manager: keys under <prefix>cache:, and closing the cache leaves it open", async () => {
    const redis = createRedis({ url: process.env.TEST_REDIS_URL!, prefix: `test:${crypto.randomUUID()}:` });
    const cache = new RedisCache({ redis });

    await cache.set("user:1", { name: "Ada" }, 60);
    expect(await redis.client.get(redis.key("cache", "user:1"))).toBe(JSON.stringify({ name: "Ada" }));
    await cache.close();
    expect(await redis.ping()).toBe(true);
    await redis.client.del(redis.key("cache", "user:1"));
    await redis.close();
  });

  test("ping is false when Redis is unreachable", async () => {
    const cache = new RedisCache({ url: "redis://127.0.0.1:1", connectionTimeoutMs: 200 });
    expect(await cache.ping()).toBe(false);
    await cache.close();
  });
});
