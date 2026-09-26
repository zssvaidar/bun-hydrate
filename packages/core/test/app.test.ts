import { describe, expect, test } from "bun:test";
import { App, type AppOptions } from "../src/app";
import { Router } from "../src/router";
import { ConflictError, NotFoundError, ValidationError } from "../src/errors";
import { createLogger } from "../src/logger";
import type { Middleware } from "../src/middleware";

const quiet = createLogger({ level: "silent" });

function createApp(options: AppOptions = {}) {
  return new App({ logger: quiet, health: false, ...options });
}

function call(app: App, path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("handler return values", () => {
  test("objects become JSON", async () => {
    const app = createApp().get("/", () => ({ status: "ok" }));
    const res = await call(app, "/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("strings become text", async () => {
    const res = await call(createApp().get("/", () => "Hello"), "/");

    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await res.text()).toBe("Hello");
  });

  test("undefined becomes 204", async () => {
    const res = await call(createApp().delete("/x", () => undefined), "/x", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("Responses pass through untouched", async () => {
    const res = await call(createApp().get("/", () => new Response("raw", { status: 202 })), "/");
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("raw");
  });

  test("async handlers are awaited", async () => {
    const res = await call(createApp().get("/", async () => ({ later: true })), "/");
    expect(await res.json()).toEqual({ later: true });
  });

  test("ctx.status and ctx.header apply to normalized results", async () => {
    const app = createApp().post("/users", (ctx) => {
      ctx.status(201).header("location", "/users/1");
      return { id: 1 };
    });
    const res = await call(app, "/users", { method: "POST" });

    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/users/1");
  });
});

describe("context", () => {
  test("exposes request data, params and query", async () => {
    const app = createApp().get("/orders/:orderId/items/:itemId", (ctx) => ({
      method: ctx.method,
      path: ctx.path,
      params: ctx.params,
      page: ctx.query.get("page"),
      agent: ctx.headers.get("user-agent"),
      url: ctx.url.href,
      isRequest: ctx.request instanceof Request,
    }));
    const res = await call(app, "/orders/o1/items/i2?page=3", { headers: { "user-agent": "test" } });

    expect(await res.json()).toEqual({
      method: "GET",
      path: "/orders/o1/items/i2",
      params: { orderId: "o1", itemId: "i2" },
      page: "3",
      agent: "test",
      url: "http://localhost/orders/o1/items/i2?page=3",
      isRequest: true,
    });
  });

  test("params are typed from the path (checked by tsc)", async () => {
    const app = createApp().get("/users/:id/files/*", (ctx) => {
      const id: string = ctx.params.id;
      const rest: string = ctx.params["*"];
      // @ts-expect-error — not a parameter of this path
      void ctx.params.nope;
      return { id, rest };
    });

    expect(await (await call(app, "/users/7/files/a/b.txt")).json()).toEqual({ id: "7", rest: "a/b.txt" });
  });

  test("response builders", async () => {
    const app = createApp()
      .get("/json", (ctx) => ctx.json({ a: 1 }, 201))
      .get("/text", (ctx) => ctx.text("hi", 202))
      .get("/html", (ctx) => ctx.html("<p>hi</p>"))
      .get("/redirect", (ctx) => ctx.redirect("/json"))
      .get("/see-other", (ctx) => ctx.redirect("/json", 303));

    const json = await call(app, "/json");
    expect(json.status).toBe(201);
    expect(await json.json()).toEqual({ a: 1 });

    const text = await call(app, "/text");
    expect([text.status, await text.text()]).toEqual([202, "hi"]);

    const html = await call(app, "/html");
    expect(html.headers.get("content-type")).toBe("text/html;charset=utf-8");

    const redirect = await call(app, "/redirect");
    expect([redirect.status, redirect.headers.get("location")]).toEqual([302, "/json"]);
    expect((await call(app, "/see-other")).status).toBe(303);
  });

  test("ctx.file serves a file and 404s when missing", async () => {
    const path = `${import.meta.dir}/fixtures/hello.txt`;
    const app = createApp()
      .get("/file", (ctx) => ctx.file(path))
      .get("/missing", (ctx) => ctx.file(`${import.meta.dir}/fixtures/nope.txt`));

    const res = await call(app, "/file");
    expect(await res.text()).toBe("hello from a file\n");
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect((await call(app, "/missing")).status).toBe(404);
  });

  test("ctx.body.json parses JSON bodies", async () => {
    const app = createApp().post("/echo", async (ctx) => ctx.body.json());
    const res = await call(app, "/echo", { method: "POST", body: JSON.stringify({ name: "Ada" }) });
    expect(await res.json()).toEqual({ name: "Ada" });
  });

  test("malformed JSON bodies are a 400, not a 500", async () => {
    const app = createApp().post("/echo", async (ctx) => ctx.body.json());
    const res = await call(app, "/echo", { method: "POST", body: "{nope" });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_JSON");
  });

  test("ctx.body.text and formData", async () => {
    const form = new FormData();
    form.set("name", "Ada");
    const app = createApp()
      .post("/text", async (ctx) => ctx.body.text())
      .post("/form", async (ctx) => ({ name: (await ctx.body.formData()).get("name") }));

    expect(await (await call(app, "/text", { method: "POST", body: "plain" })).text()).toBe("plain");
    expect(await (await call(app, "/form", { method: "POST", body: form })).json()).toEqual({ name: "Ada" });
  });

  test("ctx.state is shared between middleware and handlers", async () => {
    const app = createApp()
      .use(async (ctx, next) => {
        ctx.state.user = "ada";
        return next();
      })
      .get("/", (ctx) => ({ user: ctx.state.user }));

    expect(await (await call(app, "/")).json()).toEqual({ user: "ada" });
  });
});

describe("middleware", () => {
  const trace = (log: string[], name: string): Middleware => async (_ctx, next) => {
    log.push(`${name}:before`);
    const res = await next();
    log.push(`${name}:after`);
    return res;
  };

  test("runs global, router and route middleware in onion order", async () => {
    const log: string[] = [];
    const users = new Router().use(trace(log, "router")).get("/", trace(log, "route"), () => {
      log.push("handler");
      return "ok";
    });
    const app = createApp().use(trace(log, "global")).route("/users", users);

    await call(app, "/users");

    expect(log).toEqual([
      "global:before",
      "router:before",
      "route:before",
      "handler",
      "route:after",
      "router:after",
      "global:after",
    ]);
  });

  test("router middleware does not run for routes outside the router", async () => {
    const log: string[] = [];
    const admin = new Router().use(trace(log, "admin")).get("/", () => "admin");
    const app = createApp().route("/admin", admin).get("/public", () => "public");

    await call(app, "/public");

    expect(log).toEqual([]);
  });

  test("global middleware runs for unmatched routes too", async () => {
    const log: string[] = [];
    const app = createApp().use(trace(log, "global"));

    const res = await call(app, "/nowhere");

    expect(res.status).toBe(404);
    expect(log).toEqual(["global:before", "global:after"]);
  });

  test("middleware can short-circuit", async () => {
    const app = createApp()
      .use(() => new Response("blocked", { status: 403 }))
      .get("/", () => "never");

    const res = await call(app, "/");
    expect([res.status, await res.text()]).toEqual([403, "blocked"]);
  });

  test("middleware can replace headers on the downstream response", async () => {
    const app = createApp()
      .use(async (_ctx, next) => {
        const res = await next();
        res.headers.set("x-powered-by", "bun-hydrate");
        return res;
      })
      .get("/", () => ({ ok: true }));

    expect((await call(app, "/")).headers.get("x-powered-by")).toBe("bun-hydrate");
  });

  test("calling next() twice is an error", async () => {
    const app = createApp()
      .use(async (_ctx, next) => {
        await next();
        return next();
      })
      .get("/", () => "ok");

    expect((await call(app, "/")).status).toBe(500);
  });

  test("nested routers compose prefixes", async () => {
    const items = new Router().get("/:itemId", (ctx) => ctx.params);
    const orders = new Router().route("/:orderId/items", items);
    const app = createApp().route("/api/orders", orders);

    expect(await (await call(app, "/api/orders/o1/items/i2")).json()).toEqual({ orderId: "o1", itemId: "i2" });
  });

  test("routes registered on a router after mounting are still served", async () => {
    const users = new Router();
    const app = createApp().route("/users", users);
    users.get("/late", () => "late");

    expect(await (await call(app, "/users/late")).text()).toBe("late");
  });
});

describe("routing responses", () => {
  test("unknown paths are 404 JSON errors", async () => {
    const res = await call(createApp(), "/nope");

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatchObject({ code: "NOT_FOUND", message: "Not Found" });
  });

  test("wrong method is 405 with Allow", async () => {
    const app = createApp().get("/users", () => []).post("/users", () => ({}));
    const res = await call(app, "/users", { method: "PUT" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
  });

  test("HEAD falls back to GET without a body", async () => {
    const app = createApp().get("/users", () => ({ many: true }));
    const res = await call(app, "/users", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.text()).toBe("");
  });

  test("OPTIONS is answered automatically", async () => {
    const app = createApp().get("/users", () => []);
    const res = await call(app, "/users", { method: "OPTIONS" });

    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  test("explicit OPTIONS routes win over the automatic answer", async () => {
    const app = createApp().options("/users", () => new Response(null, { status: 200 }));
    expect((await call(app, "/users", { method: "OPTIONS" })).status).toBe(200);
  });

  test("all() matches every method", async () => {
    const app = createApp().all("/any", (ctx) => ctx.method);
    expect(await (await call(app, "/any", { method: "PATCH" })).text()).toBe("PATCH");
  });
});

describe("errors", () => {
  test("HttpErrors use the standard error format with the request ID", async () => {
    const app = createApp().get("/users/:id", () => {
      throw new NotFoundError("User not found", { code: "USER_NOT_FOUND" });
    });
    const res = await call(app, "/users/1", { headers: { "x-request-id": "req-123" } });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "USER_NOT_FOUND", message: "User not found", requestId: "req-123" },
    });
  });

  test("details are included when present", async () => {
    const app = createApp().post("/users", () => {
      throw new ValidationError("Invalid body", { details: [{ path: "email", message: "required" }] });
    });
    const body = await (await call(app, "/users", { method: "POST" })).json();

    expect(body.error.details).toEqual([{ path: "email", message: "required" }]);
  });

  test("unknown errors are a generic 500 without internals", async () => {
    const app = createApp({ exposeErrors: false }).get("/", () => {
      throw new Error("database password is hunter2");
    });
    const res = await call(app, "/");
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text).error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" });
    expect(JSON.parse(text).error.stack).toBeUndefined();
  });

  test("exposeErrors includes the original message and stack for debugging", async () => {
    const app = createApp({ exposeErrors: true }).get("/", () => {
      throw new Error("detailed cause");
    });
    const { error } = await (await call(app, "/")).json();

    expect(error.message).toBe("detailed cause");
    expect(error.stack).toContain("detailed cause");
  });

  test("5xx errors are logged with the request ID; 4xx are not logged as errors", async () => {
    const lines: string[] = [];
    const logger = createLogger({ format: "json", level: "info", write: (l) => void lines.push(l) });
    const app = createApp({ logger, logRequests: false })
      .get("/boom", () => {
        throw new Error("boom");
      })
      .get("/conflict", () => {
        throw new ConflictError();
      });

    await call(app, "/boom", { headers: { "x-request-id": "r-500" } });
    await call(app, "/conflict");

    const errors = lines.map((l) => JSON.parse(l)).filter((r) => r.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ requestId: "r-500", error: { message: "boom" } });
  });

  test("onError can customize the response", async () => {
    const app = createApp()
      .onError((error) => new Response(`custom: ${(error as Error).message}`, { status: 418 }))
      .get("/", () => {
        throw new Error("teapot");
      });
    const res = await call(app, "/");

    expect([res.status, await res.text()]).toEqual([418, "custom: teapot"]);
  });

  test("onError returning undefined falls back to the default format", async () => {
    const app = createApp()
      .onError(() => undefined)
      .get("/", () => {
        throw new NotFoundError();
      });
    expect((await call(app, "/")).status).toBe(404);
  });

  test("errors thrown by middleware still get the error format and request ID", async () => {
    const app = createApp().use(() => {
      throw new ConflictError("nope");
    });
    const res = await call(app, "/");

    expect(res.status).toBe(409);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("request IDs", () => {
  test("generates a request ID and echoes it on the response", async () => {
    const app = createApp().get("/", (ctx) => ({ id: ctx.requestId }));
    const res = await call(app, "/");
    const { id } = await res.json();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("x-request-id")).toBe(id);
  });

  test("reuses a well-formed incoming request ID", async () => {
    const app = createApp().get("/", (ctx) => ctx.requestId);
    const res = await call(app, "/", { headers: { "x-request-id": "upstream-42" } });
    expect(await res.text()).toBe("upstream-42");
  });

  test("replaces malformed incoming request IDs", async () => {
    const app = createApp().get("/", (ctx) => ctx.requestId);
    const res = await call(app, "/", { headers: { "x-request-id": 'bad id" level="fatal' } });
    expect(await res.text()).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("request IDs are added even to immutable responses", async () => {
    const app = createApp().get("/", () => Response.redirect("http://localhost/elsewhere", 302));
    const res = await call(app, "/");

    expect(res.status).toBe(302);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("ctx.log is bound to the request ID", async () => {
    const lines: string[] = [];
    const logger = createLogger({ format: "json", write: (l) => void lines.push(l) });
    const app = createApp({ logger, logRequests: false }).get("/", (ctx) => {
      ctx.log.info("inside handler");
      return "ok";
    });

    await call(app, "/", { headers: { "x-request-id": "bound-1" } });

    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "inside handler", requestId: "bound-1" });
  });
});

describe("request logging", () => {
  test("logs one line per request with method, path, status and duration", async () => {
    const lines: string[] = [];
    const logger = createLogger({ format: "json", write: (l) => void lines.push(l) });
    const app = createApp({ logger }).get("/users", () => []);

    await call(app, "/users?secret=1", { headers: { "x-request-id": "log-1" } });

    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({ level: "info", method: "GET", path: "/users", status: 200, requestId: "log-1" });
    expect(typeof record.durationMs).toBe("number");
  });

  test("5xx request lines are warnings", async () => {
    const lines: string[] = [];
    const logger = createLogger({ format: "json", write: (l) => void lines.push(l) });
    const app = createApp({ logger }).get("/", () => new Response(null, { status: 503 }));

    await call(app, "/");

    expect(JSON.parse(lines[0]!).level).toBe("warn");
  });
});
