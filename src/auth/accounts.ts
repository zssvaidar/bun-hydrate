import { ConflictError } from "@bun-hydrate/core";
import { Database, isUniqueViolation } from "@bun-hydrate/database";

export interface Account {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

interface AccountRow {
  id: string;
  email: string;
  role: string;
  created_at: string;
}

const toAccount = (row: AccountRow): Account => ({ id: row.id, email: row.email, role: row.role, createdAt: row.created_at });

/** Emails are compared case-insensitively, so they are stored and looked up normalized. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Who can sign in. Uses `db.sql`, so it joins any transaction the caller has open. */
export class AccountRepository {
  static readonly inject = [Database] as const;

  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Account | undefined> {
    const [row] = await this.db.sql<AccountRow[]>`select * from accounts where id = ${id}`;
    return row && toAccount(row);
  }

  async findByEmail(email: string): Promise<Account | undefined> {
    const [row] = await this.db.sql<AccountRow[]>`select * from accounts where email = ${normalizeEmail(email)}`;
    return row && toAccount(row);
  }

  async create(input: { email: string; role: string }, now = new Date()): Promise<Account> {
    const account: Account = { id: Bun.randomUUIDv7(), email: normalizeEmail(input.email), role: input.role, createdAt: now.toISOString() };
    try {
      await this.db.sql`insert into accounts ${this.db.sql({ id: account.id, email: account.email, role: account.role, created_at: account.createdAt })}`;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("An account with this email already exists", { code: "EMAIL_TAKEN" });
      throw error;
    }
    return account;
  }

  /** Returns false when there is no such account. */
  async setRole(id: string, role: string): Promise<boolean> {
    const result = await this.db.sql`update accounts set role = ${role} where id = ${id}`;
    return result.count > 0;
  }
}
