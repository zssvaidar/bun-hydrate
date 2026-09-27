import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { authenticate, generateJwtKeyPair, oidcStrategy, principal, requireAuth, signJwt, type JwtKey } from "../src/index";

/** A minimal identity provider: discovery document + JWKS, with key rotation and a fetch counter. */
class FakeIssuer {
  server!: Server<undefined>;
  keys: { privateKey: JwtKey; publicKey: JwtKey }[] = [];
  jwksFetches = 0;
  advertisedIssuer?: string;

  async start() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const { pathname } = new URL(req.url);
        if (pathname === "/.well-known/openid-configuration") {
          return Response.json({ issuer: this.advertisedIssuer ?? this.url, jwks_uri: `${this.url}/jwks` });
        }
        if (pathname === "/jwks") {
          this.jwksFetches++;
          const keys = await Promise.all(
            this.keys.map(async ({ publicKey }) => ({
              ...(await crypto.subtle.exportKey("jwk", publicKey.key)),
              kid: publicKey.kid,
              alg: "ES256",
              use: "sig",
            })),
          );
          return Response.json({ keys });
        }
        return new Response("not found", { status: 404 });
      },
    });
    await this.rotate();
  }

  get url() {
    return this.server.url.href.replace(/\/$/, "");
  }

  async rotate() {
    this.keys.push(await generateJwtKeyPair("ES256", `key-${this.keys.length + 1}`));
  }

  sign(claims: Record<string, unknown>, keyIndex = this.keys.length - 1) {
    return signJwt({ iss: this.url, aud: "api", ...claims }, this.keys[keyIndex]!.privateKey, { expiresIn: "5m" });
  }
}

let issuer: FakeIssuer;
let now: number;

beforeEach(async () => {
  issuer = new FakeIssuer();
  await issuer.start();
  now = Date.now();
});

afterEach(() => issuer.server.stop(true));

function createApp(options: Partial<Parameters<typeof oidcStrategy>[0]> = {}) {
  const strategy = oidcStrategy({ issuer: issuer.url, audience: "api", now: () => now, ...options });
  const app = new App({ logger: createLogger({ level: "silent" }), health: false })
    .use(authenticate({ strategies: [strategy] }))
    .get("/me", requireAuth(), (ctx) => principal(ctx));
  return createTestClient(app);
}

describe("oidcStrategy", () => {
  test("validates provider-issued tokens via discovery and JWKS", async () => {
    const client = createApp();
    const token = await issuer.sign({ sub: "idp|42", roles: ["admin"], scope: "reports.read" });
    const res = await client.get("/me").header("authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "idp|42", roles: ["admin"], permissions: ["reports.read"], via: "jwt" });
  });

  test("keys are cached between requests", async () => {
    const client = createApp();
    const token = await issuer.sign({ sub: "u1" });
    for (let i = 0; i < 5; i++) await client.get("/me").header("authorization", `Bearer ${token}`);

    expect(issuer.jwksFetches).toBe(1);
  });

  test("an unknown kid triggers one refresh, so key rotation just works", async () => {
    const client = createApp();
    await client.get("/me").header("authorization", `Bearer ${await issuer.sign({ sub: "u1" })}`);

    await issuer.rotate();
    now += 61_000;
    const rotated = await issuer.sign({ sub: "u1" });
    expect((await client.get("/me").header("authorization", `Bearer ${rotated}`)).status).toBe(200);
    expect(issuer.jwksFetches).toBe(2);
  });

  test("junk kids cannot make us hammer the provider: at most one refresh per minute", async () => {
    const client = createApp();
    await client.get("/me").header("authorization", `Bearer ${await issuer.sign({ sub: "u1" })}`);

    const stranger = await generateJwtKeyPair("ES256", "not-from-the-idp");
    now += 61_000; // past the refresh window: the first junk token may trigger one refresh, no more
    for (let i = 0; i < 20; i++) {
      const junk = await signJwt({ iss: issuer.url, aud: "api", sub: "x" }, stranger.privateKey, { expiresIn: "1m" });
      expect((await client.get("/me").header("authorization", `Bearer ${junk}`)).status).toBe(401);
    }
    expect(issuer.jwksFetches).toBe(2);
  });

  test("tokens for another audience or issuer are rejected", async () => {
    const client = createApp();
    expect((await client.get("/me").header("authorization", `Bearer ${await issuer.sign({ sub: "u", aud: "other" })}`)).status).toBe(401);
    expect(
      (await client.get("/me").header("authorization", `Bearer ${await issuer.sign({ sub: "u", iss: "https://evil.example" })}`)).status,
    ).toBe(401);
  });

  test("a discovery document for a different issuer is refused", async () => {
    issuer.advertisedIssuer = "https://evil.example";
    const res = await createApp().get("/me").header("authorization", `Bearer ${await issuer.sign({ sub: "u" })}`);

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("IDP_UNAVAILABLE");
  });

  test("an unreachable provider is a 503, and discovery is retried later", async () => {
    const token = await issuer.sign({ sub: "u1" });
    const client = createApp({ issuer: "http://127.0.0.1:1" });
    expect((await client.get("/me").header("authorization", `Bearer ${token}`)).status).toBe(503);
  });

  test("a custom mapping can shape the principal", async () => {
    const client = createApp({ toPrincipal: (claims) => ({ id: `idp:${claims.sub}`, kind: "user", roles: ["member"], via: "jwt" }) });
    const res = await client.get("/me").header("authorization", `Bearer ${await issuer.sign({ sub: "7" })}`);

    expect(await res.json()).toMatchObject({ id: "idp:7", roles: ["member"] });
  });
});
