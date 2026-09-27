import { afterEach, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { installCors } from "./cors";

afterEach(() => {
  delete process.env.CORS_ORIGINS;
});

test("answers preflights from the configured origins only", async () => {
  process.env.CORS_ORIGINS = "https://app.example, https://admin.example";
  const app = new App({ logger: createLogger({ level: "silent" }), health: false });
  installCors(app);
  app.get("/api", () => "ok");
  const client = createTestClient(app);
  const preflight = (origin: string) =>
    client.options("/api").header("origin", origin).header("access-control-request-method", "GET");

  expect((await preflight("https://admin.example")).headers.get("access-control-allow-origin")).toBe("https://admin.example");
  expect((await preflight("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
});
