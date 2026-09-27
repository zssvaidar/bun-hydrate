import { ForbiddenError, type Middleware } from "@bun-hydrate/core";
import { principal } from "./principal";

export interface CsrfOptions {
  /** Origins allowed besides the app's own, e.g. a separate admin frontend. */
  allowedOrigins?: readonly string[];
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originOf(url: string | null): string | undefined {
  if (!url || !URL.canParse(url)) return undefined;
  return new URL(url).origin;
}

/**
 * Header-based CSRF protection (spec-5 §2.3, OWASP "Fetch Metadata" / origin verification).
 * Only ambient credentials (cookies) are at risk, so bearer/API-key requests are exempt.
 * Run it after authenticate().
 */
export function csrf(options: CsrfOptions = {}): Middleware {
  const extra = new Set(options.allowedOrigins ?? []);

  return (ctx, next) => {
    if (SAFE_METHODS.has(ctx.method)) return next();

    const via = principal(ctx)?.via;
    if (via === "jwt" || via === "api-key") return next();

    const ownOrigin = `${ctx.protocol}://${ctx.headers.get("host") ?? ctx.url.host}`;
    const allowed = (origin: string | undefined) => origin !== undefined && (origin === ownOrigin || extra.has(origin));

    const fetchSite = ctx.headers.get("sec-fetch-site");
    const origin = ctx.headers.get("origin");
    const referer = ctx.headers.get("referer");

    let ok: boolean;
    if (fetchSite) ok = fetchSite === "same-origin" || allowed(originOf(origin));
    else if (origin) ok = allowed(originOf(origin));
    else if (referer) ok = allowed(originOf(referer));
    // No browser signals at all: fine for non-browser clients, unless they carry a cookie we can't vouch for.
    else ok = !ctx.headers.has("cookie");

    if (!ok) {
      ctx.log.warn("CSRF check failed", { method: ctx.method, path: ctx.path, origin, fetchSite });
      throw new ForbiddenError("Cross-site request refused", { code: "CSRF_REJECTED" });
    }
    return next();
  };
}
