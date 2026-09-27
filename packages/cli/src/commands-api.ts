import type { Database } from "@bun-hydrate/database";

/**
 * What an app's console command receives (spec-5 §9.6). Commands live in the app (e.g.
 * src/auth/commands.ts), so they use the app's own repositories and table layout.
 */
export interface CommandContext {
  /** Positional arguments after the command, e.g. ["create"] for `hydrate auth:api-key create`. */
  args: readonly string[];
  /** `--name value` and `--name=value` give strings; a bare `--flag` gives true. */
  options: Readonly<Record<string, string | true>>;
  /** Opened from DATABASE_URL by the CLI, and closed after the command. */
  db: Database;
  print(line: string): void;
  /**
   * Reads a secret without echoing it: from stdin with `--password-stdin`, otherwise at a hidden
   * prompt. Secrets are never accepted as arguments, which end up in shell history.
   */
  readSecret(prompt: string): Promise<string>;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

/** A mistake in how the command was called; printed without a stack trace. */
export class CommandUsageError extends Error {
  override name = "CommandUsageError";
}

export function requiredOption(ctx: CommandContext, name: string): string {
  const value = ctx.options[name];
  if (typeof value !== "string" || value === "") throw new CommandUsageError(`Missing --${name} <value>`);
  return value;
}

export function optionalOption(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.options[name];
  if (value === true) throw new CommandUsageError(`--${name} needs a value`);
  return value;
}
