import { afterEach, describe, expect, test } from "bun:test";
import { App } from "../src/app";
import { createLogger } from "../src/logger";

const apps: App[] = [];

function createApp(health = true) {
  const app = new App({ logger: createLogger({ level: "silent" }), health });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
});

const get = (app: App, path: string) => app.fetch(new Request(`http://localhost${path}`));

describe("/health", () => {
  test("reports the process is alive, whatever the lifecycle state", async () => {
    const res = await get(createApp(), "/health");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });

  test("can be disabled", async () => {
    expect((await get(createApp(false), "/health")).status).toBe(404);
  });
});

describe("/ready", () => {
  test("is 503 until the app is running", async () => {
    const res = await get(createApp(), "/ready");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "not_ready", state: "created", checks: {} });
  });

  test("is 200 while running with all checks passing", async () => {
    const app = createApp().readinessCheck("db", async () => true);
    await app.listen({ port: 0, handleSignals: false });

    const res = await get(app, "/ready");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", state: "running", checks: { db: "ok" } });
  });

  test("is 503 naming each failing check", async () => {
    const app = createApp()
      .readinessCheck("db", () => true)
      .readinessCheck("cache", () => false)
      .readinessCheck("queue", () => {
        throw new Error("connection refused to 10.0.0.5");
      });
    await app.listen({ port: 0, handleSignals: false });

    const res = await get(app, "/ready");
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text).checks).toEqual({ db: "ok", cache: "fail", queue: "fail" });
    expect(text).not.toContain("10.0.0.5");
  });

  test("checks that take too long count as failed", async () => {
    const app = createApp().readinessCheck("slow", () => new Promise(() => {}), { timeoutMs: 20 });
    await app.listen({ port: 0, handleSignals: false });

    const res = await get(app, "/ready");

    expect(res.status).toBe(503);
    expect((await res.json()).checks).toEqual({ slow: "timeout" });
  });

  test("is 503 while stopping so load balancers drain the instance", async () => {
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const app = createApp().onStop(() => release);
    await app.listen({ port: 0, handleSignals: false });

    const stopping = app.stop();
    const res = await get(app, "/ready");
    resolve();
    await stopping;

    expect(res.status).toBe(503);
    expect((await res.json()).state).toBe("stopping");
  });
});
