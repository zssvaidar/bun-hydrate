import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import {
  JwtError,
  authenticate,
  generateJwtKeyPair,
  hmacKey,
  jwtStrategy,
  principal,
  requireAuth,
  signJwt,
  verifyJwt,
} from "../src/index";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const NOW = 1_800_000_000_000;
const at = () => NOW;

describe("signJwt / verifyJwt", () => {
  test.each(["HS256", "ES256", "RS256"] as const)("round-trips %s", async (alg) => {
    const { privateKey, publicKey } =
      alg === "HS256"
        ? { privateKey: await hmacKey("x".repeat(32)), publicKey: await hmacKey("x".repeat(32)) }
        : await generateJwtKeyPair(alg);

    const token = await signJwt({ sub: "u1", role: "admin" }, privateKey, { expiresIn: "15m", now: at });
    const claims = await verifyJwt(token, [publicKey], { now: at });

    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString())).toEqual({ alg, typ: "JWT" });
    expect(claims).toMatchObject({ sub: "u1", role: "admin", iat: NOW / 1000, exp: NOW / 1000 + 900 });
  });

  test("HMAC secrets shorter than 32 bytes are refused", async () => {
    await expect(hmacKey("short")).rejects.toThrow("HS256 secrets must be at least 32 bytes");
  });

  test("alg none is always rejected", async () => {
    const key = await hmacKey("x".repeat(32));
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "u1", exp: NOW / 1000 + 60 })}.`;

    await expect(verifyJwt(unsigned, [key], { now: at })).rejects.toThrow(JwtError);
  });

  test("algorithm confusion is rejected (HS256 token 'signed' with the RS256 public key)", async () => {
    const { publicKey } = await generateJwtKeyPair("RS256");
    const publicDer = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey.key));
    const forgedKey = await crypto.subtle.importKey("raw", publicDer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "admin", exp: NOW / 1000 + 60 })}`;
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", forgedKey, new TextEncoder().encode(input))).toString(
      "base64url",
    );

    await expect(verifyJwt(`${input}.${signature}`, [publicKey], { now: at })).rejects.toThrow("No key for algorithm HS256");
  });

  test("a tampered payload fails the signature check", async () => {
    const key = await hmacKey("x".repeat(32));
    const [header, , signature] = (await signJwt({ sub: "u1" }, key, { expiresIn: "1m", now: at })).split(".");
    const tampered = `${header}.${b64({ sub: "admin", exp: NOW / 1000 + 60, iat: NOW / 1000 })}.${signature}`;

    await expect(verifyJwt(tampered, [key], { now: at })).rejects.toThrow("Invalid signature");
  });

  test("time claims are enforced with clock skew", async () => {
    const key = await hmacKey("x".repeat(32));
    const token = await signJwt({ sub: "u1" }, key, { expiresIn: "1m", now: at });

    expect(await verifyJwt(token, [key], { now: () => NOW + 80_000 })).toBeTruthy(); // 20s past exp, within 30s skew
    await expect(verifyJwt(token, [key], { now: () => NOW + 120_000 })).rejects.toThrow("Token expired");

    const future = await signJwt({ sub: "u1", nbf: NOW / 1000 + 600 }, key, { expiresIn: "1h", now: at });
    await expect(verifyJwt(future, [key], { now: at })).rejects.toThrow("Token not yet valid");
  });

  test("tokens without exp are rejected unless explicitly allowed", async () => {
    const key = await hmacKey("x".repeat(32));
    const forever = await signJwt({ sub: "u1" }, key, { now: at });

    await expect(verifyJwt(forever, [key], { now: at })).rejects.toThrow("Token has no expiry");
    expect(await verifyJwt(forever, [key], { now: at, requireExpiry: false })).toMatchObject({ sub: "u1" });
  });

  test("issuer and audience must match when configured", async () => {
    const key = await hmacKey("x".repeat(32));
    const token = await signJwt({ sub: "u1", iss: "https://auth.example.com", aud: ["api", "web"] }, key, {
      expiresIn: "1m",
      now: at,
    });

    expect(await verifyJwt(token, [key], { now: at, issuer: "https://auth.example.com", audience: "api" })).toBeTruthy();
    await expect(verifyJwt(token, [key], { now: at, issuer: "https://evil.example" })).rejects.toThrow("Wrong issuer");
    await expect(verifyJwt(token, [key], { now: at, audience: "admin" })).rejects.toThrow("Wrong audience");
  });

  test("kid selects the key; each key is bound to its algorithm", async () => {
    const one = await generateJwtKeyPair("ES256", "key-1");
    const two = await generateJwtKeyPair("ES256", "key-2");
    const token = await signJwt({ sub: "u1" }, two.privateKey, { expiresIn: "1m", now: at });

    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).kid).toBe("key-2");
    expect(await verifyJwt(token, [one.publicKey, two.publicKey], { now: at })).toMatchObject({ sub: "u1" });
    await expect(verifyJwt(token, [one.publicKey], { now: at })).rejects.toThrow("Unknown key id key-2");
  });

  test.each(["", "a.b", "not.a.jwt", "a.b.c.d"])("malformed token %p is rejected", async (token) => {
    await expect(verifyJwt(token, [await hmacKey("x".repeat(32))], { now: at })).rejects.toThrow(JwtError);
  });
});

describe("jwtStrategy", () => {
  async function createApp() {
    const { privateKey, publicKey } = await generateJwtKeyPair("ES256");
    const app = new App({ logger: createLogger({ level: "silent" }), health: false })
      .use(authenticate({ strategies: [jwtStrategy({ keys: [publicKey], audience: "api" })] }))
      .get("/me", requireAuth(), (ctx) => principal(ctx));
    return { client: createTestClient(app), sign: (claims: Record<string, unknown>) => signJwt(claims, privateKey, { expiresIn: "5m" }) };
  }

  test("a valid bearer token becomes a principal", async () => {
    const { client, sign } = await createApp();
    const token = await sign({ sub: "u1", aud: "api", roles: ["admin"], scope: "reports.read reports.export" });
    const me = await (await client.get("/me").header("authorization", `Bearer ${token}`)).json();

    expect(me).toMatchObject({
      id: "u1",
      kind: "user",
      roles: ["admin"],
      permissions: ["reports.read", "reports.export"],
      via: "jwt",
    });
  });

  test("an invalid token is a 401 with an RFC 6750 challenge", async () => {
    const { client, sign } = await createApp();
    const wrongAudience = await sign({ sub: "u1", aud: "other" });
    const res = await client.get("/me").header("authorization", `Bearer ${wrongAudience}`);

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("INVALID_TOKEN");
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="api", error="invalid_token"');
  });

  test("no Authorization header, or an API key, is left to other strategies", async () => {
    const { client } = await createApp();
    expect((await client.get("/me")).status).toBe(401);
    expect((await (await client.get("/me")).json()).error.code).toBe("UNAUTHENTICATED");
    expect((await (await client.get("/me").header("authorization", "Bearer hk_abc_def")).json()).error.code).toBe(
      "UNAUTHENTICATED",
    );
  });
});
