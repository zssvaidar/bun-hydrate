import { parseDuration, type Context, type Duration } from "@bun-hydrate/core";
import type { Strategy } from "../authenticate";
import type { UnresolvedPrincipal } from "../principal";
import { randomToken, sha256Hex } from "../tokens";
import type { SessionStore } from "./store";

export interface SessionManagerOptions {
  store: SessionStore;
  /** Loads the principal for a session's user; undefined (e.g. user deleted) ends the session. */
  loadPrincipal(userId: string): Promise<Omit<UnresolvedPrincipal, "via"> | undefined>;
  /** Cookie name. Default: "sid". */
  cookie?: string;
  /** Sliding inactivity limit. Default: 30m. */
  idleTimeout?: Duration;
  /** Hard limit from login, regardless of activity. Default: 7d. */
  absoluteTimeout?: Duration;
  /** Activity is written at most this often. Default: 1m. */
  touchInterval?: Duration;
  now?: () => number;
}

/**
 * Server-side sessions with opaque cookies (spec-5 §3.3): the cookie holds 256 random bits and
 * the store keeps only their SHA-256, so a leaked sessions table cannot be replayed.
 */
export class SessionManager {
  private readonly cookie: string;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly touchMs: number;
  private readonly now: () => number;

  constructor(private readonly options: SessionManagerOptions) {
    this.cookie = options.cookie ?? "sid";
    this.idleMs = parseDuration(options.idleTimeout ?? "30m");
    this.absoluteMs = parseDuration(options.absoluteTimeout ?? "7d");
    this.touchMs = parseDuration(options.touchInterval ?? "1m");
    this.now = options.now ?? Date.now;
  }

  /** Starts a session after login. Any session the request already had is ended first (no fixation). */
  async create(ctx: Context<any>, userId: string): Promise<void> {
    await this.endCurrent(ctx);
    const id = randomToken(32);
    const now = this.now();
    await this.options.store.insert({
      idHash: sha256Hex(id),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.absoluteMs,
      userAgent: ctx.headers.get("user-agent") ?? undefined,
      ip: ctx.ip,
    });
    ctx.cookies.set(this.cookie, id, { maxAge: Math.floor(this.absoluteMs / 1000) });
  }

  /** Logout. */
  async destroy(ctx: Context<any>): Promise<void> {
    await this.endCurrent(ctx);
    ctx.cookies.delete(this.cookie);
  }

  /** "Sign out everywhere", e.g. after a password change. Returns how many sessions ended. */
  async destroyAllFor(userId: string): Promise<number> {
    if (!this.options.store.deleteAllFor) {
      throw new Error("This session store cannot end all sessions of a user; use DatabaseSessionStore");
    }
    return this.options.store.deleteAllFor(userId);
  }

  /**
   * Browsers send cookies automatically, so a stale or unknown session cookie is not treated as a
   * failed login: the cookie is cleared and the request continues anonymously. Protected routes
   * still answer 401 through requireAuth().
   */
  strategy(): Strategy {
    return {
      name: "session",
      authenticate: async (ctx) => {
        const id = ctx.cookies.get(this.cookie);
        if (!id) return undefined;

        const idHash = sha256Hex(id);
        const record = await this.options.store.find(idHash);
        const now = this.now();
        const expired = !record || now >= record.expiresAt || now - record.lastSeenAt > this.idleMs;
        const found = expired ? undefined : await this.options.loadPrincipal(record.userId);

        if (!found) {
          if (record) await this.options.store.delete(idHash);
          ctx.cookies.delete(this.cookie);
          return undefined;
        }
        if (now - record!.lastSeenAt >= this.touchMs) await this.options.store.touch(idHash, now);
        return { ...found, via: "session" };
      },
    };
  }

  private async endCurrent(ctx: Context<any>): Promise<void> {
    const current = ctx.cookies.get(this.cookie);
    if (current) await this.options.store.delete(sha256Hex(current));
  }
}
