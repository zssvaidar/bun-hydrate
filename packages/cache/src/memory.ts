import { KeyValueCache, type CacheOptions, type CacheStore } from "./cache";

export interface MemoryCacheOptions extends CacheOptions {
  /** Least recently used entries are evicted beyond this. Default: 10,000. */
  maxEntries?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

interface Entry {
  value: string;
  expiresAt: number | undefined;
}

const SWEEP_INTERVAL_MS = 60_000;

/** LRU + TTL in a Map: insertion order is recency order, so the first key is the eviction candidate. */
class MemoryStore implements CacheStore {
  private readonly entries = new Map<string, Entry>();
  private readonly sweeper: Timer;

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref(); // an idle cache must never keep the process alive
  }

  async get(key: string): Promise<string | null> {
    const entry = this.live(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: ttlSeconds === undefined ? undefined : this.now() + ttlSeconds * 1000 });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.live(key) !== undefined;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.entries.clear();
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweep(): void {
    for (const key of this.entries.keys()) this.live(key);
  }
}

export class MemoryCache extends KeyValueCache {
  constructor(options: MemoryCacheOptions = {}) {
    super(new MemoryStore(options.maxEntries ?? 10_000, options.now ?? Date.now), options);
  }
}
