import { afterEach, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { installRateLimit } from "./rate-limit";

afterEach(() => {
  delete process.env.RATE_LIMIT_PER_MINUTE;
});

test("limits each client IP per minute", async () => {
  process.env.RATE_LIMIT_PER_MINUTE = "2";
  const app = new App({ logger: createLogger({ level: "silent" }), health: false });
  installRateLimit(app);
  app.get("/", () => "ok");
  const client = createTestClient(app);

  expect((await client.get("/").ip("203.0.113.1")).status).toBe(200);
  expect((await client.get("/").ip("203.0.113.1")).status).toBe(200);
  expect((await client.get("/").ip("203.0.113.1")).status).toBe(429);
  expect((await client.get("/").ip("203.0.113.2")).status).toBe(200);
});
