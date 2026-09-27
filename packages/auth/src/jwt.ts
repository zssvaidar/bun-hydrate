import { UnauthorizedError, parseDuration, type Duration } from "@bun-hydrate/core";
import type { Strategy } from "./authenticate";
import type { UnresolvedPrincipal } from "./principal";

export type JwtAlgorithm = "HS256" | "ES256" | "RS256";

/** A key bound to exactly one algorithm (spec-5 §3.4): a token's `alg` must match it. */
export interface JwtKey {
  alg: JwtAlgorithm;
  key: CryptoKey;
  kid?: string;
}

export type JwtClaims = Record<string, unknown> & {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
};

export class JwtError extends UnauthorizedError {
  constructor(message: string) {
    super(message, { code: "INVALID_TOKEN" });
  }
}

const WEBCRYPTO: Record<JwtAlgorithm, { name: string; sign: AlgorithmIdentifier | EcdsaParams }> = {
  HS256: { name: "HMAC", sign: "HMAC" },
  ES256: { name: "ECDSA", sign: { name: "ECDSA", hash: "SHA-256" } },
  RS256: { name: "RSASSA-PKCS1-v1_5", sign: "RSASSA-PKCS1-v1_5" },
};

const encoder = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString("base64url");
const b64json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function hmacKey(secret: string | Uint8Array, kid?: string): Promise<JwtKey> {
  const bytes = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret);
  if (bytes.length < 32) throw new Error("HS256 secrets must be at least 32 bytes");
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return { alg: "HS256", key, kid };
}

export async function generateJwtKeyPair(
  alg: "ES256" | "RS256",
  kid?: string,
): Promise<{ privateKey: JwtKey; publicKey: JwtKey }> {
  const params =
    alg === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  return { privateKey: { alg, key: pair.privateKey, kid }, publicKey: { alg, key: pair.publicKey, kid } };
}

/** Imports a public JWK (e.g. from an OIDC provider's JWKS). */
export async function importJwk(jwk: JsonWebKey & { kid?: string; alg?: string }): Promise<JwtKey> {
  const alg = (jwk.alg ?? (jwk.kty === "EC" ? "ES256" : jwk.kty === "RSA" ? "RS256" : undefined)) as JwtAlgorithm | undefined;
  if (alg !== "ES256" && alg !== "RS256") throw new Error(`Unsupported JWK (kty=${jwk.kty}, alg=${jwk.alg})`);
  const params = alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const { kid, alg: _alg, ...material } = jwk;
  const key = await crypto.subtle.importKey("jwk", material, params, false, ["verify"]);
  return { alg, key, kid };
}

export interface SignOptions {
  expiresIn?: Duration;
  now?: () => number;
}

export async function signJwt(claims: JwtClaims, key: JwtKey, options: SignOptions = {}): Promise<string> {
  const iat = Math.floor((options.now ?? Date.now)() / 1000);
  const payload: JwtClaims = { iat, ...claims };
  if (options.expiresIn !== undefined) payload.exp = iat + Math.floor(parseDuration(options.expiresIn) / 1000);

  const header = { alg: key.alg, typ: "JWT", ...(key.kid ? { kid: key.kid } : {}) };
  const input = `${b64json(header)}.${b64json(payload)}`;
  const signature = await crypto.subtle.sign(WEBCRYPTO[key.alg].sign, key.key, encoder.encode(input));
  return `${input}.${b64url(signature)}`;
}

export interface VerifyOptions {
  issuer?: string;
  audience?: string;
  /** Tolerance for exp/nbf/iat. Default: 30s. */
  clockSkew?: Duration;
  /** Reject tokens without `exp`. Default: true. */
  requireExpiry?: boolean;
  now?: () => number;
}

export async function verifyJwt(token: string, keys: readonly JwtKey[], options: VerifyOptions = {}): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("Malformed token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = decodeJson(encodedHeader) as { alg?: string; kid?: string };
  const claims = decodeJson(encodedPayload) as JwtClaims;
  const key = selectKey(keys, header);

  const valid = await crypto.subtle.verify(
    WEBCRYPTO[key.alg].sign,
    key.key,
    Buffer.from(encodedSignature, "base64url"),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new JwtError("Invalid signature");

  checkClaims(claims, options);
  return claims;
}

function decodeJson(part: string): unknown {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    return value;
  } catch {
    throw new JwtError("Malformed token");
  }
}

function selectKey(keys: readonly JwtKey[], header: { alg?: string; kid?: string }): JwtKey {
  if (!header.alg || !(header.alg in WEBCRYPTO)) throw new JwtError(`Unsupported algorithm ${header.alg ?? "(none)"}`);
  // Only keys bound to the header's algorithm are candidates, and the CryptoKey must really be of
  // that kind — an RSA public key can never be used as an HMAC secret (algorithm confusion).
  const candidates = keys.filter((k) => k.alg === header.alg && k.key.algorithm.name === WEBCRYPTO[k.alg].name);
  if (candidates.length === 0) throw new JwtError(`No key for algorithm ${header.alg}`);
  if (header.kid === undefined) return candidates[0]!;
  const byId = candidates.find((k) => k.kid === header.kid) ?? candidates.find((k) => k.kid === undefined);
  if (!byId) throw new JwtError(`Unknown key id ${header.kid}`);
  return byId;
}

function checkClaims(claims: JwtClaims, options: VerifyOptions): void {
  const now = (options.now ?? Date.now)() / 1000;
  const skew = parseDuration(options.clockSkew ?? "30s") / 1000;

  if (claims.exp === undefined) {
    if (options.requireExpiry ?? true) throw new JwtError("Token has no expiry");
  } else if (typeof claims.exp !== "number" || now > claims.exp + skew) {
    throw new JwtError("Token expired");
  }
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || now + skew < claims.nbf)) {
    throw new JwtError("Token not yet valid");
  }
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat > now + skew)) {
    throw new JwtError("Token issued in the future");
  }
  if (options.issuer !== undefined && claims.iss !== options.issuer) throw new JwtError("Wrong issuer");
  if (options.audience !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(options.audience)) throw new JwtError("Wrong audience");
  }
}

/** Default claim mapping: `sub` → id, `roles` → roles, `scope` and `permissions` → direct grants. */
export function claimsToPrincipal(claims: JwtClaims): UnresolvedPrincipal {
  if (typeof claims.sub !== "string" || claims.sub === "") throw new JwtError("Token has no subject");
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
  return {
    id: claims.sub,
    kind: "user",
    roles: strings(claims.roles),
    permissions: [...scopes, ...strings(claims.permissions)],
    via: "jwt",
    claims,
  };
}

/** Extracts a bearer token that is not an API key. */
export function bearerToken(authorization: string | null): string | undefined {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  return token && !token.startsWith("hk_") ? token : undefined;
}

export interface JwtStrategyOptions extends Omit<VerifyOptions, "now"> {
  keys: readonly JwtKey[];
  toPrincipal?: (claims: JwtClaims) => UnresolvedPrincipal | Promise<UnresolvedPrincipal>;
  now?: () => number;
}

export function jwtStrategy(options: JwtStrategyOptions): Strategy {
  const toPrincipal = options.toPrincipal ?? claimsToPrincipal;
  return {
    name: "jwt",
    challenge: 'Bearer realm="api"',
    async authenticate(ctx) {
      const token = bearerToken(ctx.headers.get("authorization"));
      if (!token) return undefined;
      try {
        return await toPrincipal(await verifyJwt(token, options.keys, options));
      } catch (error) {
        throw invalidToken(error);
      }
    },
  };
}

/** RFC 6750: an invalid token gets `error="invalid_token"` in its challenge. */
export function invalidToken(error: unknown): UnauthorizedError {
  const message = error instanceof JwtError ? error.message : "Invalid token";
  return new UnauthorizedError(message, {
    code: "INVALID_TOKEN",
    headers: { "www-authenticate": 'Bearer realm="api", error="invalid_token"' },
    cause: error,
  });
}
