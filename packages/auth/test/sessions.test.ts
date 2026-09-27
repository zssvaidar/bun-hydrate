import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { MemoryCache } from "@bun-hydrate/cache";
import { createDatabase, parseMigration, type Database } from "@bun-hydrate/database";
import { createTestClient } from "@bun-hydrate/testing";
import {
  CacheSessionStore,
  DatabaseSessionStore,
  SESSIONS_MIGRATION,
  SessionManager,
  authenticate,
  principal,
  requireAuth,
  type SessionStore,
} from "../src/index";

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

interface Setup {
  store: SessionStore;
  db?: Database;
  close(): Promise<void>;
}

const stores: { name: string; create: () => Promise<Setup> }[] = [
  {
    name: "database",
    create: async () => {
      const db = createDatabase({ url: "sqlite://:memory:" });
      await db.sql.unsafe(parseMigration("sessions", SESSIONS_MIGRATION).up);
      return { store: new DatabaseSessionStore(db), db, close: () => db.close() };
    },
  },
  ...(process.env.TEST_POSTGRES_URL
    ? [
        {
          name: "database",
          create: async () => {
            const db = createDatabase({ url: process.env.TEST_POSTGRES_URL! });
            await db.sql.unsafe("drop table if exists sessions");
            await db.sql.unsafe(parseMigration("sessions", SESSIONS_MIGRATION).up);
            return {
              store: new DatabaseSessionStore(db),
              db,
              close: async () => {
                await db.sql.unsafe("drop table if exists sessions");
                await db.close();
              },
            };
          },
        },
      ]
    : []),
  {
    name: "cache",
    create: async () => {
      const cache = new MemoryCache();
      return { store: new CacheSessionStore(cache), close: () => cache.close() };
    },
  },
];

describe.each(stores)("SessionManager with the $name store", ({ name, create }) => {
  let setup: Setup;
  let now: number;
  let sessions: SessionManager;
  const users = new Map([["u1", { id: "u1", kind: "user" as const, roles: ["member"], via: "session" as const }]]);

  beforeEach(async () => {
    setup = await create();
    now = 1_000_000_000_000;
    sessions = new SessionManager({
      store: setup.store,
      loadPrincipal: async (userId) => users.get(userId),
      idleTimeout: "30m",
      absoluteTimeout: "7d",
      now: () => now,
    });
  });

  afterEach(() => setup.close());

  function createApp() {
    const app = new App({ logger: createLogger({ level: "silent" }), health: false, securityHeaders: false })
      .use(authenticate({ strategies: [sessions.strategy()] }))
      .post("/login/:user", async (ctx) => {
        await sessions.create(ctx, ctx.params.user);
        return { ok: true };
      })
      .post("/logout", async (ctx) => {
        await sessions.destroy(ctx);
      })
      .get("/me", requireAuth(), (ctx) => ({ id: principal(ctx)!.id, via: principal(ctx)!.via }))
      .get("/public", (ctx) => ({ who: principal(ctx)?.id ?? "anonymous" }));
    return createTestClient(app);
  }

  const sessionId = (res: Response) => res.headers.getSetCookie()[0]!.split(";")[0]!.split("=")[1]!;

  test("login sets a secure session cookie and stores only the ID's hash", async () => {
    const res = await createApp().post("/login/u1");
    const cookie = res.headers.getSetCookie()[0]!;
    const id = sessionId(res);

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=604800");
    expect(await setup.store.find(id)).toBeUndefined();
    expect(await setup.store.find(sha256(id))).toMatchObject({ userId: "u1" });
  });

  test("the cookie authenticates later requests", async () => {
    const client = createApp();
    const id = sessionId(await client.post("/login/u1"));

    expect(await (await client.get("/me").header("cookie", `sid=${id}`)).json()).toEqual({ id: "u1", via: "session" });
  });

  test("logging in again rotates the ID; the old one stops working (no fixation)", async () => {
    const client = createApp();
    const first = sessionId(await client.post("/login/u1"));
    const second = sessionId(await client.post("/login/u1").header("cookie", `sid=${first}`));

    expect(second).not.toBe(first);
    expect((await client.get("/me").header("cookie", `sid=${first}`)).status).toBe(401);
    expect((await client.get("/me").header("cookie", `sid=${second}`)).status).toBe(200);
  });

  test("idle sessions expire; the stale cookie is cleared and the request is anonymous", async () => {
    const client = createApp();
    const id = sessionId(await client.post("/login/u1"));

    now += 31 * 60_000;
    const res = await client.get("/public").header("cookie", `sid=${id}`);

    expect(await res.json()).toEqual({ who: "anonymous" });
    expect(res.headers.getSetCookie()[0]).toMatch(/^sid=; /);
    expect(await setup.store.find(sha256(id))).toBeUndefined();
  });

  test("activity extends the idle window, but never past the absolute limit", async () => {
    const client = createApp();
    const loginTime = now;
    const cookie = `sid=${sessionId(await client.post("/login/u1"))}`;
    const sevenDays = 7 * 24 * 60 * 60_000;

    // Active every 20 minutes for the whole week: the idle timeout (30m) never triggers.
    while (now + 20 * 60_000 < loginTime + sevenDays) {
      now += 20 * 60_000;
      expect((await client.get("/me").header("cookie", cookie)).status).toBe(200);
    }
    now = loginTime + sevenDays + 1;
    expect((await client.get("/me").header("cookie", cookie)).status).toBe(401);
  });

  test("activity is written at most once a minute", async () => {
    const client = createApp();
    const id = sessionId(await client.post("/login/u1"));
    const loginTime = now;

    now += 30_000;
    await client.get("/me").header("cookie", `sid=${id}`);
    expect((await setup.store.find(sha256(id)))!.lastSeenAt).toBe(loginTime);

    now += 40_000;
    await client.get("/me").header("cookie", `sid=${id}`);
    expect((await setup.store.find(sha256(id)))!.lastSeenAt).toBe(now);
  });

  test("logout deletes the session and clears the cookie", async () => {
    const client = createApp();
    const id = sessionId(await client.post("/login/u1"));
    const res = await client.post("/logout").header("cookie", `sid=${id}`);

    expect(res.headers.getSetCookie()[0]).toMatch(/^sid=; /);
    expect((await client.get("/me").header("cookie", `sid=${id}`)).status).toBe(401);
  });

  test("a forged cookie is anonymous and gets cleared", async () => {
    const res = await createApp().get("/public").header("cookie", "sid=forged-value");

    expect(await res.json()).toEqual({ who: "anonymous" });
    expect(res.headers.getSetCookie()[0]).toMatch(/^sid=; /);
  });

  test("a session whose user no longer exists is ended", async () => {
    const client = createApp();
    users.set("gone", { id: "gone", kind: "user", roles: [], via: "session" });
    const id = sessionId(await client.post("/login/gone"));
    users.delete("gone");

    expect((await client.get("/me").header("cookie", `sid=${id}`)).status).toBe(401);
    expect(await setup.store.find(sha256(id))).toBeUndefined();
  });

  if (name === "database") {
    test("destroyAllFor signs a user out everywhere", async () => {
      const client = createApp();
      const laptop = sessionId(await client.post("/login/u1"));
      const phone = sessionId(await client.post("/login/u1"));

      expect(await sessions.destroyAllFor("u1")).toBe(2);
      expect((await client.get("/me").header("cookie", `sid=${laptop}`)).status).toBe(401);
      expect((await client.get("/me").header("cookie", `sid=${phone}`)).status).toBe(401);
    });

    test("purgeExpired deletes idle and past-limit sessions and keeps live ones (for a cleanup job)", async () => {
      const client = createApp();
      const idle = sessionId(await client.post("/login/u1"));
      now += 25 * 60_000;
      const live = sessionId(await client.post("/login/u1"));
      now += 10 * 60_000; // the first is 35 minutes idle, the second 10

      expect(await sessions.purgeExpired()).toBe(1);
      expect(await setup.store.find(sha256(idle))).toBeUndefined();
      expect(await setup.store.find(sha256(live))).toBeDefined();

      // Past the absolute limit, even when active a moment ago.
      await setup.store.touch(sha256(live), now + 7 * 24 * 60 * 60_000);
      now += 7 * 24 * 60 * 60_000 + 1;
      expect(await sessions.purgeExpired()).toBe(1);
    });
  } else {
    test("purgeExpired has nothing to do: cache entries expire on their own", async () => {
      await createApp().post("/login/u1");
      expect(await sessions.purgeExpired()).toBe(0);
    });

    test("destroyAllFor explains that a cache store cannot enumerate sessions", async () => {
      await expect(sessions.destroyAllFor("u1")).rejects.toThrow(
        "This session store cannot end all sessions of a user; use DatabaseSessionStore",
      );
    });
  }
});
