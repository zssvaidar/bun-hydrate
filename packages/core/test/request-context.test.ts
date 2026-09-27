import { describe, expect, test } from "bun:test";
import { App, type AppOptions } from "../src/app";
import { NotFoundError, TooManyRequestsError } from "../src/errors";
import { createLogger } from "../src/logger";
import { Router } from "../src/router";

function createApp(options: AppOptions = {}) {
  return new App({ logger: createLogger({ level: "silent" }), health: false, ...options });
}

/** Stands in for Bun's server, which is what supplies the socket address. */
const peer = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 1234 }) });

function call(app: App, path: string, init: RequestInit & { from?: string } = {}) {
  const { from, ...rest } = init;
  return app.fetch(new Request(`http://localhost${path}`, rest), from ? peer(from) : undefined);
}

describe("ctx.ip and ctx.protocol", () => {
  const echo = () => createApp().get("/", (ctx) => ({ ip: ctx.ip, protocol: ctx.protocol }));

  test("come from the socket by default, ignoring forwarding headers", async () => {
    const res = await call(echo(), "/", { from: "203.0.113.5", headers: { "x-forwarded-for": "6.6.6.6", "x-forwarded-proto": "https" } });
    expect(await res.json()).toEqual({ ip: "203.0.113.5", protocol: "http" });
  });

  test("honour forwarding headers from trusted proxies", async () => {
    const app = createApp({ trustProxy: ["10.0.0.0/8"] }).get("/", (ctx) => ({ ip: ctx.ip, protocol: ctx.protocol }));
    const res = await call(app, "/", { from: "10.0.0.1", headers: { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "https" } });

    expect(await res.json()).toEqual({ ip: "198.51.100.7", protocol: "https" });
  });

  test("default to 127.0.0.1 when there is no socket", async () => {
    expect((await (await call(echo(), "/")).json()).ip).toBe("127.0.0.1");
  });
});

describe("ctx.route", () => {
  test("is the matched pattern, including router prefixes", async () => {
    const users = new Router().get("/:id", (ctx) => ({ route: ctx.route }));
    const app = createApp().route("/api/users", users);

    expect(await (await call(app, "/api/users/42")).json()).toEqual({ route: "/api/users/:id" });
  });

  test("is undefined for unmatched requests and is written to the request log", async () => {
    const lines: string[] = [];
    let seen: string | undefined = "unset";
    const app = new App({ logger: createLogger({ format: "json", write: (l) => void lines.push(l) }), health: false })
      .use(async (ctx, next) => {
        const res = await next();
        seen = ctx.route;
        return res;
      })
      .get("/items/:id", () => "ok");

    await call(app, "/nowhere");
    await call(app, "/items/7");

    expect(seen).toBe("/items/:id");
    const records = lines.map((l) => JSON.parse(l));
    expect(records[0].route).toBeUndefined();
    expect(records[1].route).toBe("/items/:id");
  });
});

describe("ctx.cookies", () => {
  test("reads request cookies", async () => {
    const app = createApp().get("/", (ctx) => ({ sid: ctx.cookies.get("sid"), missing: ctx.cookies.get("nope") }));
    const res = await call(app, "/", { headers: { cookie: "sid=abc; theme=dark" } });

    expect(await res.json()).toEqual({ sid: "abc", missing: null });
  });

  test("set applies secure defaults and reaches handler-built Responses", async () => {
    const app = createApp().get("/", (ctx) => {
      ctx.cookies.set("sid", "s3cr3t", { maxAge: 60 });
      return new Response("ok");
    });
    const setCookie = (await call(app, "/")).headers.getSetCookie();

    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain("sid=s3cr3t");
    expect(setCookie[0]).toContain("Path=/");
    expect(setCookie[0]).toContain("HttpOnly");
    expect(setCookie[0]).toContain("SameSite=Lax");
    expect(setCookie[0]).toContain("Max-Age=60");
    expect(setCookie[0]).not.toContain("Secure");
  });

  test("the Secure flag follows the (trusted) protocol", async () => {
    const app = createApp({ trustProxy: 1 }).get("/", (ctx) => {
      ctx.cookies.set("sid", "x");
      return "ok";
    });
    const res = await call(app, "/", { from: "10.0.0.1", headers: { "x-forwarded-proto": "https" } });

    expect(res.headers.getSetCookie()[0]).toContain("Secure");
  });

  test("explicit options override the defaults", async () => {
    const app = createApp().get("/", (ctx) => {
      ctx.cookies.set("theme", "dark", { httpOnly: false, sameSite: "strict" });
      return "ok";
    });
    const cookie = (await call(app, "/")).headers.getSetCookie()[0]!;

    expect(cookie).not.toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("delete expires the cookie, and changes survive error responses", async () => {
    const app = createApp().get("/", (ctx) => {
      ctx.cookies.delete("sid");
      throw new NotFoundError();
    });
    const res = await call(app, "/", { headers: { cookie: "sid=abc" } });

    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()[0]).toMatch(/^sid=; .*Expires=/);
  });

  test("requests that change no cookies send no Set-Cookie", async () => {
    const app = createApp().get("/", (ctx) => ctx.cookies.get("sid") ?? "none");
    expect((await call(app, "/", { headers: { cookie: "sid=abc" } })).headers.getSetCookie()).toEqual([]);
  });

  test("cookies are added even to immutable responses", async () => {
    const app = createApp().get("/", (ctx) => {
      ctx.cookies.set("sid", "x");
      return Response.redirect("http://localhost/next", 302);
    });
    expect((await call(app, "/")).headers.getSetCookie()).toHaveLength(1);
  });
});

describe("TooManyRequestsError", () => {
  test("is a 429 with Retry-After", async () => {
    const app = createApp().get("/", () => {
      throw new TooManyRequestsError("Slow down", { retryAfter: 30 });
    });
    const res = await call(app, "/");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json()).error).toMatchObject({ code: "TOO_MANY_REQUESTS", message: "Slow down" });
  });
});
