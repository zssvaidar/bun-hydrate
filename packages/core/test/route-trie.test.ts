import { describe, expect, test } from "bun:test";
import { RouteTrie } from "../src/route-trie";
import { BadRequestError } from "../src/errors";

function trieWith(...routes: [method: string, path: string][]) {
  const trie = new RouteTrie<string>();
  for (const [method, path] of routes) trie.add(method, path, `${method} ${path}`);
  return trie;
}

describe("RouteTrie", () => {
  test("matches static paths", () => {
    const trie = trieWith(["GET", "/"], ["GET", "/users"], ["GET", "/users/me"]);

    expect(trie.match("GET", "/")).toEqual({ kind: "found", value: "GET /", params: {} });
    expect(trie.match("GET", "/users/me")).toEqual({ kind: "found", value: "GET /users/me", params: {} });
  });

  test("captures named parameters", () => {
    const trie = trieWith(["GET", "/orders/:orderId/items/:itemId"]);

    expect(trie.match("GET", "/orders/o1/items/i2")).toEqual({
      kind: "found",
      value: "GET /orders/:orderId/items/:itemId",
      params: { orderId: "o1", itemId: "i2" },
    });
  });

  test("decodes percent-encoded parameters", () => {
    const trie = trieWith(["GET", "/files/:name"]);
    expect(trie.match("GET", "/files/a%20b.txt")).toMatchObject({ params: { name: "a b.txt" } });
  });

  test("rejects malformed percent-encoding with a 400", () => {
    const trie = trieWith(["GET", "/files/:name"]);
    expect(() => trie.match("GET", "/files/%E0%A4%A")).toThrow(BadRequestError);
  });

  test("prefers static over param over wildcard regardless of registration order", () => {
    const trie = trieWith(["GET", "/users/*"], ["GET", "/users/:id"], ["GET", "/users/me"]);

    expect(trie.match("GET", "/users/me")).toMatchObject({ value: "GET /users/me" });
    expect(trie.match("GET", "/users/42")).toMatchObject({ value: "GET /users/:id", params: { id: "42" } });
    expect(trie.match("GET", "/users/42/posts")).toMatchObject({ value: "GET /users/*", params: { "*": "42/posts" } });
  });

  test("backtracks when a static branch dead-ends", () => {
    const trie = trieWith(["GET", "/users/me/settings"], ["GET", "/users/:id/posts"]);
    expect(trie.match("GET", "/users/me/posts")).toMatchObject({ params: { id: "me" } });
  });

  test("ignores trailing slashes and duplicate slashes", () => {
    const trie = trieWith(["GET", "/users"]);
    expect(trie.match("GET", "/users/")).toMatchObject({ kind: "found" });
    expect(trie.match("GET", "//users")).toMatchObject({ kind: "found" });
  });

  test("reports allowed methods (with implicit HEAD and OPTIONS) when only the method is wrong", () => {
    const trie = trieWith(["GET", "/users"], ["POST", "/users"]);
    expect(trie.match("DELETE", "/users")).toEqual({
      kind: "method-not-allowed",
      allowed: ["GET", "HEAD", "OPTIONS", "POST"],
    });
  });

  test("HEAD falls back to GET, and ALL matches any method", () => {
    const trie = trieWith(["GET", "/users"], ["*", "/any"]);
    expect(trie.match("HEAD", "/users")).toMatchObject({ kind: "found", value: "GET /users" });
    expect(trie.match("PATCH", "/any")).toMatchObject({ kind: "found", value: "* /any" });
  });

  test("reports not-found for unknown paths", () => {
    expect(trieWith(["GET", "/users"]).match("GET", "/nope")).toEqual({ kind: "not-found" });
  });

  test("throws on duplicate method + path", () => {
    const trie = trieWith(["GET", "/users/:id"]);
    expect(() => trie.add("GET", "/users/:id", "again")).toThrow("Route already registered: GET /users/:id");
  });

  test("throws when the same position uses two different param names", () => {
    const trie = trieWith(["GET", "/users/:id"]);
    expect(() => trie.add("POST", "/users/:userId", "x")).toThrow(/conflicting parameter names/);
  });

  test("only allows the wildcard as the last segment", () => {
    expect(() => trieWith(["GET", "/files/*/meta"])).toThrow(/wildcard/);
  });
});
