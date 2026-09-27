import { SessionManager } from "@bun-hydrate/auth";
import { CommandUsageError, requiredOption, type CommandHandler } from "@bun-hydrate/cli/commands";
import { AccountRepository } from "./accounts";
import { authContainer } from "./core.commands";

/** `hydrate auth:revoke-sessions --email <email>`: signs a user out everywhere. */
export const revokeSessionsCommand: CommandHandler = async (ctx) => {
  const email = requiredOption(ctx, "email");
  const container = authContainer(ctx.db);
  const account = await container.get(AccountRepository).findByEmail(email);
  if (!account) throw new CommandUsageError(`No account with email ${email}`);

  const ended = await container.get(SessionManager).destroyAllFor(account.id);
  ctx.print(`Ended ${ended} session(s) for ${account.email}`);
};
