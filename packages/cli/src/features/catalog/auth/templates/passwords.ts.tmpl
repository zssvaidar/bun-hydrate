import { defineAuthFeature, hashPassword, needsRehash, verifyPassword } from "@bun-hydrate/auth";
import { Database } from "@bun-hydrate/database";
import type { Account } from "./accounts";

export const MIN_PASSWORD_LENGTH = 8;

/** One argon2id hash per account, in `account_passwords`. */
export class PasswordStore {
  static readonly inject = [Database] as const;

  constructor(private readonly db: Database) {}

  async get(accountId: string): Promise<string | undefined> {
    const [row] = await this.db.sql<{ hash: string }[]>`select hash from account_passwords where account_id = ${accountId}`;
    return row?.hash;
  }

  /** Delete-then-insert works on every database; inside a caller's transaction it becomes a savepoint. */
  async set(accountId: string, hash: string, now = new Date()): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.sql`delete from account_passwords where account_id = ${accountId}`;
      await this.db.sql`insert into account_passwords ${this.db.sql({ account_id: accountId, hash, updated_at: now.toISOString() })}`;
    });
  }
}

export class Passwords {
  static readonly inject = [PasswordStore] as const;

  constructor(private readonly store: PasswordStore) {}

  async set(accountId: string, password: string): Promise<void> {
    await this.store.set(accountId, await hashPassword(password));
  }

  /**
   * Does the same hashing work whether or not the account exists, so response times do not reveal
   * which emails are registered. Upgrades hashes made with older parameters on success.
   */
  async verify(account: Account | undefined, password: string): Promise<boolean> {
    const hash = account ? await this.store.get(account.id) : undefined;
    const valid = await verifyPassword(password, hash);
    if (!valid || !account || !hash) return false;
    if (needsRehash(hash)) await this.set(account.id, password);
    return true;
  }
}

export const passwordsFeature = defineAuthFeature({
  id: "auth:passwords",
  requires: ["auth:core"],
  register(container) {
    container.bind(PasswordStore).bind(Passwords);
  },
});
