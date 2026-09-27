import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createDatabase, parseMigration, type Database } from "@bun-hydrate/database";
import { createTestClient } from "@bun-hydrate/testing";
import {
  API_KEYS_MIGRATION,
  DatabaseApiKeyStore,
  apiKeyStrategy,
  authenticate,
  createApiKey,
  listApiKeys,
  principal,
  requirePermission,
  revokeApiKey,
} from "../src/index";

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

let db: Database;
let store: DatabaseApiKeyStore;
let now: number;

beforeEach(async () => {
  db = createDatabase({ url: "sqlite://:memory:" });
  await db.sql.unsafe(parseMigration("api_keys", API_KEYS_MIGRATION).up);
  store = new DatabaseApiKeyStore(db);
  now = 1_800_000_000_000;
});

afterEach(() => db.close());

function createApp() {
  const app = new App({ logger: createLogger({ level: "silent" }), health: false })
    .use(authenticate({ strategies: [apiKeyStrategy({ store, now: () => now })] }))
    .get("/reports", requirePermission("reports.read"), (ctx) => ({ caller: principal(ctx) }));
  return createTestClient(app);
}

describe("API keys", () => {
  test("createApiKey returns the full key once and stores only its hash", async () => {
    const { key, record } = await createApiKey(store, { name: "CI", principalId: "svc-ci", permissions: ["reports.read"] });

    expect(key).toMatch(/^hk_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(`hk_${record.keyId}_`)).toBe(true);
    const [row] = await db.sql<{ hash: string }[]>`select * from api_keys`;
    expect(JSON.stringify(row)).not.toContain(key.split("_").slice(2).join("_"));
    expect(row!.hash).toBe(sha256(key.slice(`hk_${record.keyId}_`.length)));
  });

  test("a valid key authenticates as a service principal with its permissions", async () => {
    const { key } = await createApiKey(store, { name: "CI", principalId: "svc-ci", permissions: ["reports.read"] });

    for (const header of [{ "x-api-key": key }, { authorization: `Bearer ${key}` }]) {
      const client = createApp();
      let request = client.get("/reports");
      for (const [name, value] of Object.entries(header)) request = request.header(name, value);
      const res = await request;
      expect(res.status).toBe(200);
      expect((await res.json()).caller).toMatchObject({ id: "svc-ci", kind: "service", permissions: ["reports.read"], via: "api-key" });
    }
  });

  test("a wrong secret, an unknown key or a malformed key is a 401", async () => {
    const { record } = await createApiKey(store, { name: "CI", principalId: "svc-ci", permissions: ["reports.read"] });
    const client = createApp();

    for (const key of [`hk_${record.keyId}_${"A".repeat(43)}`, `hk_zzzzzzzzzzzz_${"A".repeat(43)}`, "hk_short"]) {
      const res = await client.get("/reports").header("x-api-key", key);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("INVALID_API_KEY");
    }
  });

  test("revoked keys stop working", async () => {
    const { key, record } = await createApiKey(store, { name: "CI", principalId: "svc-ci", permissions: ["reports.read"] });

    expect(await revokeApiKey(store, record.keyId)).toBe(true);
    expect((await createApp().get("/reports").header("x-api-key", key)).status).toBe(401);
    expect(await revokeApiKey(store, "missing")).toBe(false);
  });

  test("permissions still apply to service principals", async () => {
    const { key } = await createApiKey(store, { name: "Reader", principalId: "svc-2", permissions: ["other.read"] });
    expect((await createApp().get("/reports").header("x-api-key", key)).status).toBe(403);
  });

  test("usage is recorded at most once a minute; listing never exposes hashes", async () => {
    const { key, record } = await createApiKey(store, { name: "CI", principalId: "svc-ci", permissions: ["reports.read"] });
    const client = createApp();

    await client.get("/reports").header("x-api-key", key);
    const firstUse = now;
    now += 30_000;
    await client.get("/reports").header("x-api-key", key);

    const [listed] = await listApiKeys(store);
    expect(listed).toMatchObject({ keyId: record.keyId, name: "CI", principalId: "svc-ci", lastUsedAt: firstUse });
    expect(listed).not.toHaveProperty("hash");
  });
});
