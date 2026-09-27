import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App, ConfigError, Router, createLogger } from "@bun-hydrate/core";
import { Database, createDatabase, parseMigration } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { createTestClient } from "@bun-hydrate/testing";
import {
  API_KEYS_MIGRATION,
  SESSIONS_MIGRATION,
  SessionManager,
  createApiKey,
  createAuth,
  defineAuthFeature,
  definePolicy,
  principal,
  requireAuth,
  type AuthFeature,
} from "../src";
import { ApiKeys, JwtIssuer, LoadPrincipal, apiKeysFeature, jwtFeature, oidcFeature, sessionsFeature } from "../src/features";

const policy = definePolicy({ roles: { admin: ["*"], member: ["notes.read"] } });
const SECRET = "x".repeat(32);

/** Stands in for the app's generated core feature: every principal is a member. */
const core = defineAuthFeature({
  id: "auth:core",
  register: (container) =>
    void container.value(LoadPrincipal, async (id) => (id === "gone" ? undefined : { id, kind: "user", roles: ["member"] })),
});

let db: Database;
beforeEach(async () => {
  db = createDatabase({ url: "sqlite://:memory:" });
  for (const migration of [SESSIONS_MIGRATION, API_KEYS_MIGRATION]) await db.sql.unsafe(parseMigration("m", migration).up);
});
afterEach(() => db.close());

/** An app with the given features and one route that reports who is calling. */
function appWith(features: AuthFeature[], extra: (router: Router, container: Container) => void = () => {}) {
  const container = new Container().value(Database, db);
  const app = new App({ logger: createLogger({ level: "silent" }), health: false, securityHeaders: false });
  app.get("/whoami", requireAuth(), (ctx) => ({ id: principal(ctx)!.id, via: principal(ctx)!.via }));
  createAuth({ config: { policy }, features }).install(app, container);
  extra(app, container);
  return { client: createTestClient(app, { cookies: true }), container };
}

describe("sessionsFeature", () => {
  test("registers a SessionManager whose cookie signs requests in", async () => {
    const { client } = appWith([core, sessionsFeature({ env: {} })], (router, container) =>
      router.post("/login", async (ctx) => void (await container.get(SessionManager).create(ctx, "u1"))),
    );

    expect((await client.get("/whoami")).status).toBe(401);
    await client.post("/login").header("origin", "http://localhost");
    expect(await (await client.get("/whoami")).json()).toEqual({ id: "u1", via: "session" });
  });

  test("installs csrf(), so a cross-site cookie POST is refused", async () => {
    const { client } = appWith([core, sessionsFeature({ env: {} })], (router, container) =>
      router.post("/login", async (ctx) => void (await container.get(SessionManager).create(ctx, "u1"))),
    );
    expect((await client.post("/login").header("origin", "https://evil.example")).status).toBe(403);
  });

  test("reads timeouts from the environment", async () => {
    let now = 0;
    const { client } = appWith([core, sessionsFeature({ env: { SESSION_IDLE_TIMEOUT: "1m" }, now: () => now })], (router, container) =>
      router.post("/login", async (ctx) => void (await container.get(SessionManager).create(ctx, "u1"))),
    );
    await client.post("/login").header("origin", "http://localhost");
    now += 61_000;
    expect((await client.get("/whoami")).status).toBe(401);
    expect(() => appWith([core, sessionsFeature({ env: { SESSION_IDLE_TIMEOUT: "soon" } })])).toThrow(
      "SESSION_IDLE_TIMEOUT: expected a duration",
    );
  });

  test("requires the core feature", () => {
    expect(() => createAuth({ config: { policy }, features: [sessionsFeature()] })).toThrow('requires "auth:core"');
  });
});

describe("jwtFeature", () => {
  test("issues tokens that its own strategy accepts", async () => {
    const { client, container } = appWith([core, jwtFeature({ env: { JWT_SECRET: SECRET } })]);
    const issued = await container.get(JwtIssuer).issue({ id: "u7", roles: ["member"] });

    expect(issued).toEqual({ token: expect.any(String), tokenType: "Bearer", expiresIn: 900 });
    expect(await (await client.get("/whoami").bearer(issued.token)).json()).toEqual({ id: "u7", via: "jwt" });
    expect((await client.get("/whoami").bearer("not-a-token")).status).toBe(401);
  });

  test("extra claims (e.g. the email) travel in the token, but cannot override the reserved ones", async () => {
    const { client, container } = appWith([core, jwtFeature({ env: { JWT_SECRET: SECRET } })], (router) =>
      router.get("/claims", (ctx) => principal(ctx)?.claims ?? null),
    );
    const { token } = await container.get(JwtIssuer).issue({ id: "u7", roles: ["member"], claims: { email: "ada@example.com", sub: "admin", iat: 1, roles: ["admin"] } });

    const claims = await (await client.get("/claims").bearer(token)).json();
    expect(claims).toMatchObject({ sub: "u7", email: "ada@example.com", roles: ["member"] });
    expect(claims.iat).toBeGreaterThan(1);
  });

  test("fails at startup when JWT_SECRET is missing or too short", () => {
    expect(() => appWith([core, jwtFeature({ env: {} })])).toThrow(ConfigError);
    expect(() => appWith([core, jwtFeature({ env: { JWT_SECRET: "short" } })])).toThrow("JWT_SECRET: expected at least 32 characters");
  });
});

describe("apiKeysFeature", () => {
  test("registers the key store and accepts its keys", async () => {
    const { client, container } = appWith([core, apiKeysFeature()]);
    const { key } = await createApiKey(container.get(ApiKeys), { name: "ci", principalId: "svc-ci", permissions: ["notes.read"] });

    expect(await (await client.get("/whoami").header("x-api-key", key)).json()).toEqual({ id: "svc-ci", via: "api-key" });
  });
});

describe("oidcFeature", () => {
  test("needs the issuer and audience", () => {
    expect(() => appWith([core, oidcFeature({ env: {} })])).toThrow("OIDC_ISSUER");
    expect(() => appWith([core, oidcFeature({ env: { OIDC_ISSUER: "https://idp.example", OIDC_AUDIENCE: "api" } })])).not.toThrow();
  });
});
