import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger";

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line), records: () => lines.map((l) => JSON.parse(l)) };
}

describe("createLogger", () => {
  test("writes one JSON object per line with time, level and msg", () => {
    const out = capture();
    const logger = createLogger({ format: "json", write: out.write });

    logger.info("User created", { userId: "u1" });

    expect(out.lines).toHaveLength(1);
    const [record] = out.records();
    expect(record).toMatchObject({ level: "info", msg: "User created", userId: "u1" });
    expect(Number.isNaN(Date.parse(record.time))).toBe(false);
  });

  test("drops records below the configured level", () => {
    const out = capture();
    const logger = createLogger({ format: "json", level: "warn", write: out.write });

    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("shown");
    logger.error("shown");

    expect(out.records().map((r) => r.level)).toEqual(["warn", "error"]);
  });

  test("silent level writes nothing", () => {
    const out = capture();
    const logger = createLogger({ level: "silent", write: out.write });

    logger.fatal("nope");

    expect(out.lines).toHaveLength(0);
  });

  test("child loggers add bindings without affecting the parent", () => {
    const out = capture();
    const logger = createLogger({ format: "json", write: out.write, bindings: { service: "api" } });

    logger.child({ requestId: "r1" }).info("in request");
    logger.info("outside");

    const [inside, outside] = out.records();
    expect(inside).toMatchObject({ service: "api", requestId: "r1" });
    expect(outside.requestId).toBeUndefined();
  });

  test("serializes Error values with name, message and stack", () => {
    const out = capture();
    const logger = createLogger({ format: "json", write: out.write });

    logger.error("failed", { error: new RangeError("too big") });

    const [record] = out.records();
    expect(record.error).toMatchObject({ name: "RangeError", message: "too big" });
    expect(record.error.stack).toContain("RangeError");
  });

  test("pretty format is human readable and includes fields", () => {
    const out = capture();
    const logger = createLogger({ format: "pretty", write: out.write });

    logger.warn("slow query", { ms: 120 });

    expect(out.lines[0]).toContain("WARN");
    expect(out.lines[0]).toContain("slow query");
    expect(out.lines[0]).toContain("ms=120");
  });

  test("isLevelEnabled reflects the threshold", () => {
    const logger = createLogger({ level: "info", write: () => {} });

    expect(logger.isLevelEnabled("debug")).toBe(false);
    expect(logger.isLevelEnabled("error")).toBe(true);
  });
});
