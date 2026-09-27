import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { connectWebSocket } from "../src/index";

let server: Server<{ origin: string | null }>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req, { data: { origin: req.headers.get("origin") } }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open(ws) {
        ws.send(`hello from ${ws.data.origin ?? "no origin"}`);
      },
      message(ws, message) {
        if (message === "bye") ws.close(4000, "requested");
        else ws.send(`echo ${message}`);
      },
    },
  });
});

// Not awaited: with WebSocket connections, Bun's stop(true) promise does not settle.
afterAll(() => void server.stop(true));

describe("connectWebSocket", () => {
  test("connects, sends and awaits messages in order", async () => {
    const ws = await connectWebSocket(server.url.href.replace("http", "ws"));

    expect(await ws.next()).toBe("hello from no origin");
    ws.send("one");
    ws.send("two");
    expect(await ws.next()).toBe("echo one");
    expect(await ws.next()).toBe("echo two");
    await ws.close();
  });

  test("passes headers such as Origin", async () => {
    const ws = await connectWebSocket(server.url.href.replace("http", "ws"), { headers: { origin: "https://app.example" } });
    expect(await ws.next()).toBe("hello from https://app.example");
    await ws.close();
  });

  test("next() times out instead of hanging", async () => {
    const ws = await connectWebSocket(server.url.href.replace("http", "ws"));
    await ws.next();
    await expect(ws.next({ timeoutMs: 50 })).rejects.toThrow("No WebSocket message within 50ms");
    await ws.close();
  });

  test("closed resolves with the close code and reason", async () => {
    const ws = await connectWebSocket(server.url.href.replace("http", "ws"));
    await ws.next();
    ws.send("bye");
    expect(await ws.closed).toEqual({ code: 4000, reason: "requested" });
  });

  test("a refused connection rejects", async () => {
    await expect(connectWebSocket("ws://127.0.0.1:1/")).rejects.toThrow("WebSocket connection failed");
  });
});
