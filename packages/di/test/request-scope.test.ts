import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { Container, requestScope, scopeOf } from "../src/index";

describe("requestScope", () => {
  test("gives every request its own scope and disposes it after the response", async () => {
    const disposed: number[] = [];
    let created = 0;

    class RequestState {
      readonly id = ++created;
      [Symbol.dispose]() {
        disposed.push(this.id);
      }
    }

    const container = new Container().bind(RequestState, { lifetime: "scoped" });
    const app = new App({ logger: createLogger({ level: "silent" }), health: false })
      .use(requestScope(container))
      .get("/", (ctx) => {
        const scope = scopeOf(ctx);
        return { id: scope.get(RequestState).id, same: scope.get(RequestState) === scope.get(RequestState) };
      });
    const client = createTestClient(app);

    expect(await (await client.get("/")).json()).toEqual({ id: 1, same: true });
    expect(await (await client.get("/")).json()).toEqual({ id: 2, same: true });
    expect(disposed).toEqual([1, 2]);
  });

  test("the scope is disposed even when the handler throws", async () => {
    const disposed: string[] = [];
    class RequestState {
      [Symbol.dispose]() {
        disposed.push("disposed");
      }
    }
    const container = new Container().bind(RequestState, { lifetime: "scoped" });
    const app = new App({ logger: createLogger({ level: "silent" }), health: false })
      .use(requestScope(container))
      .get("/", (ctx) => {
        scopeOf(ctx).get(RequestState);
        throw new Error("boom");
      });

    expect((await createTestClient(app).get("/")).status).toBe(500);
    expect(disposed).toEqual(["disposed"]);
  });

  test("scopeOf() explains how to fix a missing middleware", async () => {
    const app = new App({ logger: createLogger({ level: "silent" }), health: false, exposeErrors: true }).get(
      "/",
      (ctx) => scopeOf(ctx),
    );
    const { error } = await (await createTestClient(app).get("/")).json();

    expect(error.message).toBe("No request scope: add app.use(requestScope(container)) before this route");
  });
});
