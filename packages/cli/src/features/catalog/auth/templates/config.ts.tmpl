import { createPermissions, type AuthConfig, type Principal } from "@bun-hydrate/auth";
import type { Permission } from "../shared/permissions";

/**
 * Your auth settings. `hydrate` created this file once and never overwrites it: roles, what the
 * browser may see about the user, and options for the packaged features live here.
 */

/** What the browser learns about the signed-in user (sent in every server-rendered page). */
export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

/** Given to new accounts (registration and `hydrate auth:create-user` without --role). */
export const DEFAULT_ROLE = "member";

const permissions = createPermissions<Permission>();

export const authConfig: AuthConfig<AuthUser> = {
  // Role → granted permissions. "*" grants everything; "orders.*" grants every orders permission.
  policy: permissions.definePolicy({
    roles: {
      member: [],
      admin: ["*"],
    },
  }),

  user: (principal: Principal) => ({
    id: principal.id,
    email: typeof principal.claims?.email === "string" ? principal.claims.email : "",
    role: principal.roles[0] ?? "",
  }),

  // Options for the packaged features, e.g. sessions: { idleTimeout: "1h" }. Settings not given
  // here come from the environment (SESSION_IDLE_TIMEOUT, JWT_SECRET, OIDC_ISSUER, …).
  features: {},
};
