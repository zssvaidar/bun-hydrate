import { RedisClient } from "bun";

export interface RedisOptions {
  /** redis://… or rediss://… */
  url: string;
  /** Prepended to every key made with `key()`, e.g. "shop:". Default: none. */
  prefix?: string;
  /** Default: 5s. */
  connectionTimeoutMs?: number;
}

export type MessageListener = (message: string, channel: string) => void;

/**
 * One Redis per process (spec-6 §2). Commands share one client; subscriptions get their own
 * connection, because a subscribed Redis connection refuses other commands. Both connect on
 * first use.
 *
 * close() unsubscribes before closing: in Bun 1.3.11 a client closed while still subscribed
 * keeps the process alive, which would break graceful shutdown.
 */
export class Redis {
  private readonly prefix: string;
  private commandClient: RedisClient | undefined;
  private subscriberClient: RedisClient | undefined;
  private closed = false;

  constructor(private readonly options: RedisOptions) {
    this.prefix = options.prefix ?? "";
  }

  /** The shared client for commands (GET, SET, EVAL, …). */
  get client(): RedisClient {
    this.assertOpen();
    this.commandClient ??= this.connect();
    return this.commandClient;
  }

  /** `key("jobs", "ready")` → "<prefix>jobs:ready". */
  key(...parts: string[]): string {
    if (parts.length === 0 || parts.some((part) => part === "")) throw new Error("Redis key parts must not be empty");
    return this.prefix + parts.join(":");
  }

  /** Delivers messages on `channel` (exact name; use key() to prefix it). Returns an unsubscribe function. */
  async subscribe(channel: string, listener: MessageListener): Promise<() => Promise<void>> {
    this.assertOpen();
    this.subscriberClient ??= this.connect();
    const subscriber = this.subscriberClient;
    await subscriber.subscribe(channel, listener);
    return async () => {
      if (!this.closed) await subscriber.unsubscribe(channel, listener);
    };
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  /** For readiness checks: true if Redis answers PING. */
  async ping(): Promise<boolean> {
    try {
      return (await this.client.send("PING", [])) === "PONG";
    } catch {
      return false;
    }
  }

  /** Unsubscribes everything, then closes both connections. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const subscriber = this.subscriberClient;
    if (subscriber) {
      try {
        await subscriber.unsubscribe();
      } catch {
        // Not in subscriber mode any more (every channel was already unsubscribed): nothing to do.
      }
      subscriber.close();
    }
    this.commandClient?.close();
  }

  private connect(): RedisClient {
    return new RedisClient(this.options.url, {
      connectionTimeout: this.options.connectionTimeoutMs ?? 5_000,
      autoReconnect: true,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("This Redis connection manager was closed");
  }
}

export function createRedis(options: RedisOptions): Redis {
  return new Redis(options);
}
