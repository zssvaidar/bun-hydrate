import { createRedis } from "../../src";

const redis = createRedis({ url: process.env.REDIS_URL!, prefix: "fixture:" });
await redis.subscribe(redis.key("a"), () => {});
await redis.subscribe(redis.key("b"), () => {});
await redis.close();
console.log("closed");
