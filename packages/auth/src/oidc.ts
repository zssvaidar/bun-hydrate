import { HttpError, parseDuration, type Duration } from "@bun-hydrate/core";
import type { Strategy } from "./authenticate";
import { bearerToken, claimsToPrincipal, importJwk, invalidToken, verifyJwt, type JwtClaims, type JwtKey } from "./jwt";
import type { UnresolvedPrincipal } from "./principal";

export interface OidcStrategyOptions {
  /** The provider's issuer URL, e.g. https://tenant.auth0.com (no trailing slash). */
  issuer: string;
  audience: string;
  toPrincipal?: (claims: JwtClaims) => UnresolvedPrincipal | Promise<UnresolvedPrincipal>;
  /** Minimum time between JWKS refreshes triggered by unknown key IDs. Default: 1m. */
  refreshInterval?: Duration;
  fetch?: typeof fetch;
  now?: () => number;
}

class IdentityProviderUnavailable extends HttpError {
  constructor(cause: unknown) {
    super(503, "Identity provider unavailable", { code: "IDP_UNAVAILABLE", cause });
  }
}

function keyIdOf(token: string): string | undefined {
  try {
    const header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validates bearer tokens issued by an external OIDC provider (spec-5 §3.5): discovery once,
 * JWKS cached by key ID, and one refresh per interval for unknown key IDs (rotation), so junk
 * tokens cannot turn us into a load generator against the provider.
 */
export function oidcStrategy(options: OidcStrategyOptions): Strategy {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const refreshMs = parseDuration(options.refreshInterval ?? "1m");
  const toPrincipal = options.toPrincipal ?? claimsToPrincipal;

  let jwksUri: Promise<string> | undefined;
  let keys: JwtKey[] = [];
  let lastRefresh = Number.NEGATIVE_INFINITY;

  const discover = () => {
    jwksUri ??= (async () => {
      const response = await doFetch(`${options.issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`Discovery failed with HTTP ${response.status}`);
      const document = (await response.json()) as { issuer?: string; jwks_uri?: string };
      if (document.issuer !== options.issuer) {
        throw new Error(`Discovery document is for issuer ${document.issuer}, expected ${options.issuer}`);
      }
      if (!document.jwks_uri) throw new Error("Discovery document has no jwks_uri");
      return document.jwks_uri;
    })().catch((error) => {
      jwksUri = undefined; // retry discovery on a later request
      throw error;
    });
    return jwksUri;
  };

  const refreshKeys = async () => {
    lastRefresh = now();
    const response = await doFetch(await discover());
    if (!response.ok) throw new Error(`JWKS fetch failed with HTTP ${response.status}`);
    const { keys: jwks = [] } = (await response.json()) as { keys?: (JsonWebKey & { kid?: string; use?: string })[] };
    const usable = jwks.filter((jwk) => jwk.use === undefined || jwk.use === "sig");
    const imported = await Promise.allSettled(usable.map((jwk) => importJwk(jwk)));
    keys = imported.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  };

  return {
    name: "oidc",
    challenge: 'Bearer realm="api"',
    async authenticate(ctx) {
      const token = bearerToken(ctx.headers.get("authorization"));
      if (!token) return undefined;

      const kid = keyIdOf(token);
      const unknownKey = keys.length === 0 || (kid !== undefined && !keys.some((key) => key.kid === kid));
      if (unknownKey && now() - lastRefresh >= refreshMs) {
        try {
          await refreshKeys();
        } catch (error) {
          ctx.log.error("OIDC provider unavailable", { issuer: options.issuer, error });
          throw new IdentityProviderUnavailable(error);
        }
      }

      try {
        const claims = await verifyJwt(token, keys, { issuer: options.issuer, audience: options.audience, now });
        return await toPrincipal(claims);
      } catch (error) {
        throw invalidToken(error);
      }
    },
  };
}
