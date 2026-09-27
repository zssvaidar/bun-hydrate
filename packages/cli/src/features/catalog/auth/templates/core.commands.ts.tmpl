import { SessionManager, permissionMatches } from "@bun-hydrate/auth";
import { CommandUsageError, requiredOption, type CommandHandler } from "@bun-hydrate/cli/commands";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { PERMISSIONS } from "../shared/permissions";
import { AccountRepository } from "./accounts";
import { auth } from "./index";

/** The app's auth services on a given database, without an HTTP app. */
export function authContainer(db: Database): Container {
  const container = new Container().value(Database, db);
  auth.register(container);
  return container;
}

export function assertRole(role: string): void {
  const roles = Object.keys(auth.policy.roles);
  if (!roles.includes(role)) {
    throw new CommandUsageError(`Unknown role "${role}". Roles: ${roles.join(", ")} (see src/auth/config.ts)`);
  }
}

/** `hydrate auth:set-role --email <email> --role <role>`: also ends the user's sessions, so it applies at once. */
export const setRoleCommand: CommandHandler = async (ctx) => {
  const email = requiredOption(ctx, "email");
  const role = requiredOption(ctx, "role");
  assertRole(role);

  const container = authContainer(ctx.db);
  const accounts = container.get(AccountRepository);
  const account = await accounts.findByEmail(email);
  if (!account) throw new CommandUsageError(`No account with email ${email}`);

  await accounts.setRole(account.id, role);
  const sessions = container.has(SessionManager) ? container.get(SessionManager) : undefined;
  const ended = sessions ? await sessions.destroyAllFor(account.id) : 0;
  ctx.print(`${account.email} is now ${role}${sessions ? `; ${ended} session(s) ended` : ""}`);
};

/** `hydrate auth:permissions`: which role grants what, and grants that match no known permission. */
export const permissionsCommand: CommandHandler = async (ctx) => {
  const roles = Object.entries(auth.policy.roles);
  const known: readonly string[] = PERMISSIONS;

  if (known.length === 0) {
    ctx.print("No permissions are declared in src/shared/permissions.ts yet.");
  } else {
    const width = Math.max("permission".length, ...known.map((name) => name.length));
    ctx.print(["permission".padEnd(width), ...roles.map(([role]) => role)].join("  "));
    for (const permission of known) {
      const cells = roles.map(([role, grants]) =>
        (grants.some((grant) => permissionMatches(grant, permission)) ? "x" : "-").padEnd(role.length),
      );
      ctx.print([permission.padEnd(width), ...cells].join("  ").trimEnd());
    }
  }

  for (const [role, grants] of roles) {
    for (const grant of grants) {
      if (grant !== "*" && !known.some((permission) => permissionMatches(grant, permission))) {
        ctx.print(`! ${role} grants "${grant}", which matches no permission in PERMISSIONS`);
      }
    }
  }
};
