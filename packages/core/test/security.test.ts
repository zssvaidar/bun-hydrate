import { describe, expect, test } from "bun:test";
import { App, type AppOptions } from "../src/app";
import { cors } from "../src/cors";
import { NotFoundError } from "../src/errors";
import { createLogger } from "../src/logger";

function createApp(options: AppOptions = {}) {
  return new App({ logger: createLogger({ level: "silent" }), health: false, ...options });
}

const peer = (address: string) => ({ requestIP: () => ({ address }) });
const call = (app: App, path: string, init: RequestInit = {}, from?: string) =>
  app.fetch(new Request(`http://localhost${path}`, init), from ? peer(from) : undefined);

describe("security headers (on by default)", () => {
  test("sets the baseline headers on every response, including errors", async () => {
    const app = createApp().get("/boom", () => {
      throw new NotFoundError();
    });
    const res = await call(app, "/boom");

    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  test("HSTS only over HTTPS", async () => {
    const app = createApp({ trustProxy: 1 }).get("/", () => "ok");

    expect((await call(app, "/")).headers.get("strict-transport-security")).toBeNull();
    const https = await call(app, "/", { headers: { "x-forwarded-proto": "https" } }, "10.0.0.1");
    expect(https.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  test("a route can set its own value, which wins", async () => {
    const app = createApp().get("/embed", (ctx) => {
      ctx.header("x-frame-options", "SAMEORIGIN");
      return "ok";
    });
    expect((await call(app, "/embed")).headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("individual headers can be changed or disabled, or all turned off", async () => {
    const custom = createApp({
      securityHeaders: { "content-security-policy": "default-src 'none'", "x-frame-options": false },
    }).get("/", () => "ok");
    const res = await call(custom, "/");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const off = createApp({ securityHeaders: false }).get("/", () => "ok");
    expect((await call(off, "/")).headers.get("content-security-policy")).toBeNull();
  });
});

describe("cors()", () => {
  const origin = "https://app.example.com";

  function corsApp(options: Parameters<typeof cors>[0]) {
    return createApp({ securityHeaders: false })
      .use(cors(options))
      .get("/data", () => ({ ok: true }))
      .post("/data", () => ({ created: true }));
  }

  test("answers an allowed preflight before routing", async () => {
    const app = corsApp({ origin: [origin], credentials: true, maxAge: 600 });
    const res = await call(app, "/data", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-trace" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD, PUT, PATCH, POST, DELETE");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type, x-trace");
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("a disallowed preflight gets no CORS headers", async () => {
    const res = await call(corsApp({ origin: [origin] }), "/data", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("actual requests from allowed origins get the origin echoed, with Vary", async () => {
    const res = await call(corsApp({ origin: [origin], exposeHeaders: ["x-request-id"] }), "/data", { headers: { origin } });

    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-expose-headers")).toBe("x-request-id");
    expect(res.headers.get("vary")).toContain("Origin");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("disallowed origins still get a response, just without CORS headers", async () => {
    const res = await call(corsApp({ origin: [origin] }), "/data", { headers: { origin: "https://evil.example" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a predicate can decide", async () => {
    const app = corsApp({ origin: (o) => o.endsWith(".example.com") });
    const res = await call(app, "/data", { headers: { origin: "https://admin.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://admin.example.com");
  });

  test("a public API can allow any origin without credentials", async () => {
    const res = await call(corsApp({ origin: "*" }), "/data", { headers: { origin: "https://anyone.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("'*' with credentials is rejected at construction", () => {
    expect(() => cors({ origin: "*", credentials: true })).toThrow(
      'cors(): origin "*" cannot be combined with credentials: true; list the allowed origins instead',
    );
  });

  test("requests without an Origin are untouched", async () => {
    const res = await call(corsApp({ origin: [origin] }), "/data");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
