import { RedisClient } from "bun";
import { KeyValueCache, type CacheOptions, type CacheStore } from "./cache";

export interface RedisCacheOptions extends CacheOptions {
  /** redis://… URL; the cache owns (and closes) the client it creates. */
  url?: string;
  /** Or share an existing client; it is not closed by the cache. */
  client?: RedisClient;
  /** Prepended to every key, e.g. "myapp:cache:". */
  prefix?: string;
  connectionTimeoutMs?: number;
}

/** Errors propagate: a cache outage should be visible, not silently turned into misses (spec-5 §5). */
class RedisStore implements CacheStore {
  constructor(
    private readonly client: RedisClient,
    private readonly ownsClient: boolean,
  ) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const args = ttlSeconds === undefined ? [key, value] : [key, value, "EX", String(Math.ceil(ttlSeconds))];
    await this.client.send("SET", args);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async has(key: string): Promise<boolean> {
    return Boolean(await this.client.exists(key));
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.send("PING", [])) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient) this.client.close();
  }
}

export class RedisCache extends KeyValueCache {
  constructor(options: RedisCacheOptions) {
    const client =
      options.client ??
      new RedisClient(options.url, {
        connectionTimeout: options.connectionTimeoutMs ?? 5_000,
        autoReconnect: true,
      });
    super(new RedisStore(client, options.client === undefined), options, options.prefix ?? "");
  }
}
