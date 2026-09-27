import { describe, expect, test } from "bun:test";
import { can, verifyJwt } from "@bun-hydrate/auth";
import { createTestPrincipal, signTestToken, testKeys } from "../src/auth";

describe("auth test helpers", () => {
  test("signTestToken signs with a throwaway ES256 key that testKeys() verifies", async () => {
    const token = await signTestToken({ sub: "u1", roles: ["admin"] });
    const claims = await verifyJwt(token, [(await testKeys()).publicKey]);
    expect(claims).toMatchObject({ sub: "u1", roles: ["admin"] });
  });

  test("createTestPrincipal builds a principal with permissions resolved from roles", () => {
    const admin = createTestPrincipal({ id: "a1", roles: ["admin"], policy: { roles: { admin: ["*"] } } });
    expect(admin).toMatchObject({ id: "a1", kind: "user", roles: ["admin"], via: "session" });
    expect(can(admin, "anything.at.all")).toBe(true);
    expect(can(createTestPrincipal({ permissions: ["users.read"] }), "users.delete")).toBe(false);
  });
});
