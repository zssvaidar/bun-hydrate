import { describe, expect, test } from "bun:test";
import { parse, schema, type Infer } from "../src/index";
import { ValidationError } from "@bun-hydrate/core";

/** Runs a schema through its Standard Schema interface, the way any consumer would. */
function check(target: { "~standard": { validate(value: unknown): unknown } }, value: unknown) {
  return target["~standard"].validate(value) as
    | { value: unknown; issues?: undefined }
    | { issues: { message: string; path?: PropertyKey[] }[] };
}

const issuesOf = (target: Parameters<typeof check>[0], value: unknown) => {
  const result = check(target, value);
  return "issues" in result && result.issues ? result.issues.map((i) => ({ path: (i.path ?? []).join("."), message: i.message })) : [];
};

describe("Standard Schema interface", () => {
  test("exposes version 1 and the vendor", () => {
    const props = schema.string()["~standard"];
    expect(props.version).toBe(1);
    expect(props.vendor).toBe("bun-hydrate");
  });

  test("returns the value on success and issues on failure", () => {
    expect(check(schema.string(), "ok")).toEqual({ value: "ok" });
    expect(issuesOf(schema.string(), 1)).toEqual([{ path: "", message: "Expected a string" }]);
  });
});

describe("string", () => {
  test("length rules", () => {
    const name = schema.string().min(2).max(4);
    expect(issuesOf(name, "a")).toEqual([{ path: "", message: "Must be at least 2 characters" }]);
    expect(issuesOf(name, "abcde")).toEqual([{ path: "", message: "Must be at most 4 characters" }]);
    expect(issuesOf(schema.string().length(3), "ab")[0]?.message).toBe("Must be exactly 3 characters");
    expect(issuesOf(schema.string().nonEmpty(), "")[0]?.message).toBe("Must not be empty");
  });

  test("regex with a custom message", () => {
    const slug = schema.string().regex(/^[a-z-]+$/, "Only lowercase letters and dashes");
    expect(issuesOf(slug, "Nope!")[0]?.message).toBe("Only lowercase letters and dashes");
  });

  test("trim transforms before the length rules run", () => {
    expect(check(schema.string().trim().min(2), "  ab  ")).toEqual({ value: "ab" });
    expect(issuesOf(schema.string().trim().min(2), "  a  ")).toHaveLength(1);
  });

  test("builders are immutable", () => {
    const base = schema.string();
    base.min(5);
    expect(check(base, "a")).toEqual({ value: "a" });
  });

  test("formats", () => {
    expect(check(schema.email(), "ada@example.com")).toEqual({ value: "ada@example.com" });
    expect(issuesOf(schema.email(), "ada@")[0]?.message).toBe("Must be a valid email address");
    expect(issuesOf(schema.url(), "not a url")[0]?.message).toBe("Must be a valid URL");
    expect(check(schema.uuid(), "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toEqual({
      value: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(issuesOf(schema.uuid(), "123")[0]?.message).toBe("Must be a valid UUID");
  });
});

describe("number, boolean, literal, enum", () => {
  test("number rules", () => {
    expect(issuesOf(schema.number(), "1")[0]?.message).toBe("Expected a number");
    expect(issuesOf(schema.number(), Number.NaN)[0]?.message).toBe("Expected a number");
    expect(issuesOf(schema.number().int(), 1.5)[0]?.message).toBe("Must be an integer");
    expect(issuesOf(schema.number().min(1), 0)[0]?.message).toBe("Must be at least 1");
    expect(issuesOf(schema.number().max(1), 2)[0]?.message).toBe("Must be at most 1");
    expect(issuesOf(schema.number().positive(), 0)[0]?.message).toBe("Must be positive");
  });

  test("boolean, literal and enum", () => {
    expect(issuesOf(schema.boolean(), "true")[0]?.message).toBe("Expected a boolean");
    expect(issuesOf(schema.literal("v1"), "v2")[0]?.message).toBe('Expected "v1"');
    expect(issuesOf(schema.enum(["a", "b"]), "c")[0]?.message).toBe("Expected one of: a, b");
    expect(check(schema.enum(["a", "b"]), "b")).toEqual({ value: "b" });
  });
});

describe("coercion for query strings and params", () => {
  test("coerce.number / integer / boolean", () => {
    expect(check(schema.coerce.number(), "2.5")).toEqual({ value: 2.5 });
    expect(check(schema.coerce.number(), 3)).toEqual({ value: 3 });
    expect(issuesOf(schema.coerce.number(), "")[0]?.message).toBe("Expected a number");
    expect(issuesOf(schema.coerce.number(), "abc")[0]?.message).toBe("Expected a number");
    expect(check(schema.coerce.integer().max(100), "20")).toEqual({ value: 20 });
    expect(issuesOf(schema.coerce.integer(), "1.5")[0]?.message).toBe("Must be an integer");
    expect(check(schema.coerce.boolean(), "true")).toEqual({ value: true });
    expect(check(schema.coerce.boolean(), "0")).toEqual({ value: false });
    expect(issuesOf(schema.coerce.boolean(), "maybe")[0]?.message).toBe("Expected a boolean");
  });
});

describe("modifiers", () => {
  test("optional, nullable and default", () => {
    expect(check(schema.string().optional(), undefined)).toEqual({ value: undefined });
    expect(issuesOf(schema.string(), undefined)[0]?.message).toBe("Required");
    expect(check(schema.string().nullable(), null)).toEqual({ value: null });
    expect(check(schema.number().default(20), undefined)).toEqual({ value: 20 });
    expect(check(schema.number().default(20), 5)).toEqual({ value: 5 });
  });

  test("refine adds a custom rule that runs after the base checks", () => {
    const even = schema.number().int().refine((n) => n % 2 === 0, "Must be even");
    expect(issuesOf(even, 3)).toEqual([{ path: "", message: "Must be even" }]);
    expect(issuesOf(even, "x")).toEqual([{ path: "", message: "Expected a number" }]);
    expect(check(even, 4)).toEqual({ value: 4 });
  });
});

describe("array and object", () => {
  const User = schema.object({
    name: schema.string().min(2),
    tags: schema.array(schema.string().min(1)).max(2),
    address: schema.object({ city: schema.string() }).optional(),
  });

  test("reports every issue with its path", () => {
    expect(issuesOf(User, { name: "a", tags: ["ok", "", "x"], address: { city: 1 } })).toEqual([
      { path: "name", message: "Must be at least 2 characters" },
      { path: "tags.1", message: "Must be at least 1 character" },
      { path: "tags", message: "Must have at most 2 items" },
      { path: "address.city", message: "Expected a string" },
    ]);
  });

  test("missing required keys are reported as Required", () => {
    expect(issuesOf(User, {})).toEqual([
      { path: "name", message: "Required" },
      { path: "tags", message: "Required" },
    ]);
  });

  test("strips unknown keys by default and rejects them in strict mode", () => {
    expect(check(schema.object({ a: schema.number() }), { a: 1, extra: true })).toEqual({ value: { a: 1 } });
    expect(issuesOf(schema.object({ a: schema.number() }).strict(), { a: 1, extra: true })).toEqual([
      { path: "extra", message: "Unknown field" },
    ]);
  });

  test("rejects non-objects and arrays where an object is expected", () => {
    expect(issuesOf(User, [])[0]?.message).toBe("Expected an object");
    expect(issuesOf(schema.array(schema.string()), "x")[0]?.message).toBe("Expected an array");
  });

  test("applies nested defaults and transforms to the output", () => {
    const Query = schema.object({ limit: schema.coerce.integer().default(20), q: schema.string().trim().optional() });
    expect(check(Query, { q: "  hi " })).toEqual({ value: { limit: 20, q: "hi" } });
  });

  test("does not mutate the input", () => {
    const input = { name: "  Ada ", tags: [] };
    check(schema.object({ name: schema.string().trim(), tags: schema.array(schema.string()) }), input);
    expect(input.name).toBe("  Ada ");
  });
});

describe("parse", () => {
  test("returns typed output or throws ValidationError with details", () => {
    expect(parse(schema.number(), 1)).toBe(1);
    try {
      parse(schema.object({ n: schema.number() }), { n: "x" });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual([{ path: "n", message: "Expected a number" }]);
    }
  });
});

describe("type inference (checked by tsc)", () => {
  test("Infer produces the output type, with optional keys for optional fields", () => {
    const Schema = schema.object({
      name: schema.string(),
      age: schema.number().optional(),
      role: schema.enum(["member", "admin"]).default("member"),
      tags: schema.array(schema.string()),
      note: schema.string().nullable(),
    });
    type Output = Infer<typeof Schema>;

    const value: Output = { name: "a", role: "admin", tags: [], note: null };
    const role: "member" | "admin" = value.role;
    const age: number | undefined = value.age;
    // @ts-expect-error — name is required
    const missing: Output = { role: "member", tags: [], note: null };
    // @ts-expect-error — role is a closed set
    const wrongRole: Output["role"] = "owner";
    void [role, age, missing, wrongRole];
  });
});
