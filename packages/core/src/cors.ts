import type { Middleware } from "./middleware";
import { appendHeader, withHeader } from "./response";

export interface CorsOptions {
  /** Allowed origins: a list, a predicate, or "*" for a public, credential-less API. */
  origin: readonly string[] | ((origin: string) => boolean) | "*";
  credentials?: boolean;
  methods?: readonly string[];
  /** Default: whatever the preflight asks for. */
  allowHeaders?: readonly string[];
  exposeHeaders?: readonly string[];
  /** Seconds the browser may cache a preflight result. */
  maxAge?: number;
}

const DEFAULT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"];

function originMatcher(origin: CorsOptions["origin"]): (candidate: string) => boolean {
  if (origin === "*") return () => true;
  if (typeof origin === "function") return origin;
  const allowed = new Set(origin);
  return (candidate) => allowed.has(candidate);
}

/** Cross-origin resource sharing with an explicit allow-list (spec-5 §2.2). */
export function cors(options: CorsOptions): Middleware {
  if (options.origin === "*" && options.credentials) {
    throw new Error('cors(): origin "*" cannot be combined with credentials: true; list the allowed origins instead');
  }
  const isAllowed = originMatcher(options.origin);
  const allowOriginValue = (origin: string) => (options.origin === "*" ? "*" : origin);

  return async (ctx, next) => {
    const origin = ctx.headers.get("origin");
    const isPreflight = ctx.method === "OPTIONS" && origin !== null && ctx.headers.has("access-control-request-method");

    if (isPreflight) {
      const headers = new Headers({ vary: "Origin, Access-Control-Request-Headers" });
      if (isAllowed(origin)) {
        headers.set("access-control-allow-origin", allowOriginValue(origin));
        headers.set("access-control-allow-methods", (options.methods ?? DEFAULT_METHODS).join(", "));
        const requested = ctx.headers.get("access-control-request-headers");
        const allowHeaders = options.allowHeaders?.join(", ") ?? requested;
        if (allowHeaders) headers.set("access-control-allow-headers", allowHeaders);
        if (options.credentials) headers.set("access-control-allow-credentials", "true");
        if (options.maxAge !== undefined) headers.set("access-control-max-age", String(options.maxAge));
      }
      return new Response(null, { status: 204, headers });
    }

    let response = await next();
    if (origin === null) return response;

    if (options.origin !== "*") response = appendHeader(response, "vary", "Origin");
    if (!isAllowed(origin)) return response;

    response = withHeader(response, "access-control-allow-origin", allowOriginValue(origin));
    if (options.credentials) response = withHeader(response, "access-control-allow-credentials", "true");
    if (options.exposeHeaders?.length) {
      response = withHeader(response, "access-control-expose-headers", options.exposeHeaders.join(", "));
    }
    return response;
  };
}
