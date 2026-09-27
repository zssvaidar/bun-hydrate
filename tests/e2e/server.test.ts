import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { connectWebSocket, spawnServer, type RunningServer } from "@bun-hydrate/testing";
import { E2E_ENV, ROOT, prepareDatabase } from "./helpers";

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

  test("is ready while running, including the database check", async () => {
    const res = await fetch(new URL("/ready", server.url));
    expect(res.status).toBe(200);
    expect((await res.json()).checks).toEqual({ database: "ok" });
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

describe("auth, CSRF, rate limits, metrics and WebSockets over real HTTP", () => {
  let server: RunningServer;
  let dataDir: string;
  const admin = { email: "root@example.com", password: "admin password 123" };
  const ada = { email: "ada@example.com", password: "correct horse battery" };

  /** A tiny cookie-keeping client, like a browser tab on the app's own origin. */
  function session() {
    let cookie = "";
    const origin = new URL(server.url).origin;
    const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(new URL(path, server.url), {
        method,
        headers: {
          origin,
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
      return res;
    };
    return { request, cookie: () => cookie };
  }

  beforeAll(async () => {
    const databaseUrl = await prepareDatabase([{ ...admin, role: "admin" }]);
    dataDir = dirname(databaseUrl.slice("sqlite://".length));
    server = await spawnServer({ cmd: ["bun", "src/main.ts"], cwd: ROOT, env: { ...E2E_ENV, NODE_ENV: "development", DATABASE_URL: databaseUrl } });
  }, 30_000);

  afterAll(async () => {
    if (server?.process.exitCode === null) await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("register, sign in, edit your own entry, and sign out; forged cross-site writes are refused", async () => {
    const root = session();
    expect((await root.request("POST", "/api/v1/auth/login", admin)).status).toBe(200);
    const created = await root.request("POST", "/api/v1/users", { name: "Ada", email: ada.email });
    expect(created.status).toBe(201);
    const entry = await created.json();

    const tab = session();
    expect((await tab.request("POST", "/api/v1/auth/register", ada)).status).toBe(201);
    expect(await (await tab.request("GET", "/api/v1/auth/me")).json()).toMatchObject({ user: { email: ada.email } });
    expect((await tab.request("GET", "/api/v1/users")).status).toBe(403);

    const renamed = await tab.request("PATCH", `/api/v1/users/${entry.id}`, { name: "Ada L." });
    expect(await renamed.json()).toMatchObject({ name: "Ada L." });
    const forged = await tab.request("PATCH", `/api/v1/users/${entry.id}`, { name: "Pwned" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(forged.status).toBe(403);

    expect((await tab.request("POST", "/api/v1/auth/logout")).status).toBe(204);
    expect(await (await tab.request("GET", "/api/v1/auth/me")).json()).toEqual({ user: null, permissions: [] });
  });

  test("guessing a password is stopped after five attempts", async () => {
    const guesser = session();
    // Counted per client IP and email; a spoofed X-Forwarded-For is ignored without TRUST_PROXY.
    const attempt = () =>
      guesser.request("POST", "/api/v1/auth/login", { email: "target@example.com", password: "guess" }, { "x-forwarded-for": "198.51.100.7" });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("/metrics reports requests by route", async () => {
    const text = await (await fetch(new URL("/metrics", server.url))).text();
    expect(text).toContain('http_requests_total{method="POST",route="/api/v1/auth/login"');
  });

  test("signed-in users chat in a room; anonymous and cross-site upgrades are refused", async () => {
    const one = session();
    const two = session();
    await one.request("POST", "/api/v1/auth/login", admin);
    await two.request("POST", "/api/v1/auth/register", { email: "bob@example.com", password: "bob password 123" });
    const url = `ws://${new URL(server.url).host}/ws/rooms/lobby`;
    const origin = new URL(server.url).origin;

    const a = await connectWebSocket(url, { headers: { cookie: one.cookie(), origin } });
    const b = await connectWebSocket(url, { headers: { cookie: two.cookie(), origin } });
    b.send("hello from bob");
    expect(JSON.parse(String(await a.next()))).toEqual({ from: "bob@example.com", text: "hello from bob" });
    expect(JSON.parse(String(await b.next()))).toEqual({ from: "bob@example.com", text: "hello from bob" });
    await Promise.all([a.close(), b.close()]);

    expect(connectWebSocket(url, { headers: { origin } })).rejects.toThrow("WebSocket connection failed");
    expect(connectWebSocket(url, { headers: { cookie: one.cookie(), origin: "https://evil.example" } })).rejects.toThrow(
      "WebSocket connection failed",
    );
  });
});
