import { afterEach, describe, expect, test } from "bun:test";
import { App } from "../src/app";
import { createLogger } from "../src/logger";

const apps: App[] = [];

function createApp() {
  const app = new App({ logger: createLogger({ level: "silent" }) });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
});

describe("lifecycle", () => {
  test("moves from created through running to stopped", async () => {
    const app = createApp();
    const seen: string[] = [app.state];
    app.onStart(() => void seen.push(app.state));
    app.onStop(() => void seen.push(app.state));

    await app.listen({ port: 0, handleSignals: false });
    seen.push(app.state);
    await app.stop();
    seen.push(app.state);

    expect(seen).toEqual(["created", "initializing", "running", "stopping", "stopped"]);
  });

  test("serves real HTTP once listening", async () => {
    const app = createApp().get("/hello", () => "world");
    const server = await app.listen({ port: 0, handleSignals: false });

    const res = await fetch(new URL("/hello", server.url));
    expect(await res.text()).toBe("world");
  });

  test("runs start hooks in order and stop hooks in reverse", async () => {
    const order: string[] = [];
    const app = createApp()
      .onStart(() => void order.push("start db"))
      .onStart(() => void order.push("start cache"))
      .onStop(() => void order.push("stop db"))
      .onStop(() => void order.push("stop cache"));

    await app.listen({ port: 0, handleSignals: false });
    await app.stop();

    expect(order).toEqual(["start db", "start cache", "stop cache", "stop db"]);
  });

  test("cleanup functions returned from start hooks run on stop", async () => {
    const order: string[] = [];
    const app = createApp().onStart(() => () => void order.push("cleanup"));

    await app.listen({ port: 0, handleSignals: false });
    await app.stop();

    expect(order).toEqual(["cleanup"]);
  });

  test("a failing start hook aborts startup and cleans up hooks that already started", async () => {
    const order: string[] = [];
    const app = createApp()
      .onStart(() => () => void order.push("cleanup first"))
      .onStart(() => {
        throw new Error("cannot connect");
      })
      .onStart(() => () => void order.push("never started"));

    await expect(app.listen({ port: 0, handleSignals: false })).rejects.toThrow("cannot connect");

    expect(order).toEqual(["cleanup first"]);
    expect(app.state).toBe("stopped");
    expect(app.server).toBeUndefined();
  });

  test("listen() cannot be called twice", async () => {
    const app = createApp();
    await app.listen({ port: 0, handleSignals: false });
    await expect(app.listen({ port: 0, handleSignals: false })).rejects.toThrow(/already/);
  });

  test("stop() is idempotent", async () => {
    const app = createApp();
    await app.listen({ port: 0, handleSignals: false });
    expect(app.stop()).toBe(app.stop());
    await app.stop();
  });

  test("stop() before listen() just marks the app stopped", async () => {
    const app = createApp();
    await app.stop();
    expect(app.state).toBe("stopped");
  });

  test("in-flight requests finish during graceful shutdown", async () => {
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const app = createApp().get("/slow", async () => {
      await release;
      return "done";
    });
    const server = await app.listen({ port: 0, handleSignals: false });

    const inFlight = fetch(new URL("/slow", server.url));
    await Bun.sleep(20);
    const stopped = app.stop();
    resolve();

    expect(await (await inFlight).text()).toBe("done");
    await stopped;
    expect(app.state).toBe("stopped");
  });

  test("shutdown gives up waiting after the timeout", async () => {
    const app = createApp().get("/hang", () => new Promise(() => {}));
    const server = await app.listen({ port: 0, handleSignals: false });

    fetch(new URL("/hang", server.url)).catch(() => {});
    await Bun.sleep(20);

    const startedAt = performance.now();
    await app.stop({ timeoutMs: 100 });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(app.state).toBe("stopped");
  });

  test("errors in stop hooks are logged and do not prevent the other hooks", async () => {
    const lines: string[] = [];
    const app = new App({ logger: createLogger({ format: "json", write: (l) => void lines.push(l) }) });
    const order: string[] = [];
    app.onStop(() => void order.push("second")).onStop(() => {
      throw new Error("close failed");
    });

    await app.listen({ port: 0, handleSignals: false });
    await app.stop();

    expect(order).toEqual(["second"]);
    expect(lines.some((l) => l.includes("close failed"))).toBe(true);
  });

  test("a stopped app leaves nothing keeping the process alive", async () => {
    const script = `
      import { App, createLogger } from "${import.meta.dir}/../src/index";
      const app = new App({ logger: createLogger({ level: "silent" }) });
      await app.listen({ port: 0, handleSignals: false });
      await app.stop();
    `;
    const startedAt = performance.now();
    const child = Bun.spawn(["bun", "-e", script]);

    expect(await child.exited).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  test("SIGTERM stops gracefully, then ends the process even if leftover work holds it open (spec-6 §11)", async () => {
    const script = `
      import { App, createLogger } from "${import.meta.dir}/../src/index";
      const app = new App({ logger: createLogger({ level: "silent" }) });
      app.onStop(() => console.log("stopped"));
      await app.listen({ port: 0 });
      setTimeout(() => console.log("still alive"), 60_000); // e.g. a handler that ignores its abort signal
      console.log("ready");
    `;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let output = "";
    while (!output.includes("ready")) output += (await reader.read()).value ?? "";

    const startedAt = performance.now();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) output += chunk.value;
    expect(output).toContain("stopped");
    expect(output).not.toContain("still alive");
  });
});
