import { UnauthorizedError, type Context } from "@bun-hydrate/core";

export interface Principal {
  id: string;
  kind: "user" | "service";
  roles: readonly string[];
  /** Resolved from roles plus direct grants, once, in authenticate(). */
  permissions: readonly string[];
  via: "session" | "jwt" | "api-key";
  /** Token claims (JWT/OIDC). Never sent to the browser as-is. */
  claims?: Record<string, unknown>;
}

/** What a strategy returns: the principal before role → permission resolution. */
export type UnresolvedPrincipal = Omit<Principal, "permissions"> & { permissions?: readonly string[] };

interface AuthState {
  principal: Principal | undefined;
  challenges: readonly string[];
}

const states = new WeakMap<Context<unknown>, AuthState>();

/** @internal Set by authenticate(). */
export function setAuthState(ctx: Context<unknown>, state: AuthState): void {
  states.set(ctx, state);
}

/** @internal */
export function authStateOf(ctx: Context<unknown>, caller: string): AuthState {
  const state = states.get(ctx);
  if (!state) throw new Error(`${caller} needs app.use(authenticate(...)) to run first`);
  return state;
}

/** The signed-in principal, or undefined for anonymous requests. */
export function principal(ctx: Context<unknown>): Principal | undefined {
  return states.get(ctx)?.principal;
}

/** The signed-in principal, or a 401. */
export function requirePrincipal(ctx: Context<unknown>): Principal {
  const state = authStateOf(ctx, "requirePrincipal()");
  if (!state.principal) throw unauthenticated(state.challenges);
  return state.principal;
}

export function unauthenticated(challenges: readonly string[]): UnauthorizedError {
  return new UnauthorizedError("Authentication required", {
    code: "UNAUTHENTICATED",
    headers: challenges.length > 0 ? { "www-authenticate": challenges.join(", ") } : undefined,
  });
}
