import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/duration";

describe("parseDuration", () => {
  test.each([
    ["250ms", 250],
    ["30s", 30_000],
    ["1m", 60_000],
    ["15m", 900_000],
    ["1h", 3_600_000],
    ["7d", 604_800_000],
    ["1.5h", 5_400_000],
  ])("%p is %i ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  test("numbers are already milliseconds", () => {
    expect(parseDuration(1500)).toBe(1500);
  });

  test.each(["", "10", "5 minutes", "-1m", "1w", "m", "0s"])("rejects %p", (input) => {
    expect(() => parseDuration(input)).toThrow(`Invalid duration "${input}": use a positive number with ms, s, m, h or d`);
  });

  test("rejects non-positive numbers", () => {
    expect(() => parseDuration(0)).toThrow("Invalid duration");
  });
});
