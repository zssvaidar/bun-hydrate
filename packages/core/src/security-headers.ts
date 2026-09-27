import type { Middleware } from "./middleware";
import { withHeader } from "./response";

/** Header name → value, or `false` to leave the header out. */
export type SecurityHeadersOptions = Record<string, string | false>;

/**
 * Checked against our own SSR output (spec-5 §2.1): the hydration payload is a JSON data block,
 * which script-src does not govern, and the client bundle is a same-origin module script.
 */
export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const DEFAULTS: Record<string, string> = {
  "content-security-policy": DEFAULT_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

const HSTS = "strict-transport-security";

/** Adds baseline security headers without overriding values a route set itself. */
export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  const headers: [string, string | false][] = Object.entries({
    ...DEFAULTS,
    [HSTS]: "max-age=31536000; includeSubDomains",
    ...lowerKeys(options),
  });

  return async (ctx, next) => {
    let response = await next();
    for (const [name, value] of headers) {
      if (value === false || response.headers.has(name)) continue;
      // HSTS over plain HTTP is ignored by browsers and would be wrong behind a TLS-less proxy.
      if (name === HSTS && ctx.protocol !== "https") continue;
      response = withHeader(response, name, value);
    }
    return response;
  };
}

function lowerKeys(options: SecurityHeadersOptions): SecurityHeadersOptions {
  return Object.fromEntries(Object.entries(options).map(([name, value]) => [name.toLowerCase(), value]));
}
