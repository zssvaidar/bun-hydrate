import { ConflictError } from "@bun-hydrate/core";
import { Database, isUniqueViolation } from "@bun-hydrate/database";
import type { Page } from "../../shared/pagination";
import type { ListUsersQuery, UpdateUser, User } from "./users.schema";

interface UserRow {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

const toUser = (row: UserRow): User => ({ id: row.id, name: row.name, email: row.email, createdAt: row.created_at });

/** Persistence only. Uses `db.sql`, so it joins any transaction the caller has open. */
export class UsersRepository {
  static readonly inject = [Database] as const;

  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.sql<UserRow[]>`select * from users where id = ${id}`;
    return row && toUser(row);
  }

  /** IDs are UUIDv7, so ordering by id is creation order and a stable cursor. */
  async list({ limit, cursor }: ListUsersQuery): Promise<Page<User>> {
    const rows = cursor
      ? await this.db.sql<UserRow[]>`select * from users where id > ${cursor} order by id limit ${limit + 1}`
      : await this.db.sql<UserRow[]>`select * from users order by id limit ${limit + 1}`;
    const items = rows.slice(0, limit).map(toUser);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  async insert(user: User): Promise<void> {
    const row: UserRow = { id: user.id, name: user.name, email: user.email, created_at: user.createdAt };
    await this.translateConflicts(() => this.db.sql`insert into users ${this.db.sql(row)}`);
  }

  async update(id: string, changes: UpdateUser): Promise<void> {
    const columns = Object.keys(changes) as (keyof UpdateUser)[];
    await this.translateConflicts(() => this.db.sql`update users set ${this.db.sql(changes, ...columns)} where id = ${id}`);
  }

  /** Returns false when there was no such user. */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.sql`delete from users where id = ${id}`;
    return result.count > 0;
  }

  private async translateConflicts(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Email is already in use", { code: "EMAIL_TAKEN", cause: error });
      }
      throw error;
    }
  }
}
