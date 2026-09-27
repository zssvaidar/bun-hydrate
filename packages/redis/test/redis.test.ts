import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRedis, type Redis } from "../src";

const url = process.env.TEST_REDIS_URL;
const opened: Redis[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((redis) => redis.close()));
});

function open(prefix = `test:${crypto.randomUUID()}:`) {
  const redis = createRedis({ url: url!, prefix });
  opened.push(redis);
  return redis;
}

describe("key()", () => {
  test("prefixes and joins parts, so several apps can share one Redis", () => {
    const redis = createRedis({ url: "redis://127.0.0.1:1", prefix: "shop:" });
    expect(redis.key("jobs", "ready")).toBe("shop:jobs:ready");
    expect(redis.key("cache")).toBe("shop:cache");
  });

  test("rejects empty parts", () => {
    expect(() => createRedis({ url: "redis://127.0.0.1:1" }).key("jobs", "")).toThrow("Redis key parts must not be empty");
  });

  test("does not connect until first used", async () => {
    const redis = createRedis({ url: "redis://127.0.0.1:1" }); // nothing listens there
    await redis.close();
  });
});

describe.if(Boolean(url))("with a Redis server", () => {
  test("runs commands on a shared client", async () => {
    const redis = open();
    await redis.client.set(redis.key("greeting"), "hello");
    expect(await redis.client.get(redis.key("greeting"))).toBe("hello");
    expect(redis.client).toBe(redis.client);
    await redis.client.del(redis.key("greeting"));
  });

  test("subscribes on a dedicated connection, so commands keep working", async () => {
    const redis = open();
    const channel = redis.key("events");
    const received: string[] = [];
    const unsubscribe = await redis.subscribe(channel, (message) => void received.push(message));

    await redis.publish(channel, "one");
    expect(await redis.client.get(redis.key("missing"))).toBeNull();
    await Bun.sleep(50);
    expect(received).toEqual(["one"]);

    await unsubscribe();
    await redis.publish(channel, "two");
    await Bun.sleep(50);
    expect(received).toEqual(["one"]);
  });

  test("ping() reports health", async () => {
    expect(await open().ping()).toBe(true);
    const down = createRedis({ url: "redis://127.0.0.1:1", connectionTimeoutMs: 200 });
    expect(await down.ping()).toBe(false);
    await down.close();
  });

  test("close() is idempotent", async () => {
    const redis = open();
    await redis.subscribe(redis.key("x"), () => {});
    await redis.close();
    await redis.close();
  });

  test("a process that subscribed exits promptly after close() (Bun keeps subscribed clients alive)", async () => {
    const script = join(import.meta.dir, "fixtures", "subscribe-and-close.ts");
    const started = Date.now();
    const child = Bun.spawn(["bun", script], { env: { ...process.env, REDIS_URL: url }, stdout: "pipe", stderr: "pipe" });
    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
    if (code === "timeout") child.kill();

    expect(code).toBe(0);
    expect(await new Response(child.stdout).text()).toContain("closed");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
