import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "@bun-hydrate/database";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { AccountRepository } from "./accounts";

const MIGRATIONS = join(import.meta.dir, "../../migrations");

let db: Database;
let accounts: AccountRepository;

beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
  accounts = new AccountRepository(db);
});

afterEach(() => db.close());

describe("AccountRepository", () => {
  test("creates accounts and finds them by id or by email, ignoring case", async () => {
    const account = await accounts.create({ email: " Ada@Example.com ", role: "member" });

    expect(account.email).toBe("ada@example.com");
    expect(await accounts.findById(account.id)).toEqual(account);
    expect(await accounts.findByEmail("ADA@example.com")).toEqual(account);
  });

  test("an email can only be registered once", async () => {
    await accounts.create({ email: "ada@example.com", role: "member" });
    expect(accounts.create({ email: "ADA@example.com", role: "member" })).rejects.toThrow("already exists");
  });

  test("changes roles", async () => {
    const account = await accounts.create({ email: "ada@example.com", role: "member" });

    expect(await accounts.setRole(account.id, "admin")).toBe(true);
    expect((await accounts.findById(account.id))?.role).toBe("admin");
    expect(await accounts.setRole("missing", "admin")).toBe(false);
  });
});
