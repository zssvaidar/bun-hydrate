import { MAX_PASSWORD_LENGTH } from "@bun-hydrate/auth";
import { CommandUsageError, optionalOption, requiredOption, type CommandHandler } from "@bun-hydrate/cli/commands";
import { AccountRepository } from "./accounts";
import { DEFAULT_ROLE } from "./config";
import { assertRole, authContainer } from "./core.commands";
import { MIN_PASSWORD_LENGTH, Passwords } from "./passwords";

/**
 * `hydrate auth:create-user --email <email> [--role <role>]`: bootstraps the first admin, which no
 * HTTP route can do safely. The password is read at a hidden prompt or from --password-stdin.
 */
export const createUserCommand: CommandHandler = async (ctx) => {
  const email = requiredOption(ctx, "email");
  const role = optionalOption(ctx, "role") ?? DEFAULT_ROLE;
  assertRole(role);

  const password = await ctx.readSecret("Password: ");
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new CommandUsageError(`The password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters long`);
  }

  const container = authContainer(ctx.db);
  const account = await ctx.db.transaction(async () => {
    const created = await container.get(AccountRepository).create({ email, role });
    await container.get(Passwords).set(created.id, password);
    return created;
  });
  ctx.print(`Created ${account.email} (${role}), id ${account.id}`);
};
