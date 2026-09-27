import type { Context, Middleware } from "@bun-hydrate/core";
import type { Container, Scope } from "./container";

const scopes = new WeakMap<Context<unknown>, Scope>();

/** Creates a DI scope per request and disposes it once the response is produced. */
export function requestScope(container: Container): Middleware {
  return async (ctx, next) => {
    const scope = container.createScope();
    scopes.set(ctx, scope);
    try {
      return await next();
    } finally {
      await scope.dispose();
    }
  };
}

export function scopeOf(ctx: Context<unknown>): Scope {
  const scope = scopes.get(ctx);
  if (!scope) throw new Error("No request scope: add app.use(requestScope(container)) before this route");
  return scope;
}
