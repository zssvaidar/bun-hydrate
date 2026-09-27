import { UnauthorizedError, parseDuration, type Duration } from "@bun-hydrate/core";
import type { Database } from "@bun-hydrate/database";
import type { Strategy } from "./authenticate";
import { digestsEqual, randomToken, sha256Hex } from "./tokens";

export interface ApiKeyRecord {
  keyId: string;
  /** SHA-256 of the secret part; the key itself is never stored. */
  hash: string;
  name: string;
  principalId: string;
  permissions: string[];
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export type ApiKeySummary = Omit<ApiKeyRecord, "hash">;

export interface ApiKeyStore {
  insert(record: ApiKeyRecord): Promise<void>;
  find(keyId: string): Promise<ApiKeyRecord | undefined>;
  touch(keyId: string, at: number): Promise<void>;
  revoke(keyId: string, at: number): Promise<boolean>;
  list(): Promise<ApiKeyRecord[]>;
}

export const API_KEYS_MIGRATION = `-- migrate:up
create table api_keys (
  key_id varchar(32) primary key,
  hash varchar(64) not null,
  name varchar(200) not null,
  principal_id varchar(64) not null,
  permissions text not null,
  created_at bigint not null,
  last_used_at bigint,
  revoked_at bigint
);

-- migrate:down
drop table api_keys;
`;

interface ApiKeyRow {
  key_id: string;
  hash: string;
  name: string;
  principal_id: string;
  permissions: string;
  created_at: number | bigint | string;
  last_used_at: number | bigint | string | null;
  revoked_at: number | bigint | string | null;
}

const optionalNumber = (value: number | bigint | string | null) => (value === null ? undefined : Number(value));

export class DatabaseApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: Database) {}

  async insert(record: ApiKeyRecord): Promise<void> {
    await this.db.sql`insert into api_keys ${this.db.sql({
      key_id: record.keyId,
      hash: record.hash,
      name: record.name,
      principal_id: record.principalId,
      permissions: JSON.stringify(record.permissions),
      created_at: record.createdAt,
    })}`;
  }

  async find(keyId: string): Promise<ApiKeyRecord | undefined> {
    const [row] = await this.db.sql<ApiKeyRow[]>`select * from api_keys where key_id = ${keyId}`;
    return row && toRecord(row);
  }

  async touch(keyId: string, at: number): Promise<void> {
    await this.db.sql`update api_keys set last_used_at = ${at} where key_id = ${keyId}`;
  }

  async revoke(keyId: string, at: number): Promise<boolean> {
    const result = await this.db.sql`update api_keys set revoked_at = ${at} where key_id = ${keyId} and revoked_at is null`;
    return result.count > 0;
  }

  async list(): Promise<ApiKeyRecord[]> {
    const rows = await this.db.sql<ApiKeyRow[]>`select * from api_keys order by created_at`;
    return rows.map(toRecord);
  }
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    keyId: row.key_id,
    hash: row.hash,
    name: row.name,
    principalId: row.principal_id,
    permissions: JSON.parse(row.permissions) as string[],
    createdAt: Number(row.created_at),
    lastUsedAt: optionalNumber(row.last_used_at),
    revokedAt: optionalNumber(row.revoked_at),
  };
}

/** `hk_<keyId>_<secret>`: the prefix makes keys recognisable to people and secret scanners. */
const API_KEY = /^hk_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const KEY_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomKeyId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => KEY_ID_ALPHABET[byte % KEY_ID_ALPHABET.length]).join("");
}

/** Creates a key. The returned `key` is the only time the full value exists; show it once. */
export async function createApiKey(
  store: ApiKeyStore,
  input: { name: string; principalId: string; permissions: string[]; now?: number },
): Promise<{ key: string; record: ApiKeySummary }> {
  const keyId = randomKeyId();
  const secret = randomToken(32);
  const record: ApiKeyRecord = {
    keyId,
    hash: sha256Hex(secret),
    name: input.name,
    principalId: input.principalId,
    permissions: input.permissions,
    createdAt: input.now ?? Date.now(),
  };
  await store.insert(record);
  const { hash: _hash, ...summary } = record;
  return { key: `hk_${keyId}_${secret}`, record: summary };
}

export function revokeApiKey(store: ApiKeyStore, keyId: string, now = Date.now()): Promise<boolean> {
  return store.revoke(keyId, now);
}

export async function listApiKeys(store: ApiKeyStore): Promise<ApiKeySummary[]> {
  return (await store.list()).map(({ hash: _hash, ...summary }) => summary);
}

export interface ApiKeyStrategyOptions {
  store: ApiKeyStore;
  /** Last-used time is written at most this often. Default: 1m. */
  touchInterval?: Duration;
  now?: () => number;
}

function invalidKey(): UnauthorizedError {
  return new UnauthorizedError("Invalid API key", { code: "INVALID_API_KEY" });
}

/** Accepts `X-API-Key: hk_…` or `Authorization: Bearer hk_…` (spec-5 §3.6). */
export function apiKeyStrategy(options: ApiKeyStrategyOptions): Strategy {
  const touchMs = parseDuration(options.touchInterval ?? "1m");
  const now = options.now ?? Date.now;

  return {
    name: "api-key",
    async authenticate(ctx) {
      const bearer = ctx.headers.get("authorization")?.match(/^Bearer\s+(hk_\S*)$/i)?.[1];
      const presented = ctx.headers.get("x-api-key") ?? bearer;
      if (!presented) return undefined;

      const [, keyId, secret] = API_KEY.exec(presented) ?? [];
      if (!keyId || !secret) throw invalidKey();
      const record = await options.store.find(keyId);
      // Compared in constant time so response timing reveals nothing about the stored hash.
      if (!record || !digestsEqual(sha256Hex(secret), record.hash) || record.revokedAt !== undefined) {
        throw invalidKey();
      }

      const at = now();
      if (record.lastUsedAt === undefined || at - record.lastUsedAt >= touchMs) await options.store.touch(keyId, at);
      return { id: record.principalId, kind: "service", roles: [], permissions: record.permissions, via: "api-key" };
    },
  };
}
