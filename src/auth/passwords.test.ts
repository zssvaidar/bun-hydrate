import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "@bun-hydrate/database";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { AccountRepository } from "./accounts";
import { PasswordStore, Passwords } from "./passwords";

const MIGRATIONS = join(import.meta.dir, "../../migrations");

let db: Database;
let accounts: AccountRepository;
let passwords: Passwords;

beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
  accounts = new AccountRepository(db);
  passwords = new Passwords(new PasswordStore(db));
});

afterEach(() => db.close());

describe("Passwords", () => {
  test("verifies the password that was set, and only that one", async () => {
    const account = await accounts.create({ email: "ada@example.com", role: "member" });
    await passwords.set(account.id, "correct horse battery");

    expect(await passwords.verify(account, "correct horse battery")).toBe(true);
    expect(await passwords.verify(account, "wrong")).toBe(false);
  });

  test("stores a hash, never the password", async () => {
    const account = await accounts.create({ email: "ada@example.com", role: "member" });
    await passwords.set(account.id, "correct horse battery");

    expect(await new PasswordStore(db).get(account.id)).toStartWith("$argon2id$");
  });

  test("unknown accounts and accounts without a password never verify", async () => {
    const account = await accounts.create({ email: "ada@example.com", role: "member" });

    expect(await passwords.verify(undefined, "anything")).toBe(false);
    expect(await passwords.verify(account, "anything")).toBe(false);
  });
});
