import { describe, expect, test } from "bun:test";
import { App, UnauthorizedError, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import {
  authenticate,
  definePolicy,
  principal,
  requireAuth,
  requirePermission,
  requirePrincipal,
  requireRole,
  type Strategy,
} from "../src/index";

/** Treats `x-user: <id>:<role>` as a credential; `x-user: bad` as an invalid one. */
const headerStrategy: Strategy = {
  name: "test",
  challenge: 'Bearer realm="api"',
  async authenticate(ctx) {
    const value = ctx.headers.get("x-user");
    if (!value) return undefined;
    if (value === "bad") throw new UnauthorizedError("Invalid credentials", { code: "INVALID_TOKEN" });
    const [id, role] = value.split(":");
    return { id: id!, kind: "user", roles: role ? [role] : [], via: "session" };
  },
};

const serviceStrategy: Strategy = {
  name: "service",
  async authenticate(ctx) {
    return ctx.headers.get("x-service") ? { id: "svc", kind: "service", roles: [], permissions: ["reports.read"], via: "api-key" } : undefined;
  },
};

const policy = definePolicy({ roles: { admin: ["*"], member: ["profile.*"] } });

function createApp() {
  const lines: string[] = [];
  const app = new App({ logger: createLogger({ format: "json", write: (l) => void lines.push(l) }), health: false, logRequests: false })
    .use(authenticate({ strategies: [headerStrategy, serviceStrategy], policy }))
    .get("/public", (ctx) => ({ who: principal(ctx)?.id ?? "anonymous" }))
    .get("/me", requireAuth(), (ctx) => requirePrincipal(ctx))
    .get("/admin", requireRole("admin"), () => "admin area")
    .get("/profile", requirePermission("profile.read"), () => "profile")
    .get("/delete-users", requirePermission("users.delete", "users.read"), () => "deleted")
    .get("/reports", requirePermission("reports.read"), () => "reports");
  return { client: createTestClient(app), lines };
}

describe("authenticate()", () => {
  test("anonymous requests pass through to public routes", async () => {
    expect(await (await createApp().client.get("/public")).json()).toEqual({ who: "anonymous" });
  });

  test("a valid credential sets the principal, with permissions resolved from roles", async () => {
    const res = await createApp().client.get("/me").header("x-user", "u1:member");
    expect(await res.json()).toEqual({ id: "u1", kind: "user", roles: ["member"], permissions: ["profile.*"], via: "session" });
  });

  test("direct grants are kept and merged with role permissions", async () => {
    const res = await createApp().client.get("/reports").header("x-service", "1");
    expect(res.status).toBe(200);
  });

  test("an invalid credential is a 401, never a silent downgrade to anonymous", async () => {
    const res = await createApp().client.get("/public").header("x-user", "bad");

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("INVALID_TOKEN");
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="api"');
  });

  test("strategies are tried in order; the first principal wins", async () => {
    const res = await createApp().client.get("/me").header("x-user", "u1:admin").header("x-service", "1");
    expect((await res.json()).id).toBe("u1");
  });
});

describe("require*()", () => {
  test("requireAuth: 401 for anonymous with a challenge, 200 when signed in", async () => {
    const { client } = createApp();
    const anonymous = await client.get("/me");

    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe("UNAUTHENTICATED");
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="api"');
    expect((await client.get("/me").header("x-user", "u1:member")).status).toBe(200);
  });

  test("requirePermission: 401 anonymous, 403 lacking, 200 granted (incl. wildcards)", async () => {
    const { client } = createApp();

    expect((await client.get("/profile")).status).toBe(401);
    expect((await client.get("/delete-users").header("x-user", "u1:member")).status).toBe(403);
    expect((await client.get("/profile").header("x-user", "u1:member")).status).toBe(200);
    expect((await client.get("/delete-users").header("x-user", "u2:admin")).status).toBe(200);
  });

  test("a 403 never tells the client which permission was missing; the log does", async () => {
    const { client, lines } = createApp();
    const res = await client.get("/delete-users").header("x-user", "u1:member");

    expect(await res.text()).not.toContain("users.delete");
    expect(lines.map((l) => JSON.parse(l)).find((r) => r.msg === "Permission denied")).toMatchObject({
      principalId: "u1",
      required: ["users.delete", "users.read"],
    });
  });

  test("requireRole checks roles", async () => {
    const { client } = createApp();
    expect((await client.get("/admin").header("x-user", "u1:member")).status).toBe(403);
    expect((await client.get("/admin").header("x-user", "u2:admin")).status).toBe(200);
  });

  test("using require*() without authenticate() is a clear programming error", async () => {
    const app = new App({ logger: createLogger({ level: "silent" }), health: false, exposeErrors: true }).get(
      "/me",
      requireAuth(),
      () => "never",
    );
    const { error } = await (await createTestClient(app).get("/me")).json();

    expect(error.message).toBe("requireAuth() needs app.use(authenticate(...)) to run first");
  });
});
