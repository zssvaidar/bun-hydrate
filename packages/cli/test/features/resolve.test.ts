import { describe, expect, test } from "bun:test";
import { defineFeature, definePreset } from "../../src/features/define";
import { FeatureRegistry } from "../../src/features/registry";
import { resolveAdd, resolveRemove } from "../../src/features/resolve";

const feature = (id: string, extra: Partial<Parameters<typeof defineFeature>[0]> = {}) =>
  defineFeature({ id, description: `${id} feature`, ...extra });

const registry = new FeatureRegistry(
  [
    feature("auth:core"),
    feature("auth:passwords", { requires: ["auth:core"] }),
    feature("auth:sessions", { requires: ["auth:core"] }),
    feature("auth:jwt", { requires: ["auth:core"], conflicts: ["auth:oidc"] }),
    feature("auth:oidc", { requires: ["auth:core"], conflicts: ["auth:jwt"] }),
    feature("auth:login", { requires: ["auth:passwords", ["auth:sessions", "auth:jwt"]] }),
    feature("auth:ui-account", { requires: ["auth:sessions"] }),
  ],
  [definePreset({ id: "auth", description: "The usual", features: ["auth:core", "auth:passwords", "auth:sessions", "auth:login"] })],
);

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("resolveAdd", () => {
  test("adds missing requirements first and marks them as automatic", () => {
    const { added } = resolveAdd(registry, new Set(), ["auth:passwords"]);
    expect(added).toEqual([
      { id: "auth:core", auto: true, reason: "required by auth:passwords" },
      { id: "auth:passwords", auto: false },
    ]);
  });

  test("an unmet any-of requirement adds its first option", () => {
    expect(ids(resolveAdd(registry, new Set(), ["auth:login"]).added)).toEqual([
      "auth:core",
      "auth:passwords",
      "auth:sessions",
      "auth:login",
    ]);
  });

  test("an any-of requirement met by any option adds nothing more", () => {
    const installed = new Set(["auth:core", "auth:passwords", "auth:jwt"]);
    expect(ids(resolveAdd(registry, installed, ["auth:login"]).added)).toEqual(["auth:login"]);
  });

  test("presets expand, and installed features are reported, not re-added", () => {
    const result = resolveAdd(registry, new Set(["auth:core"]), ["auth"]);
    expect(ids(result.added)).toEqual(["auth:passwords", "auth:sessions", "auth:login"]);
    expect(result.alreadyInstalled).toEqual(["auth:core"]);
  });

  test("conflicts stop the plan with an explanation", () => {
    expect(() => resolveAdd(registry, new Set(["auth:core", "auth:jwt"]), ["auth:oidc"])).toThrow(
      "auth:oidc cannot be installed together with auth:jwt (installed)",
    );
    expect(() => resolveAdd(registry, new Set(), ["auth:jwt", "auth:oidc"])).toThrow(
      "auth:jwt cannot be installed together with auth:oidc (in this plan)",
    );
  });

  test("unknown ids list what exists", () => {
    expect(() => resolveAdd(registry, new Set(), ["auth:magic"])).toThrow(
      'Unknown feature "auth:magic". Run `hydrate features` to see what is available.',
    );
  });
});

describe("resolveRemove", () => {
  const installed = new Set(["auth:core", "auth:passwords", "auth:sessions", "auth:login", "auth:ui-account"]);

  test("dependents block removal and are named", () => {
    expect(() => resolveRemove(registry, installed, ["auth:sessions"], { cascade: false })).toThrow(
      "Cannot remove auth:sessions: auth:login, auth:ui-account depend on it. Remove them first, or use --cascade.",
    );
  });

  test("--cascade removes dependents first", () => {
    const { removed } = resolveRemove(registry, installed, ["auth:sessions"], { cascade: true });
    expect(removed).toEqual([
      { id: "auth:ui-account", auto: true, reason: "depends on auth:sessions" },
      { id: "auth:login", auto: true, reason: "depends on auth:sessions" },
      { id: "auth:sessions", auto: false },
    ]);
  });

  test("a dependent whose any-of requirement is still met stays", () => {
    const withJwt = new Set([...installed, "auth:jwt"]);
    expect(ids(resolveRemove(registry, withJwt, ["auth:ui-account", "auth:sessions"], { cascade: false }).removed)).toEqual([
      "auth:ui-account",
      "auth:sessions",
    ]);
  });

  test("presets remove their installed members; features that are not installed are an error", () => {
    expect(ids(resolveRemove(registry, new Set(["auth:core", "auth:passwords"]), ["auth"], { cascade: false }).removed)).toEqual([
      "auth:passwords",
      "auth:core",
    ]);
    expect(() => resolveRemove(registry, new Set(["auth:core"]), ["auth:jwt"], { cascade: false })).toThrow(
      "auth:jwt is not installed",
    );
  });
});

describe("FeatureRegistry", () => {
  test("orders ids by dependency, then by registration order", () => {
    expect(registry.order(["auth:login", "auth:sessions", "auth:core", "auth:passwords"])).toEqual([
      "auth:core",
      "auth:passwords",
      "auth:sessions",
      "auth:login",
    ]);
  });

  test("rejects duplicate ids and requirements on unknown features", () => {
    expect(() => new FeatureRegistry([feature("a"), feature("a")])).toThrow('Feature "a" is defined twice');
    expect(() => new FeatureRegistry([feature("a", { requires: ["b"] })])).toThrow('Feature "a" requires unknown feature "b"');
  });
});
