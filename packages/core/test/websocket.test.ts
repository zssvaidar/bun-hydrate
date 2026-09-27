import { afterEach, describe, expect, test } from "bun:test";
import { connectWebSocket } from "@bun-hydrate/testing";
import { App, type AppOptions } from "../src/app";
import { memoryPubSub, type PubSub } from "../src/pubsub";
import { UnauthorizedError } from "../src/errors";
import { createLogger } from "../src/logger";

const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop({ timeoutMs: 1_000 })));
});

async function startApp(options: AppOptions = {}) {
  const lines: string[] = [];
  const app = new App({
    logger: createLogger({ format: "json", write: (l) => void lines.push(l) }),
    health: false,
    logRequests: false,
    ...options,
  });
  app
    .use(async (ctx, next) => {
      ctx.state.user = ctx.headers.get("x-user") ?? undefined;
      return next();
    })
    .websocket("/ws/rooms/:room", {
      upgrade(ctx) {
        if (!ctx.state.user) throw new UnauthorizedError("Sign in first");
        return { user: ctx.state.user as string, room: ctx.params.room };
      },
      open(ws) {
        ws.subscribe(`room:${ws.data.room}`);
        ws.send(`welcome ${ws.data.user} to ${ws.data.room}`);
      },
      message(ws, message) {
        if (message === "boom") throw new Error("handler failed");
        ws.publish(`room:${ws.data.room}`, `${ws.data.user}: ${message}`);
      },
    })
    .post("/announce/:room", async (ctx) => {
      await app.publish(`room:${ctx.params.room}`, "announcement");
      return { published: true };
    });
  apps.push(app);
  const server = await app.listen({ port: 0, hostname: "127.0.0.1", handleSignals: false });
  const wsUrl = (path: string) => `ws://127.0.0.1:${server.port}${path}`;
  const httpUrl = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  return { app, lines, wsUrl, httpUrl };
}

/** Sends a WebSocket handshake with fetch, to see the HTTP answer of a refused upgrade. */
function handshake(url: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
      ...headers,
    },
  });
}

describe("app.websocket()", () => {
  test("upgrades through the middleware stack; params and upgrade data reach the socket", async () => {
    const { wsUrl } = await startApp();
    const alice = await connectWebSocket(wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "alice" } });

    expect(await alice.next()).toBe("welcome alice to lobby");
    await alice.close();
  });

  test("messages are broadcast to the room; app.publish reaches every subscriber", async () => {
    const { wsUrl, httpUrl } = await startApp();
    const alice = await connectWebSocket(wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "alice" } });
    const bob = await connectWebSocket(wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "bob" } });
    await alice.next();
    await bob.next();

    alice.send("hi");
    expect(await bob.next()).toBe("alice: hi");

    const res = await fetch(httpUrl("/announce/lobby"), { method: "POST" });
    expect(await res.json()).toEqual({ published: true });
    expect(await alice.next()).toBe("announcement");
    expect(await bob.next()).toBe("announcement");
    await Promise.all([alice.close(), bob.close()]);
  });

  test("an upgrade handler error is a normal HTTP error response, not an upgrade", async () => {
    const { wsUrl, httpUrl } = await startApp();
    const res = await handshake(httpUrl("/ws/rooms/lobby"));

    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Sign in first");
    await expect(connectWebSocket(wsUrl("/ws/rooms/lobby"))).rejects.toThrow("WebSocket connection failed");
  });

  test("cross-site upgrades are refused; same-origin and allowed origins pass", async () => {
    const { httpUrl } = await startApp({ websocket: { allowedOrigins: ["https://admin.example.com"] } });
    const withOrigin = (origin: string) => handshake(httpUrl("/ws/rooms/lobby"), { "x-user": "alice", origin });

    const evil = await withOrigin("https://evil.example");
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe("ORIGIN_REJECTED");
    expect((await withOrigin(new URL(httpUrl("/")).origin)).status).toBe(101);
    expect((await withOrigin("https://admin.example.com")).status).toBe(101);
  });

  test("a plain GET to a WebSocket route is 426 Upgrade Required", async () => {
    const { httpUrl } = await startApp();
    const res = await fetch(httpUrl("/ws/rooms/lobby"), { headers: { "x-user": "alice" } });

    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("websocket");
  });

  test("a failing message handler closes that socket with 1011 and is logged", async () => {
    const { wsUrl, lines } = await startApp();
    const alice = await connectWebSocket(wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "alice" } });
    await alice.next();

    alice.send("boom");

    expect((await alice.closed).code).toBe(1011);
    expect(lines.some((line) => line.includes("handler failed"))).toBe(true);
  });

  test("messages larger than maxPayloadLength close the connection", async () => {
    const { wsUrl } = await startApp({ websocket: { maxPayloadLength: 1024 } });
    const alice = await connectWebSocket(wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "alice" } });
    await alice.next();

    alice.send("x".repeat(4096));

    // Bun drops the connection without a close frame, so clients see 1006 rather than 1009.
    expect([1006, 1009]).toContain((await alice.closed).code);
  });

  test("stop() closes open sockets with 1012 (service restart) and still finishes promptly", async () => {
    const { app, wsUrl } = await startApp();
    const alice = await connectWebSocket(wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "alice" } });
    await alice.next();

    const startedAt = performance.now();
    await app.stop({ timeoutMs: 5_000 });

    expect(await alice.closed).toEqual({ code: 1012, reason: "Server restarting" });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("a stopped app with WebSocket history leaves nothing keeping the process alive", async () => {
    const script = `
      import { App, createLogger } from "${import.meta.dir}/../src/index";
      const app = new App({ logger: createLogger({ level: "silent" }) }).websocket("/ws", { open: (ws) => { ws.send("hi"); } });
      const server = await app.listen({ port: 0, hostname: "127.0.0.1", handleSignals: false });
      const client = new WebSocket("ws://127.0.0.1:" + server.port + "/ws");
      await new Promise((resolve) => client.addEventListener("message", resolve));
      await app.stop({ timeoutMs: 5_000 });
    `;
    const startedAt = performance.now();
    const child = Bun.spawn(["bun", "-e", script]);

    expect(await child.exited).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  test("upgrades are refused with 503 once the app is stopping", async () => {
    const { app, httpUrl } = await startApp();
    const upgradeCapable = { requestIP: () => ({ address: "127.0.0.1" }), upgrade: () => true };
    const stopping = app.stop();
    const res = await app.handle(
      new Request(httpUrl("/ws/rooms/lobby"), { headers: { upgrade: "websocket", "x-user": "alice" } }),
      upgradeCapable,
    );
    await stopping;

    expect(res!.status).toBe(503);
  });

  test("app.fetch (in-process) never upgrades: WebSocket routes answer 426", async () => {
    const app = new App({ logger: createLogger({ level: "silent" }), health: false }).websocket("/ws", {});
    const res = await app.fetch(new Request("http://localhost/ws", { headers: { upgrade: "websocket" } }));
    expect(res.status).toBe(426);
  });

  test("ws.data is typed from the upgrade handler (checked by tsc)", () => {
    new App({ logger: createLogger({ level: "silent" }) }).websocket("/ws/:id", {
      upgrade: (ctx) => ({ id: ctx.params.id, joinedAt: 1 }),
      open(ws) {
        const id: string = ws.data.id;
        const joinedAt: number = ws.data.joinedAt;
        // @ts-expect-error — not part of the upgrade data
        void ws.data.nope;
        void [id, joinedAt];
      },
    });
  });
});

describe("fan-out through a PubSub adapter (spec-6 §9)", () => {
  test("app.publish() reaches subscribers connected to another instance, and to this one", async () => {
    const hub = memoryPubSub();
    const a = await startApp({ pubsub: hub });
    const b = await startApp({ pubsub: hub });
    const onB = await connectWebSocket(b.wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "bob" } });
    const onA = await connectWebSocket(a.wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "ann" } });
    await onB.next();
    await onA.next(); // welcomes

    await a.app.publish("room:lobby", "hello everyone");
    expect(await onB.next()).toBe("hello everyone");
    expect(await onA.next()).toBe("hello everyone");
    await Promise.all([onA.close(), onB.close()]);
  });

  test("without an adapter, app.publish() stays in this process", async () => {
    const { app, wsUrl } = await startApp();
    const client = await connectWebSocket(wsUrl("/ws/rooms/lobby"), { headers: { "x-user": "ann" } });
    await client.next();
    await app.publish("room:lobby", "local only");
    expect(await client.next()).toBe("local only");
    await client.close();
  });

  test("binary messages survive the trip", async () => {
    const hub = memoryPubSub();
    const a = await startApp({ pubsub: hub });
    const b = await startApp({ pubsub: hub });
    const client = await connectWebSocket(b.wsUrl("/ws/rooms/bin"), { headers: { "x-user": "bob" } });
    client.raw.binaryType = "arraybuffer";
    await client.next();
    await a.app.publish("room:bin", new Uint8Array([1, 2, 255]));
    expect([...new Uint8Array((await client.next()) as ArrayBuffer)]).toEqual([1, 2, 255]);
    await client.close();
  });
});

describe("shutdown phases (spec-6 §11)", () => {
  test("HTTP drains, then onDrain hooks, then the pub/sub unsubscribes, then stop hooks", async () => {
    const order: string[] = [];
    const hub = memoryPubSub();
    const pubsub: PubSub = {
      publish: (topic, message) => hub.publish(topic, message),
      subscribe: async (deliver) => {
        const unsubscribe = await hub.subscribe(deliver);
        return async () => {
          order.push("pubsub unsubscribed");
          await unsubscribe();
        };
      },
    };
    const { app, httpUrl } = await startApp({ pubsub });
    app.get("/slow", async () => {
      await Bun.sleep(30);
      order.push("request finished");
      return "done";
    });
    app.onDrain(() => void order.push("drain hook"));
    app.onStop(() => void order.push("stop hook"));

    const slow = fetch(httpUrl("/slow"));
    await Bun.sleep(5);
    await app.stop();
    await slow;
    expect(order).toEqual(["request finished", "drain hook", "pubsub unsubscribed", "stop hook"]);
  });
});
