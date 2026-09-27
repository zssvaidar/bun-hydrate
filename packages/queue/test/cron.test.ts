import { describe, expect, test } from "bun:test";
import { parseCron } from "../src";

const next = (expression: string, after: string, timezone?: string) => parseCron(expression).next(new Date(after), timezone).toISOString();

describe("parseCron().next()", () => {
  test.each([
    ["*/15 * * * *", "2026-01-01T10:07:00Z", "2026-01-01T10:15:00.000Z"],
    ["*/15 * * * *", "2026-01-01T10:15:00Z", "2026-01-01T10:30:00.000Z"], // strictly after
    ["5,35 * * * *", "2026-01-01T10:06:00Z", "2026-01-01T10:35:00.000Z"],
    ["0 8-18/2 * * *", "2026-01-01T09:00:00Z", "2026-01-01T10:00:00.000Z"],
    ["0 9 * * 1-5", "2026-01-02T10:00:00Z", "2026-01-05T09:00:00.000Z"], // Friday → Monday
    ["0 0 1 * *", "2026-01-15T00:00:00Z", "2026-02-01T00:00:00.000Z"],
    ["0 12 31 * *", "2026-04-01T00:00:00Z", "2026-05-31T12:00:00.000Z"], // April has no 31st
    ["0 0 29 2 *", "2026-03-01T00:00:00Z", "2028-02-29T00:00:00.000Z"], // leap day
    ["0 0 * jan,jul sun", "2026-02-01T00:00:00Z", "2026-07-05T00:00:00.000Z"],
    ["0 0 * * 7", "2026-01-01T00:00:00Z", "2026-01-04T00:00:00.000Z"], // 7 is Sunday too
    ["0 0 13 * 5", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00.000Z"], // day-of-month OR day-of-week
    ["@hourly", "2026-01-01T10:07:00Z", "2026-01-01T11:00:00.000Z"],
    ["@daily", "2026-01-01T10:07:00Z", "2026-01-02T00:00:00.000Z"],
    ["@weekly", "2026-01-01T10:07:00Z", "2026-01-04T00:00:00.000Z"],
    ["@monthly", "2026-01-01T10:07:00Z", "2026-02-01T00:00:00.000Z"],
  ])("%s after %s → %s", (expression, after, expected) => {
    expect(next(expression, after)).toBe(expected);
  });

  test("runs in a named timezone", () => {
    expect(next("0 8 * * *", "2026-01-01T00:00:00Z", "Europe/Berlin")).toBe("2026-01-01T07:00:00.000Z");
    expect(next("0 8 * * *", "2026-07-01T00:00:00Z", "Europe/Berlin")).toBe("2026-07-01T06:00:00.000Z");
  });

  test("a time skipped by DST does not run that day", () => {
    // Berlin jumps from 02:00 to 03:00 on 2026-03-29.
    expect(next("30 2 * * *", "2026-03-28T12:00:00Z", "Europe/Berlin")).toBe("2026-03-30T00:30:00.000Z");
  });

  test("a time repeated by DST runs once, at its first occurrence", () => {
    // Berlin goes from 03:00 back to 02:00 on 2026-10-25, so 02:30 happens twice.
    const first = next("30 2 * * *", "2026-10-24T12:00:00Z", "Europe/Berlin");
    expect(first).toBe("2026-10-25T00:30:00.000Z");
    expect(next("30 2 * * *", first, "Europe/Berlin")).toBe("2026-10-26T01:30:00.000Z");
  });
});

describe("parseCron() refuses what cannot work", () => {
  test.each([
    ["* * * *", "Cron expressions have 5 fields"],
    ["0 * * * * *", "Cron expressions have 5 fields (seconds are not supported)"],
    ["60 * * * *", 'minute "60" is out of range 0-59'],
    ["* 24 * * *", 'hour "24" is out of range 0-23'],
    ["*/0 * * * *", 'minute step "0" must be at least 1'],
    ["* * * foo *", 'month "foo" is not a number or name'],
    ["5-1 * * * *", 'minute range "5-1" is backwards'],
    ["0 0 31 2 *", 'Cron expression "0 0 31 2 *" never matches'],
    ["@often", 'Unknown cron shortcut "@often"'],
  ])("%s", (expression, message) => {
    expect(() => parseCron(expression)).toThrow(message);
  });

  test("unknown timezones", () => {
    expect(() => parseCron("0 0 * * *").next(new Date(), "Mars/Olympus")).toThrow('Unknown timezone "Mars/Olympus"');
  });
});
