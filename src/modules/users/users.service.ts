import { can, type Principal } from "@bun-hydrate/auth";
import { ForbiddenError, NotFoundError } from "@bun-hydrate/core";
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

  /** People with users.read see anyone; everyone else only their own entry, matched by email. */
  async getFor(actor: Principal, id: string): Promise<User> {
    const user = await this.get(id);
    if (!can(actor, "users.read") && !isOwnEntry(actor, user)) throw notYours();
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

  /**
   * Read-check-write in one transaction, so the returned user is exactly what was stored. Owners
   * may rename their entry; changing its email (which is what links it to them) needs users.update.
   */
  update(actor: Principal, id: string, changes: UpdateUser): Promise<User> {
    return this.db.transaction(async () => {
      const user = await this.get(id);
      const ownEdit = isOwnEntry(actor, user) && (changes.email === undefined || changes.email === user.email);
      if (!can(actor, "users.update") && !ownEdit) throw notYours();
      await this.users.update(id, changes);
      return this.get(id);
    });
  }

  async delete(id: string): Promise<void> {
    if (!(await this.users.delete(id))) throw new NotFoundError("User not found", { code: "USER_NOT_FOUND" });
  }
}

function isOwnEntry(actor: Principal, user: User): boolean {
  return typeof actor.claims?.email === "string" && actor.claims.email.toLowerCase() === user.email.toLowerCase();
}

const notYours = () => new ForbiddenError("You can only view and rename your own entry", { code: "NOT_YOUR_ENTRY" });
