import { describe, expect, test } from "bun:test";
import { App } from "../src/app";
import { createLogger } from "../src/logger";
import { serveStatic } from "../src/static";

const root = `${import.meta.dir}/fixtures`;

function createApp(options: Partial<Parameters<typeof serveStatic>[0]> = {}) {
  return new App({ logger: createLogger({ level: "silent" }), health: false })
    .use(serveStatic({ root, prefix: "/static", ...options }))
    .get("/static/dynamic", () => "from a route");
}

const call = (app: App, path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init));

describe("serveStatic", () => {
  test("serves files under the prefix with their content type", async () => {
    const res = await call(createApp(), "/static/hello.txt");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("hello from a file\n");
  });

  test("answers HEAD without a body", async () => {
    const res = await call(createApp(), "/static/hello.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("falls through to routes when no file matches", async () => {
    expect(await (await call(createApp(), "/static/dynamic")).text()).toBe("from a route");
    expect((await call(createApp(), "/static/missing.txt")).status).toBe(404);
  });

  test("ignores paths outside the prefix and non-GET methods", async () => {
    expect((await call(createApp(), "/hello.txt")).status).toBe(404);
    expect((await call(createApp(), "/static/hello.txt", { method: "POST" })).status).toBe(404);
  });

  test("never serves files outside the root", async () => {
    for (const path of ["/static/..%2fstatic.test.ts", "/static/%2e%2e/static.test.ts", "/static/..%5cstatic.test.ts"]) {
      const res = await call(createApp(), path);
      expect(res.status).toBe(404);
    }
  });

  test("does not serve directories", async () => {
    expect((await call(createApp({ root: import.meta.dir }), "/static/fixtures")).status).toBe(404);
  });

  test("sets cache-control when configured", async () => {
    const res = await call(createApp({ cacheControl: "public, max-age=60" }), "/static/hello.txt");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });
});
