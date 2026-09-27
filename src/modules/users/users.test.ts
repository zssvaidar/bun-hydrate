import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { App, createLogger } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { createTestClient, type TestClient } from "@bun-hydrate/testing";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { Clock } from "../../shared/clock";
import { usersModule } from "./users.module";

const MIGRATIONS = join(import.meta.dir, "../../../migrations");
const NOW = new Date("2026-09-27T10:00:00.000Z");

let db: Database;
let client: TestClient;

beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
  const container = new Container().value(Database, db).value(Clock, () => NOW);
  const app = new App({ logger: createLogger({ level: "silent" }), health: false }).route("/users", usersModule(container));
  client = createTestClient(app);
});

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
});
