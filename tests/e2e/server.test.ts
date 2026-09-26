import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnServer, type RunningServer } from "@bun-hydrate/testing";
import { E2E_ENV, ROOT } from "./helpers";

describe("development server (bun src/main.ts)", () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await spawnServer({ cmd: ["bun", "src/main.ts"], cwd: ROOT, env: { ...E2E_ENV, NODE_ENV: "development" } });
  });

  afterAll(async () => {
    if (server.process.exitCode === null) await server.stop();
  });

  test("serves the server-rendered page over real HTTP", async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>bun-hydrate</h1>");
  });

  test("serves the in-memory client bundle referenced by the page", async () => {
    const html = await (await fetch(server.url)).text();
    const src = html.match(/<script type="module" src="([^"]+)"/)![1]!;

    const res = await fetch(new URL(src, server.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("is ready while running", async () => {
    const res = await fetch(new URL("/ready", server.url));
    expect(res.status).toBe(200);
  });

  test("development errors do not leak for client mistakes but carry request IDs", async () => {
    const res = await fetch(new URL("/nope", server.url));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });

  test("SIGTERM shuts down gracefully with exit code 0", async () => {
    const code = await server.stop("SIGTERM");

    expect(code).toBe(0);
    const messages = server.output().map((line) => JSON.parse(line).msg);
    expect(messages).toContain("Shutting down");
    expect(messages.at(-1)).toBe("Stopped");
  });
});

describe("startup configuration errors", () => {
  test("invalid configuration exits 1 with every problem listed", () => {
    const result = Bun.spawnSync(["bun", "src/main.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: "eighty", LOG_LEVEL: "loud" },
      stderr: "pipe",
    });
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Invalid configuration:");
    expect(stderr).toContain('PORT: expected a port number (0-65535), received "eighty"');
    expect(stderr).toContain("LOG_LEVEL: expected one of");
  });
});
