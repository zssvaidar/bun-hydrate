import { describe, expect, test } from "bun:test";
import { createLogger } from "@bun-hydrate/core";
import { createDatabase } from "@bun-hydrate/database";
import { createRedis, type Redis } from "@bun-hydrate/redis";
import { queueContract } from "@bun-hydrate/testing/queue";
import { schema } from "@bun-hydrate/validation";
import { RedisQueueAdapter, createQueue, createWorker, defineJob } from "../src";

const url = process.env.TEST_REDIS_URL;

async function deleteKeys(redis: Redis): Promise<void> {
  const keys = (await redis.client.send("KEYS", [redis.key("*")])) as string[];
  if (keys.length > 0) await redis.client.send("DEL", keys);
}

function open(): Redis {
  return createRedis({ url: url!, prefix: `test:${crypto.randomUUID()}:` });
}

if (url) {
  queueContract("redis", () => {
    const redis = open();
    return {
      adapter: new RedisQueueAdapter({ redis }),
      cleanup: async () => {
        await deleteKeys(redis);
        await redis.close();
      },
    };
  });
}

describe.if(Boolean(url))("redis adapter specifics", () => {
  const ping = defineJob({ name: "ping", payload: schema.object({}), handle() {} });

  test("keys live under <prefix>queue:, so apps sharing a Redis don't collide", async () => {
    const redis = open();
    const queue = createQueue({ adapter: new RedisQueueAdapter({ redis }) });
    await queue.dispatch(ping, {});

    const keys = (await redis.client.send("KEYS", [redis.key("*")])) as string[];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith(redis.key("queue")))).toBe(true);
    await deleteKeys(redis);
    await redis.close();
  });

  test("dispatch inside a transaction waits for the commit (the adapter is not transactional)", async () => {
    const redis = open();
    const db = createDatabase({ url: "sqlite://:memory:" });
    const adapter = new RedisQueueAdapter({ redis });
    const queue = createQueue({ adapter, db });

    await db.transaction(async () => {
      await queue.dispatch(ping, {});
      expect((await adapter.list()).items).toEqual([]);
    });
    expect((await adapter.list()).items).toHaveLength(1);
    await deleteKeys(redis);
    await Promise.all([redis.close(), db.close()]);
  });

  test("an idle worker is woken by a new job instead of waiting for its next poll", async () => {
    const redis = open();
    const queue = createQueue({ adapter: new RedisQueueAdapter({ redis }) });
    let ranAt = 0;
    const quick = defineJob({ name: "quick", payload: schema.object({}), handle: () => void (ranAt = Date.now()) });
    const worker = createWorker({ queue, handlers: [quick], logger: createLogger({ level: "silent" }), poll: { min: 5_000, max: 5_000 }, signals: false });
    await worker.start();
    await Bun.sleep(50); // idle, sleeping for 5s

    const dispatchedAt = Date.now();
    await queue.dispatch(quick, {});
    for (let i = 0; i < 100 && ranAt === 0; i++) await Bun.sleep(10);

    expect(ranAt).toBeGreaterThan(0);
    expect(ranAt - dispatchedAt).toBeLessThan(500);
    await worker.stop();
    await deleteKeys(redis);
    await redis.close();
  });
});
