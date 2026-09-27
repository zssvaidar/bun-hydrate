import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { authenticate, type Strategy } from "@bun-hydrate/auth";
import { App, createLogger } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { createTestClient, type TestClient } from "@bun-hydrate/testing";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { Clock } from "../../shared/clock";
import { usersModule } from "./users.module";

const MIGRATIONS = join(import.meta.dir, "../../../migrations");
const NOW = new Date("2026-09-27T10:00:00.000Z");

/** Signs requests in as `x-test-principal: <email>|<permission,…>`, the way sessions or tokens would. */
const testPrincipals: Strategy = {
  name: "test",
  async authenticate(ctx) {
    const header = ctx.headers.get("x-test-principal");
    if (header === null) return undefined;
    const [email = "", permissions = ""] = header.split("|");
    return { id: email, kind: "user", roles: [], permissions: permissions.split(",").filter(Boolean), via: "jwt", claims: { email } };
  },
};
const ADMIN = "admin@example.com|users.read,users.create,users.update,users.delete";

let db: Database;
let app: App;
let client: TestClient;

beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
  const container = new Container().value(Database, db).value(Clock, () => NOW);
  app = new App({ logger: createLogger({ level: "silent" }), health: false })
    .use(authenticate({ strategies: [testPrincipals] }))
    .route("/users", usersModule(container));
  client = createTestClient(app, { headers: { "x-test-principal": ADMIN } });
});

const as = (principal: string) => createTestClient(app, { headers: { "x-test-principal": principal } });

afterEach(() => db.close());

const createUser = (name: string, email: string) => client.post("/users").json({ name, email });

describe("users module", () => {
  test("POST creates a user and points to it", async () => {
    const res = await createUser("  Ada Lovelace ", "ada@example.com");
    const user = await res.json();

    expect(res.status).toBe(201);
    expect(user).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Ada Lovelace",
      email: "ada@example.com",
      createdAt: NOW.toISOString(),
    });
    expect(res.headers.get("location")).toBe(`/api/v1/users/${user.id}`);
  });

  test("POST validates the body", async () => {
    const res = await createUser("A", "not-an-email");

    expect(res.status).toBe(422);
    expect((await res.json()).error.details.map((d: { path: string }) => d.path)).toEqual(["name", "email"]);
  });

  test("POST with a taken email is a 409", async () => {
    await createUser("Ada", "ada@example.com");
    const res = await createUser("Another Ada", "ada@example.com");

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "EMAIL_TAKEN", message: "Email is already in use" });
  });

  test("GET /:id returns the user, 404 when missing, 422 for a malformed id", async () => {
    const created = await (await createUser("Ada", "ada@example.com")).json();

    expect(await (await client.get(`/users/${created.id}`)).json()).toEqual(created);

    const missing = await client.get("/users/01923c5e-0000-7000-8000-000000000000");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("USER_NOT_FOUND");

    expect((await client.get("/users/42")).status).toBe(422);
  });

  test("GET / pages through users with a cursor", async () => {
    for (const n of [1, 2, 3, 4, 5]) await createUser(`User ${n}`, `user${n}@example.com`);

    const first = await (await client.get("/users").query({ limit: 2 })).json();
    const second = await (await client.get("/users").query({ limit: 2, cursor: first.nextCursor })).json();
    const third = await (await client.get("/users").query({ limit: 2, cursor: second.nextCursor })).json();

    expect(first.items.map((u: { name: string }) => u.name)).toEqual(["User 1", "User 2"]);
    expect(second.items.map((u: { name: string }) => u.name)).toEqual(["User 3", "User 4"]);
    expect(third).toEqual({ items: [expect.objectContaining({ name: "User 5" })], nextCursor: null });
  });

  test("GET / defaults and bounds the page size", async () => {
    expect(await (await client.get("/users")).json()).toEqual({ items: [], nextCursor: null });
    expect((await client.get("/users").query({ limit: 1000 })).status).toBe(422);
  });

  test("PATCH updates only the given fields", async () => {
    const created = await (await createUser("Ada", "ada@example.com")).json();

    const res = await client.patch(`/users/${created.id}`).json({ name: "Ada L." });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...created, name: "Ada L." });
  });

  test("PATCH needs at least one field, and maps conflicts and missing users", async () => {
    const ada = await (await createUser("Ada", "ada@example.com")).json();
    await createUser("Grace", "grace@example.com");

    expect((await client.patch(`/users/${ada.id}`).json({})).status).toBe(422);
    expect((await client.patch(`/users/${ada.id}`).json({ email: "grace@example.com" })).status).toBe(409);
    expect((await client.patch("/users/01923c5e-0000-7000-8000-000000000000").json({ name: "Nobody" })).status).toBe(
      404,
    );
  });

  test("DELETE removes the user", async () => {
    const created = await (await createUser("Ada", "ada@example.com")).json();

    expect((await client.delete(`/users/${created.id}`)).status).toBe(204);
    expect((await client.get(`/users/${created.id}`)).status).toBe(404);
    expect((await client.delete(`/users/${created.id}`)).status).toBe(404);
  });

  test("signed-out callers get 401; callers without the permission get 403", async () => {
    const member = as("bob@example.com|");

    expect((await createTestClient(app).get("/users")).status).toBe(401);
    expect((await member.get("/users")).status).toBe(403);
    expect((await member.post("/users").json({ name: "Eve", email: "eve@example.com" })).status).toBe(403);
    const ada = await (await createUser("Ada", "ada@example.com")).json();
    expect((await member.get(`/users/${ada.id}`)).status).toBe(403);
    expect((await member.delete(`/users/${ada.id}`)).status).toBe(403);
  });

  test("users may read and rename their own entry, but not move it to another email", async () => {
    const ada = await (await createUser("Ada", "ada@example.com")).json();
    const self = as("ada@example.com|");

    expect((await self.get(`/users/${ada.id}`)).status).toBe(200);
    expect(await (await self.patch(`/users/${ada.id}`).json({ name: "Ada L." })).json()).toMatchObject({ name: "Ada L." });
    expect((await self.patch(`/users/${ada.id}`).json({ email: "other@example.com" })).status).toBe(403);
    expect((await self.delete(`/users/${ada.id}`)).status).toBe(403);
  });
});
