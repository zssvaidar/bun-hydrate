import type { Context } from "@bun-hydrate/core";
import { principal, type Principal } from "./principal";

/** What the browser learns about the signed-in user (spec-5 §8.1). */
export interface AuthSnapshot<User = Record<string, unknown>> {
  user: User | null;
  permissions: string[];
}

export interface SnapshotOptions<User> {
  /**
   * Picks the fields the browser may see. Only what this returns is serialized into the page,
   * so password hashes, raw token claims and session IDs cannot leak by accident.
   */
  user: (principal: Principal) => User;
}

export function authSnapshot<User>(ctx: Context<any>, options: SnapshotOptions<User>): AuthSnapshot<User> {
  const current = principal(ctx);
  return current
    ? { user: options.user(current), permissions: [...current.permissions] }
    : { user: null, permissions: [] };
}
