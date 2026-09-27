import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { authenticate, csrf, type Strategy } from "../src/index";

const bearer: Strategy = {
  name: "bearer",
  async authenticate(ctx) {
    return ctx.headers.get("authorization") === "Bearer good"
      ? { id: "svc", kind: "service", roles: [], via: "jwt" }
      : undefined;
  },
};

function createApp(options?: Parameters<typeof csrf>[0]) {
  return new App({ logger: createLogger({ level: "silent" }), health: false, securityHeaders: false })
    .use(authenticate({ strategies: [bearer] }))
    .use(csrf(options))
    .get("/data", () => "read")
    .post("/data", () => "written");
}

const post = (app: App, headers: Record<string, string>) =>
  app.fetch(new Request("http://app.example.com/data", { method: "POST", headers }));

describe("csrf()", () => {
  test("safe methods always pass", async () => {
    const res = await createApp().fetch(new Request("http://app.example.com/data", { headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(200);
  });

  test("Sec-Fetch-Site decides when present", async () => {
    expect((await post(createApp(), { "sec-fetch-site": "same-origin", cookie: "sid=x" })).status).toBe(200);

    const crossSite = await post(createApp(), { "sec-fetch-site": "cross-site", cookie: "sid=x" });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json()).error.code).toBe("CSRF_REJECTED");
  });

  test("otherwise Origin must be this app's own origin", async () => {
    expect((await post(createApp(), { origin: "http://app.example.com", cookie: "sid=x" })).status).toBe(200);
    expect((await post(createApp(), { origin: "https://evil.example", cookie: "sid=x" })).status).toBe(403);
  });

  test("extra trusted origins can be allowed", async () => {
    const app = createApp({ allowedOrigins: ["https://admin.example.com"] });
    expect((await post(app, { origin: "https://admin.example.com", cookie: "sid=x" })).status).toBe(200);
  });

  test("Referer is the fallback when Origin is missing", async () => {
    expect((await post(createApp(), { referer: "http://app.example.com/form", cookie: "sid=x" })).status).toBe(200);
    expect((await post(createApp(), { referer: "https://evil.example/page", cookie: "sid=x" })).status).toBe(403);
  });

  test("bearer-authenticated requests are exempt: a cross-site form cannot attach a token", async () => {
    expect((await post(createApp(), { authorization: "Bearer good", origin: "https://other.example" })).status).toBe(200);
  });

  test("non-browser clients without cookies pass; a cookie with no browser signals is refused", async () => {
    expect((await post(createApp(), {})).status).toBe(200);
    expect((await post(createApp(), { cookie: "sid=x" })).status).toBe(403);
  });
});
