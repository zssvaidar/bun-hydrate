import { describe, expect, test } from "bun:test";
import { ConfigError, type Middleware } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

const passthrough: Middleware = (_ctx, next) => next();

function client() {
  const config = loadConfig({ LOG_LEVEL: "silent" });
  return createTestClient(createApp({ config, assets: { scripts: ["/assets/client-test.js"], middleware: passthrough } }));
}

function payloadOf(html: string) {
  const match = html.match(/<script type="application\/json" id="__HYDRATE__">(.*?)<\/script>/s);
  return JSON.parse(match![1]!);
}

describe("reference app", () => {
  test("GET / server-renders the home page and ships the hydration payload", async () => {
    const res = await client().get("/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<title>bun-hydrate</title>");
    expect(html).toContain("<h1>bun-hydrate</h1>");
    expect(html).toContain('<script type="module" src="/assets/client-test.js"></script>');
    expect(payloadOf(html)).toMatchObject({ page: "Home", props: { initialCount: 0 } });
  });

  test("GET /page/:id renders the detail page from the route param", async () => {
    const html = await (await client().get("/page/42")).text();

    expect(html).toContain("<title>Page 42</title>");
    expect(html).toContain("Page <!-- -->42");
    expect(payloadOf(html)).toEqual({ page: "PageDetail", props: { id: "42" } });
  });

  test("GET /api/time returns the server time as JSON", async () => {
    const body = await (await client().get("/api/time")).json();
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  test("GET /health is ok", async () => {
    const res = await client().get("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  test("unknown routes are JSON 404s with a request ID", async () => {
    const res = await client().get("/missing").header("x-request-id", "app-test-1");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not Found", requestId: "app-test-1" },
    });
  });
});

describe("loadConfig", () => {
  test("has sensible defaults", () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
      logFormat: undefined,
    });
  });

  test("rejects invalid values at startup", () => {
    expect(() => loadConfig({ PORT: "eighty" })).toThrow(ConfigError);
  });
});
