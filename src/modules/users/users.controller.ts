import { validate } from "@bun-hydrate/validation";
import { UsersService } from "./users.service";
import { CreateUserBody, ListUsersQuery, UpdateUserBody, UserParams } from "./users.schema";

/** HTTP concerns only: validated input in, service call, status and headers out. */
export class UsersController {
  static readonly inject = [UsersService] as const;

  constructor(private readonly users: UsersService) {}

  readonly list = validate({ query: ListUsersQuery }, (_ctx, { query }) => this.users.list(query));

  readonly get = validate({ params: UserParams }, (_ctx, { params }) => this.users.get(params.id));

  readonly create = validate({ body: CreateUserBody }, async (ctx, { body }) => {
    const user = await this.users.create(body);
    ctx.status(201).header("location", `/api/v1/users/${user.id}`);
    return user;
  });

  readonly update = validate({ params: UserParams, body: UpdateUserBody }, (_ctx, { params, body }) =>
    this.users.update(params.id, body),
  );

  readonly remove = validate({ params: UserParams }, async (_ctx, { params }) => {
    await this.users.delete(params.id);
  });
}
