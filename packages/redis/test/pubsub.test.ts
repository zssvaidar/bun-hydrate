import { afterEach, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { connectWebSocket } from "@bun-hydrate/testing";
import { createRedis, redisPubSub, type Redis } from "../src";

const url = process.env.TEST_REDIS_URL;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function instance(redis: Redis) {
  const app = new App({ logger: createLogger({ level: "silent" }), health: false, pubsub: redisPubSub(redis) }).websocket("/ws/:room", {
    open: (ws) => void ws.subscribe("lobby"),
  });
  const server = await app.listen({ port: 0, hostname: "127.0.0.1", handleSignals: false });
  cleanup.push(() => app.stop({ timeoutMs: 1_000 }));
  return { app, url: `ws://127.0.0.1:${server.port}/ws/lobby` };
}

test.if(Boolean(url))("messages published on one instance reach sockets on every instance through Redis", async () => {
  const prefix = `test:${crypto.randomUUID()}:`;
  const [ra, rb] = [createRedis({ url: url!, prefix }), createRedis({ url: url!, prefix })];
  cleanup.push(() => ra.close(), () => rb.close());
  const a = await instance(ra);
  const b = await instance(rb);
  const onA = await connectWebSocket(a.url);
  const onB = await connectWebSocket(b.url);
  onB.raw.binaryType = "arraybuffer";

  await a.app.publish("lobby", "hello from a");
  expect(await onA.next()).toBe("hello from a");
  expect(await onB.next()).toBe("hello from a");

  await b.app.publish("lobby", new Uint8Array([0, 1, 254]));
  expect([...new Uint8Array((await onB.next()) as ArrayBuffer)]).toEqual([0, 1, 254]);
  await Promise.all([onA.close(), onB.close()]);
});

test.if(Boolean(url))("publishing fails loudly when Redis is unreachable", async () => {
  const down = createRedis({ url: "redis://127.0.0.1:1", connectionTimeoutMs: 200 });
  cleanup.push(() => down.close());
  expect(redisPubSub(down).publish("lobby", "lost")).rejects.toThrow();
});
