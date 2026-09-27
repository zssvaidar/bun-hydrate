import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, type Middleware } from "@bun-hydrate/core";
import type { Database } from "@bun-hydrate/database";
import { createTestClient } from "@bun-hydrate/testing";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

const passthrough: Middleware = (_ctx, next) => next();
const databases: Database[] = [];

// storage:local writes under STORAGE_ROOT (default data/storage): keep test files out of the repo.
let storageRoot: string;
beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "reference-app-storage-"));
  process.env.STORAGE_ROOT = storageRoot;
});
afterAll(() => rm(storageRoot, { recursive: true, force: true }));

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

describe("jobs and events", () => {
  test("registering queues the welcome mail in the same transaction as the account", async () => {
    const { db, client } = await setup();
    expect((await client.post("/api/v1/auth/register").header("origin", ORIGIN).json(ada)).status).toBe(201);

    const jobs = await db.sql<{ name: string; payload: string }[]>`select name, payload from hydrate_jobs`;
    expect(jobs.map((job) => job.name)).toEqual(["event:account.registered:welcome-email"]);
    expect(JSON.parse(jobs[0]!.payload)).toMatchObject({ email: ada.email });
  });

  test("a registration that fails queues nothing", async () => {
    const { db, client } = await setup();
    await client.post("/api/v1/auth/register").header("origin", ORIGIN).json(ada);
    await client.post("/api/v1/auth/logout").header("origin", ORIGIN);
    expect((await client.post("/api/v1/auth/register").header("origin", ORIGIN).json(ada)).status).toBe(409);

    expect(await db.sql`select id from hydrate_jobs`).toHaveLength(1);
  });
});

/** The smallest valid PNG signature plus padding: enough for type sniffing. */
const png = (size = 64) => new Uint8Array(size).map((_, i) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? 0);

function avatarForm(bytes: Uint8Array<ArrayBuffer>, name = "me.png", type = "image/png") {
  const form = new FormData();
  form.append("avatar", new File([bytes], name, { type }));
  return form;
}

describe("avatars", () => {
  const AVATAR = "/api/v1/users/me/avatar";

  async function signedIn() {
    const { client } = await setup();
    await client.post("/api/v1/auth/register").header("origin", ORIGIN).json(ada);
    return client;
  }

  test("upload, then get a signed URL that serves the image with safe headers", async () => {
    const client = await signedIn();
    expect((await client.get(AVATAR)).status).toBe(404);

    const uploaded = await client.put(AVATAR).header("origin", ORIGIN).form(avatarForm(png()));
    expect(uploaded.status).toBe(200);
    const { url } = await uploaded.json();
    expect(url).toMatch(/^\/files\/avatars\/[^/?]+\?expires=\d+&sig=/);
    expect((await (await client.get(AVATAR)).json()).url).toStartWith("/files/avatars/");

    const image = await client.get(url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png());
  });

  test("the home page shows the signed-in user's avatar", async () => {
    const client = await signedIn();
    await client.put(AVATAR).header("origin", ORIGIN).form(avatarForm(png()));

    const html = await (await client.get("/")).text();
    expect(html).toMatch(/<img[^>]+src="\/files\/avatars\/[^"]+"/);
    expect(payloadOf(html).props.avatarUrl).toStartWith("/files/avatars/");
  });

  test("an HTML file named .png is refused: the bytes decide, not the name or type", async () => {
    const client = await signedIn();
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    const res = await client.put(AVATAR).header("origin", ORIGIN).form(avatarForm(html));
    expect(res.status).toBe(422);
  });

  test("images over 2 MB are refused", async () => {
    const client = await signedIn();
    const res = await client.put(AVATAR).header("origin", ORIGIN).form(avatarForm(png(2 * 1024 * 1024 + 1)));
    expect(res.status).toBe(422);
    expect((await res.json()).error.details[0].message).toBe("must be at most 2 MB");
  });

  test("signed out, there is no avatar to set", async () => {
    expect((await (await client()).put(AVATAR).header("origin", ORIGIN).form(avatarForm(png()))).status).toBe(401);
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
      outboxPath: "data/outbox.jsonl",
      redisUrl: undefined,
      redisPrefix: "bun-hydrate:",
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

describe("client bundle", () => {
  test("stays free of server code (core, the renderer, node: modules)", async () => {
    const result = await Bun.build({ entrypoints: ["src/web/client.tsx"], target: "browser", metafile: true });
    const inputs = Object.keys(result.metafile!.inputs);

    expect(result.success).toBe(true);
    expect(inputs.filter((input) => input.includes("packages/core") || input.includes("renderer") || input.startsWith("node:"))).toEqual([]);
  });
});
