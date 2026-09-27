import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { authSnapshot, authenticate, definePolicy, type Strategy } from "../src/index";

const strategy: Strategy = {
  name: "test",
  async authenticate(ctx) {
    return ctx.headers.get("x-user")
      ? { id: "u1", kind: "user", roles: ["member"], via: "session", claims: { name: "Ada", email: "ada@example.com", secret: "s3cr3t" } }
      : undefined;
  },
};

function createApp() {
  const app = new App({ logger: createLogger({ level: "silent" }), health: false })
    .use(authenticate({ strategies: [strategy], policy: definePolicy({ roles: { member: ["profile.*"] } }) }))
    .get("/snapshot", (ctx) => authSnapshot(ctx, { user: (p) => ({ id: p.id, name: p.claims?.name }) }));
  return createTestClient(app);
}

describe("authSnapshot", () => {
  test("contains only the fields the user mapper returns, plus resolved permissions", async () => {
    const snapshot = await (await createApp().get("/snapshot").header("x-user", "1")).json();

    expect(snapshot).toEqual({ user: { id: "u1", name: "Ada" }, permissions: ["profile.*"] });
    expect(JSON.stringify(snapshot)).not.toContain("s3cr3t");
  });

  test("anonymous requests get an empty snapshot", async () => {
    expect(await (await createApp().get("/snapshot")).json()).toEqual({ user: null, permissions: [] });
  });
});
