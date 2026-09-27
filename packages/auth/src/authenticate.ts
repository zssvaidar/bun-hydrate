import { ForbiddenError, HttpError, type Context, type Middleware } from "@bun-hydrate/core";
import { can, type Policy } from "./permissions";
import { authStateOf, setAuthState, unauthenticated, type Principal, type UnresolvedPrincipal } from "./principal";

export interface Strategy {
  name: string;
  /** Sent in WWW-Authenticate on 401s, e.g. `Bearer realm="api"`. */
  challenge?: string;
  /**
   * `undefined` when this kind of credential is absent. Throw (e.g. UnauthorizedError) when it is
   * present but invalid: an expired token must never silently become an anonymous request.
   */
  authenticate(ctx: Context<any>): Promise<UnresolvedPrincipal | undefined>;
}

export interface AuthenticateOptions {
  strategies: readonly Strategy[];
  /** Resolves roles to permissions once per request. */
  policy?: Policy;
}

/** Identifies the caller with the first strategy that recognises a credential (spec-5 §3.1). */
export function authenticate({ strategies, policy }: AuthenticateOptions): Middleware {
  const challenges = strategies.flatMap((strategy) => (strategy.challenge ? [strategy.challenge] : []));

  return async (ctx, next) => {
    let found: UnresolvedPrincipal | undefined;
    try {
      for (const strategy of strategies) {
        found = await strategy.authenticate(ctx);
        if (found) break;
      }
    } catch (error) {
      throw withChallenges(error, challenges);
    }

    const principal: Principal | undefined = found && {
      ...found,
      permissions: [...new Set([...(found.permissions ?? []), ...(policy?.permissionsFor(found.roles) ?? [])])],
    };
    setAuthState(ctx, { principal, challenges });
    return next();
  };
}

function withChallenges(error: unknown, challenges: readonly string[]): unknown {
  if (!(error instanceof HttpError) || error.status !== 401 || challenges.length === 0) return error;
  const headers = new Headers(error.headers);
  if (!headers.has("www-authenticate")) headers.set("www-authenticate", challenges.join(", "));
  return new HttpError(401, error.message, { code: error.code, details: error.details, cause: error, headers });
}

export function requireAuth(): Middleware {
  return (ctx, next) => {
    const state = authStateOf(ctx, "requireAuth()");
    if (!state.principal) throw unauthenticated(state.challenges);
    return next();
  };
}

/** 401 when anonymous, 403 unless the principal holds every listed permission. */
export function requirePermission(...required: string[]): Middleware {
  return (ctx, next) => {
    const state = authStateOf(ctx, "requirePermission()");
    if (!state.principal) throw unauthenticated(state.challenges);
    if (!can(state.principal, ...required)) {
      // The client learns only "forbidden"; which permission was missing goes to the log.
      ctx.log.info("Permission denied", { principalId: state.principal.id, required });
      throw new ForbiddenError();
    }
    return next();
  };
}

/** 401 when anonymous, 403 unless the principal has at least one of the roles. */
export function requireRole(...roles: string[]): Middleware {
  return (ctx, next) => {
    const state = authStateOf(ctx, "requireRole()");
    if (!state.principal) throw unauthenticated(state.challenges);
    if (!roles.some((role) => state.principal!.roles.includes(role))) {
      ctx.log.info("Role denied", { principalId: state.principal.id, required: roles });
      throw new ForbiddenError();
    }
    return next();
  };
}
