import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { schema, validate } from "../src/index";
import type { StandardSchemaV1 } from "../src/standard-schema";

const CreateUser = schema.object({ name: schema.string().min(2), email: schema.email() });
const ListQuery = schema.object({
  limit: schema.coerce.integer().min(1).max(100).default(20),
  tag: schema.array(schema.string()).optional(),
});

function createApp() {
  const app = new App({ logger: createLogger({ level: "silent" }), health: false })
    .post(
      "/users",
      validate({ body: CreateUser }, (ctx, { body }) => {
        ctx.status(201);
        return { created: body };
      }),
    )
    .get(
      "/users",
      validate({ query: ListQuery }, (_ctx, { query }) => query),
    )
    .get(
      "/users/:id",
      validate({ params: schema.object({ id: schema.coerce.integer().positive() }) }, (_ctx, { params }) => ({
        id: params.id,
        type: typeof params.id,
      })),
    )
    .post(
      "/combined/:id",
      validate(
        {
          params: schema.object({ id: schema.uuid() }),
          body: CreateUser,
          headers: schema.object({ "x-tenant": schema.string().min(1) }),
        },
        (_ctx, input) => input,
      ),
    );
  return createTestClient(app);
}

describe("validate()", () => {
  test("passes typed, validated body to the handler", async () => {
    const res = await createApp().post("/users").json({ name: "Ada", email: "ada@example.com", extra: "dropped" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: { name: "Ada", email: "ada@example.com" } });
  });

  test("invalid input is a 422 with every issue and its location", async () => {
    const res = await createApp().post("/users").header("x-request-id", "v-1").json({ name: "A", email: "nope" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Invalid request",
        requestId: "v-1",
        details: [
          { location: "body", path: "name", message: "Must be at least 2 characters" },
          { location: "body", path: "email", message: "Must be a valid email address" },
        ],
      },
    });
  });

  test("malformed JSON stays a 400", async () => {
    const res = await createApp().post("/users").text("{nope").header("content-type", "application/json");
    expect(res.status).toBe(400);
  });

  test("query strings are coerced, defaulted, and repeated keys become arrays", async () => {
    expect(await (await createApp().get("/users")).json()).toEqual({ limit: 20 });
    expect(await (await createApp().get("/users?limit=5&tag=a&tag=b")).json()).toEqual({ limit: 5, tag: ["a", "b"] });
    expect((await createApp().get("/users?limit=500")).status).toBe(422);
  });

  test("params are validated and coerced", async () => {
    expect(await (await createApp().get("/users/7")).json()).toEqual({ id: 7, type: "number" });

    const res = await createApp().get("/users/abc");
    expect((await res.json()).error.details).toEqual([{ location: "params", path: "id", message: "Expected a number" }]);
  });

  test("issues from all sources are reported together", async () => {
    const res = await createApp().post("/combined/not-a-uuid").json({ name: "A", email: "ada@example.com" });
    const locations = (await res.json()).error.details.map((d: { location: string }) => d.location);

    expect(locations).toEqual(["params", "body", "headers"]);
  });

  test("headers are validated with lower-cased names", async () => {
    const res = await createApp()
      .post("/combined/3f2504e0-4f89-41d3-9a0c-0305e82c3301")
      .header("X-Tenant", "acme")
      .json({ name: "Ada", email: "ada@example.com" });

    expect(res.status).toBe(200);
    expect((await res.json()).headers).toEqual({ "x-tenant": "acme" });
  });

  test("accepts any Standard Schema implementation, including async ones", async () => {
    const evenNumber: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "other-library",
        validate: async (value) =>
          typeof value === "number" && value % 2 === 0 ? { value } : { issues: [{ message: "Must be an even number" }] },
      },
    };
    const app = new App({ logger: createLogger({ level: "silent" }), health: false }).post(
      "/even",
      validate({ body: evenNumber }, (_ctx, { body }) => ({ doubled: body * 2 })),
    );
    const client = createTestClient(app);

    expect(await (await client.post("/even").json(4)).json()).toEqual({ doubled: 8 });
    const res = await client.post("/even").json(3);
    expect((await res.json()).error.details).toEqual([{ location: "body", path: "", message: "Must be an even number" }]);
  });

  test("input types follow the schemas (checked by tsc)", () => {
    validate({ body: CreateUser, query: ListQuery }, (_ctx, input) => {
      const name: string = input.body.name;
      const limit: number = input.query.limit;
      // @ts-expect-error — not a field of CreateUser
      void input.body.age;
      // @ts-expect-error — params were not declared
      void input.params;
      return { name, limit };
    });
  });
});
