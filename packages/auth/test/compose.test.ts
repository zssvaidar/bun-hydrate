import { describe, expect, test } from "bun:test";
import { App, Router, createLogger } from "@bun-hydrate/core";
import { Container, token } from "@bun-hydrate/di";
import { createTestClient } from "@bun-hydrate/testing";
import { createAuth, defineAuthFeature, definePolicy, principal, requirePermission, type Strategy } from "../src";

const policy = definePolicy({ roles: { admin: ["*"], member: ["notes.read"] } });
const quietApp = () => new App({ logger: createLogger({ level: "silent" }), health: false, securityHeaders: false });

/** A strategy that signs in whoever sends `x-user: <id>:<role>`. */
const headerStrategy = (name: string): Strategy => ({
  name,
  async authenticate(ctx) {
    const [id, role] = ctx.headers.get(`x-${name}`)?.split(":") ?? [];
    return id ? { id, kind: "user", roles: role ? [role] : [], via: "session" } : undefined;
  },
});

describe("createAuth", () => {
  test("rejects a feature whose requirement is missing, naming both", () => {
    const login = defineAuthFeature({ id: "auth:login", requires: ["auth:core", ["auth:sessions", "auth:jwt"]] });
    const core = defineAuthFeature({ id: "auth:core" });

    expect(() => createAuth({ config: { policy }, features: [login] })).toThrow(
      'Auth feature "auth:login" requires "auth:core", which is not in createAuth({ features })',
    );
    expect(() => createAuth({ config: { policy }, features: [core, login] })).toThrow(
      'Auth feature "auth:login" requires one of "auth:sessions", "auth:jwt", which is not in createAuth({ features })',
    );
  });

  test("rejects duplicate features", () => {
    const core = defineAuthFeature({ id: "auth:core" });
    expect(() => createAuth({ config: { policy }, features: [core, core] })).toThrow('Auth feature "auth:core" is listed twice');
  });

  test("orders features by dependency, keeping the given order otherwise", () => {
    const auth = createAuth({
      config: { policy },
      features: [
        defineAuthFeature({ id: "auth:login", requires: ["auth:passwords", "auth:core"] }),
        defineAuthFeature({ id: "auth:passwords", requires: ["auth:core"] }),
        defineAuthFeature({ id: "auth:core" }),
        defineAuthFeature({ id: "auth:api-keys", requires: ["auth:core"] }),
      ],
    });
    expect(auth.features.map((feature) => feature.id)).toEqual(["auth:core", "auth:passwords", "auth:login", "auth:api-keys"]);
    expect(auth.has("auth:passwords")).toBe(true);
    expect(auth.has("auth:jwt")).toBe(false);
  });

  test("install() registers services, then strategies in order, middleware and routes", async () => {
    const Greeting = token<string>("Greeting");
    const calls: string[] = [];
    const auth = createAuth({
      config: { policy },
      features: [
        defineAuthFeature({
          id: "auth:core",
          register: (container) => void container.value(Greeting, "hello"),
          strategies: () => [headerStrategy("first")],
        }),
        defineAuthFeature({
          id: "auth:extra",
          requires: ["auth:core"],
          strategies: () => [headerStrategy("second")],
          middleware: (container) => [
            async (ctx, next) => {
              calls.push(`${container.get(Greeting)} ${principal(ctx)?.id ?? "anonymous"}`);
              return next();
            },
          ],
          routes: () => [{ path: "/auth", router: new Router().get("/me", (ctx) => ({ id: principal(ctx)?.id ?? null })) }],
        }),
      ],
    });

    const app = quietApp().get("/notes", requirePermission("notes.read"), () => ["note"]);
    auth.install(app, new Container());
    const client = createTestClient(app);

    expect(await (await client.get("/auth/me").header("x-second", "u2:member")).json()).toEqual({ id: "u2" });
    expect(await (await client.get("/auth/me").header("x-first", "u1").header("x-second", "u2")).json()).toEqual({ id: "u1" });
    expect((await client.get("/notes").header("x-first", "u1:member")).status).toBe(200);
    expect((await client.get("/notes").header("x-first", "u1:guest")).status).toBe(403);
    expect(calls).toEqual(["hello u2", "hello u1", "hello u1", "hello u1"]);
  });

  test("snapshot() exposes only what the user mapper picks", async () => {
    const auth = createAuth({
      config: { policy, user: (p) => ({ id: p.id }) },
      features: [defineAuthFeature({ id: "auth:core", strategies: () => [headerStrategy("user")] })],
    });
    const app = quietApp().get("/snapshot", (ctx) => auth.snapshot(ctx));
    auth.install(app, new Container());
    const client = createTestClient(app);

    expect(await (await client.get("/snapshot").header("x-user", "u1:member")).json()).toEqual({
      user: { id: "u1" },
      permissions: ["notes.read"],
    });
    expect(await (await client.get("/snapshot")).json()).toEqual({ user: null, permissions: [] });
  });
});
