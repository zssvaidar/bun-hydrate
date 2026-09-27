import { NotFoundError } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Clock } from "../../shared/clock";
import type { Page } from "../../shared/pagination";
import { UsersRepository } from "./users.repository";
import type { CreateUser, ListUsersQuery, UpdateUser, User } from "./users.schema";

/** Business rules. Knows nothing about HTTP; decides transaction boundaries. */
export class UsersService {
  static readonly inject = [UsersRepository, Database, Clock] as const;

  constructor(
    private readonly users: UsersRepository,
    private readonly db: Database,
    private readonly clock: () => Date,
  ) {}

  async get(id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundError("User not found", { code: "USER_NOT_FOUND" });
    return user;
  }

  list(query: ListUsersQuery): Promise<Page<User>> {
    return this.users.list(query);
  }

  async create(input: CreateUser): Promise<User> {
    const user: User = { id: Bun.randomUUIDv7(), ...input, createdAt: this.clock().toISOString() };
    await this.users.insert(user);
    return user;
  }

  /** Read-check-write in one transaction, so the returned user is exactly what was stored. */
  update(id: string, changes: UpdateUser): Promise<User> {
    return this.db.transaction(async () => {
      await this.get(id);
      await this.users.update(id, changes);
      return this.get(id);
    });
  }

  async delete(id: string): Promise<void> {
    if (!(await this.users.delete(id))) throw new NotFoundError("User not found", { code: "USER_NOT_FOUND" });
  }
}
