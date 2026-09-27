import { describe, expect, test } from "bun:test";
import { can, createPermissions, permissionMatches } from "../src/permissions";

describe("permissionMatches", () => {
  test.each([
    ["*", "users.read", true],
    ["users.read", "users.read", true],
    ["users.read", "users.update", false],
    ["users.*", "users.read", true],
    ["users.*", "users.profile.read", true],
    ["users.*", "users", false],
    ["users.*", "usersx.read", false],
    ["user.*", "users.read", false],
  ])("%p grants %p: %p", (granted, required, expected) => {
    expect(permissionMatches(granted, required)).toBe(expected);
  });
});

describe("can", () => {
  const principal = { permissions: ["users.read", "profile.*"] };

  test("requires every listed permission", () => {
    expect(can(principal, "users.read")).toBe(true);
    expect(can(principal, "users.read", "profile.update")).toBe(true);
    expect(can(principal, "users.read", "users.delete")).toBe(false);
  });

  test("anonymous (null/undefined) can do nothing", () => {
    expect(can(undefined, "users.read")).toBe(false);
    expect(can(null, "users.read")).toBe(false);
  });

  test("accepts a plain permission list too (e.g. the React snapshot)", () => {
    expect(can(["*"], "anything.at.all")).toBe(true);
  });
});

describe("createPermissions (typed, checked by tsc)", () => {
  const PERMISSIONS = ["users.read", "users.delete", "profile.read"] as const;
  type Permission = (typeof PERMISSIONS)[number];
  const permissions = createPermissions<Permission>();

  test("a policy resolves roles, including wildcards, to concrete permissions", () => {
    const policy = permissions.definePolicy({
      roles: { admin: ["*"], moderator: ["users.*"], member: ["profile.read"] },
    });

    expect(policy.permissionsFor(["member"])).toEqual(["profile.read"]);
    expect(policy.permissionsFor(["moderator", "member"])).toEqual(["users.*", "profile.read"]);
    expect(policy.permissionsFor(["unknown-role"])).toEqual([]);
    expect(permissions.can({ permissions: policy.permissionsFor(["moderator"]) }, "users.delete")).toBe(true);
  });

  test("typos are compile errors", () => {
    // @ts-expect-error — not a known permission
    permissions.can({ permissions: [] }, "users.dlete");
    permissions.definePolicy({
      // @ts-expect-error — "user" is not a prefix of any permission
      roles: { broken: ["user.*"] },
    });
  });
});
