import { describe, expect, test } from "bun:test";
import { App } from "../src/app";
import { createLogger } from "../src/logger";
import { childTrace, currentTrace, formatTraceparent, parseTraceparent, propagationHeaders, runWithTrace } from "../src/trace";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceparent", () => {
  test("accepts a valid W3C traceparent", () => {
    expect(parseTraceparent(VALID)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentId: "00f067aa0ba902b7",
      flags: "01",
    });
  });

  test.each([
    ["missing", null],
    ["garbage", "hello"],
    ["uppercase", VALID.toUpperCase()],
    ["all-zero trace id", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
    ["all-zero parent id", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
    ["forbidden version ff", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
  ])("rejects %s", (_name, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });
});

describe("trace context in requests", () => {
  function createApp(write?: (line: string) => void) {
    return new App({ logger: createLogger({ format: "json", write: write ?? (() => {}) }), health: false, logRequests: false }).get(
      "/",
      (ctx) => {
        ctx.log.info("inside");
        return { traceId: ctx.traceId, spanId: ctx.spanId, outgoing: propagationHeaders(ctx) };
      },
    );
  }

  test("continues an incoming trace with a new span", async () => {
    const res = await createApp().fetch(new Request("http://localhost/", { headers: { traceparent: VALID, "x-request-id": "r-1" } }));
    const body = await res.json();

    expect(body.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(body.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.spanId).not.toBe("00f067aa0ba902b7");
    expect(body.outgoing).toEqual({
      traceparent: `00-4bf92f3577b34da6a3ce929d0e0e4736-${body.spanId}-01`,
      "x-request-id": "r-1",
    });
  });

  test("starts a new trace when there is none (or it is invalid)", async () => {
    const res = await createApp().fetch(new Request("http://localhost/", { headers: { traceparent: "bogus" } }));
    const body = await res.json();

    expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.outgoing.traceparent).toBe(`00-${body.traceId}-${body.spanId}-01`);
  });

  test("the trace ID is bound into ctx.log", async () => {
    const lines: string[] = [];
    await createApp((line) => void lines.push(line)).fetch(new Request("http://localhost/", { headers: { traceparent: VALID } }));

    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "inside", traceId: "4bf92f3577b34da6a3ce929d0e0e4736" });
  });
});

describe("ambient trace context", () => {
  test("is the request's trace inside handlers and middleware, even deep in services", async () => {
    const seen: (string | undefined)[] = [];
    const service = async () => {
      await Bun.sleep(1);
      return currentTrace();
    };
    const app = new App({ logger: createLogger({ level: "silent" }), health: false }).get("/", async (ctx) => {
      const trace = await service();
      seen.push(trace && formatTraceparent(trace), `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`);
      return "ok";
    });

    await app.fetch(new Request("http://localhost/", { headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } }));
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toStartWith("00-0af7651916cd43dd8448eb211c80319c-");
  });

  test("is undefined outside a request, and runWithTrace() sets it for other work (jobs)", async () => {
    expect(currentTrace()).toBeUndefined();
    const trace = childTrace(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"));
    expect(trace.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.spanId).not.toBe("b7ad6b7169203331");
    expect(await runWithTrace(trace, async () => currentTrace())).toEqual(trace);
    expect(childTrace(undefined).traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
