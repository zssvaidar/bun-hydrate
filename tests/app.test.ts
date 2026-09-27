import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError, type Middleware } from "@bun-hydrate/core";
import type { Database } from "@bun-hydrate/database";
import { createTestClient } from "@bun-hydrate/testing";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

const passthrough: Middleware = (_ctx, next) => next();
const databases: Database[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

async function setup() {
  const config = loadConfig({ LOG_LEVEL: "silent" });
  const db = await createTestDatabase({ migrations: join(import.meta.dir, "../migrations") });
  databases.push(db);
  const assets = { scripts: ["/assets/client-test.js"], middleware: passthrough };
  return { db, client: createTestClient(createApp({ config, assets, db }), { cookies: true }) };
}

async function client() {
  return (await setup()).client;
}

const ORIGIN = "http://localhost";
const ada = { email: "ada@example.com", password: "correct horse battery" };

function payloadOf(html: string) {
  const match = html.match(/<script type="application\/json" id="__HYDRATE__">(.*?)<\/script>/s);
  return JSON.parse(match![1]!);
}

describe("reference app", () => {
  test("GET / server-renders the home page and ships the hydration payload", async () => {
    const res = await (await client()).get("/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<title>bun-hydrate</title>");
    expect(html).toContain("<h1>bun-hydrate</h1>");
    expect(html).toContain('<script type="module" src="/assets/client-test.js"></script>');
    expect(payloadOf(html)).toMatchObject({ page: "Home", props: { initialCount: 0 } });
  });

  test("GET /page/:id renders the detail page from the route param", async () => {
    const html = await (await (await client()).get("/page/42")).text();

    expect(html).toContain("<title>Page 42</title>");
    expect(html).toContain("Page <!-- -->42");
    expect(payloadOf(html)).toEqual({
      page: "PageDetail",
      props: { id: "42" },
      shared: { auth: { user: null, permissions: [] } },
    });
  });

  test("GET /api/v1/time returns the server time as JSON", async () => {
    const body = await (await (await client()).get("/api/v1/time")).json();
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  test("the users module is mounted under /api/v1/users, behind authentication", async () => {
    const res = await (await client()).get("/api/v1/users");
    expect(res.status).toBe(401);
  });

  test("GET /health is ok", async () => {
    const res = await (await client()).get("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  test("unknown routes are JSON 404s with a request ID", async () => {
    const res = await (await client()).get("/missing").header("x-request-id", "app-test-1");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not Found", requestId: "app-test-1" },
    });
  });
});

describe("auth in the reference app", () => {
  test("register signs in with a cookie; pages render signed in from the first byte", async () => {
    const { client } = await setup();

    expect((await client.post("/api/v1/auth/register").header("origin", ORIGIN).json(ada)).status).toBe(201);
    expect(await (await client.get("/api/v1/auth/me")).json()).toMatchObject({ user: { email: ada.email, role: "member" } });

    const html = await (await client.get("/")).text();
    expect(html).toContain("Signed in as <strong>ada@example.com</strong>");
    expect(payloadOf(html).shared).toEqual({ auth: { user: expect.objectContaining({ email: ada.email }), permissions: [] } });
  });

  test("members cannot list users and do not see admin controls; admins can and do", async () => {
    const { client, db } = await setup();
    await client.post("/api/v1/auth/register").header("origin", ORIGIN).json(ada);

    expect((await client.get("/api/v1/users")).status).toBe(403);
    expect(await (await client.get("/")).text()).not.toContain("Admin tools");

    await db.sql`update accounts set role = ${"admin"} where email = ${ada.email}`;
    expect((await client.get("/api/v1/users")).status).toBe(200);
    expect(await (await client.get("/")).text()).toContain("Admin tools");
  });

  test("cookie-authenticated writes from another site are refused", async () => {
    const { client, db } = await setup();
    await client.post("/api/v1/auth/register").header("origin", ORIGIN).json(ada);
    await db.sql`update accounts set role = ${"admin"} where email = ${ada.email}`;

    const forged = await client.post("/api/v1/users").header("origin", "https://evil.example").json({ name: "Eve", email: "eve@example.com" });
    expect(forged.status).toBe(403);
    expect((await client.post("/api/v1/users").header("origin", ORIGIN).json({ name: "Eve", email: "eve@example.com" })).status).toBe(201);
  });

  test("signed out, the home page links to /login, which renders the login page", async () => {
    const { client } = await setup();
    expect(await (await client.get("/")).text()).toContain('href="/login"');

    const login = await (await client.get("/login")).text();
    expect(login).toContain("<title>Sign in</title>");
    expect(payloadOf(login)).toMatchObject({ page: "Login", shared: { auth: { user: null } } });
  });

  test("GET /metrics exposes request metrics by route", async () => {
    const { client } = await setup();
    await client.get("/page/7");
    expect(await (await client.get("/metrics")).text()).toContain('route="/page/:id"');
  });
});

describe("loadConfig", () => {
  test("has sensible defaults", () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
      logFormat: undefined,
      databaseUrl: "sqlite://:memory:",
      migrateOnStart: false,
      trustProxy: false,
    });
  });

  test("TRUST_PROXY is off, a hop count, or a list of proxy addresses", () => {
    expect(loadConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }).trustProxy).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(loadConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
  });

  test("rejects invalid values at startup", () => {
    expect(() => loadConfig({ PORT: "eighty" })).toThrow(ConfigError);
  });
});
