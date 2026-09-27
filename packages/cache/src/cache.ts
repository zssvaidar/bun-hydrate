export interface Cache {
  get<T>(key: string): Promise<T | null>;
  /** `ttl` is in seconds; omit it to keep the entry until it is evicted or deleted. */
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Returns the cached value, or loads, caches and returns it. Concurrent misses share one load. */
  remember<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T>;
  /** A view whose keys are prefixed, e.g. `cache.namespace("users:")`. */
  namespace(prefix: string): Cache;
  ping(): Promise<boolean>;
}

/** What an adapter provides: raw string storage. Serialization and the rest live in KeyValueCache. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CacheOptions {
  /** Called on every get() with its outcome, e.g. to count hits for metrics. */
  onLookup?: (result: "hit" | "miss") => void;
}

/**
 * Values are always JSON-serialized, in every adapter, so tests on the memory cache behave
 * exactly like production on Redis (spec-5 §5): no shared references, same failures.
 */
export class KeyValueCache implements Cache {
  constructor(
    protected readonly store: CacheStore,
    private readonly options: CacheOptions = {},
    private readonly prefix = "",
    private readonly inflight = new Map<string, Promise<unknown>>(),
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.store.get(this.prefix + key);
    this.options.onLookup?.(raw === null ? "miss" : "hit");
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (value === null) throw new TypeError("Cannot cache null: it is indistinguishable from a miss");
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
      throw new RangeError("TTL must be a positive number of seconds");
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError(`Cannot cache ${typeof value === "undefined" ? "undefined" : typeof value}`);
    await this.store.set(this.prefix + key, serialized, ttl);
  }

  delete(key: string): Promise<void> {
    return this.store.delete(this.prefix + key);
  }

  has(key: string): Promise<boolean> {
    return this.store.has(this.prefix + key);
  }

  async remember<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const fullKey = this.prefix + key;
    const pending = this.inflight.get(fullKey);
    if (pending) return pending as Promise<T>;

    const loading = (async () => {
      const value = await load();
      // null/undefined mean "nothing found": returned, but not cached (it would read as a miss anyway).
      if (value !== null && value !== undefined) await this.set(key, value, ttl);
      return value;
    })().finally(() => this.inflight.delete(fullKey));

    this.inflight.set(fullKey, loading);
    return loading;
  }

  namespace(prefix: string): Cache {
    return new KeyValueCache(this.store, this.options, this.prefix + prefix, this.inflight);
  }

  ping(): Promise<boolean> {
    return this.store.ping();
  }

  close(): Promise<void> {
    return this.store.close();
  }
}
