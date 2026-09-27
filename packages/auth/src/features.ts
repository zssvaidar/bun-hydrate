import { ConfigError, EnvVar, defineConfig, env, parseDuration, type Duration, type EnvSource } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { token } from "@bun-hydrate/di";
import { DatabaseApiKeyStore, apiKeyStrategy, type ApiKeyStore } from "./api-keys";
import { defineAuthFeature, type AuthFeature } from "./compose";
import { csrf, type CsrfOptions } from "./csrf";
import { hmacKey, jwtStrategy, signJwt, type JwtKey } from "./jwt";
import { oidcStrategy, type OidcStrategyOptions } from "./oidc";
import type { UnresolvedPrincipal } from "./principal";
import { SessionManager } from "./sessions/manager";
import { DatabaseSessionStore, type SessionStore } from "./sessions/store";

/**
 * Runtime features shipped with the package (spec-5 §9.4). Features that depend on the app's own
 * tables (accounts, passwords, login routes) are generated into the app instead, so their code
 * can be changed there.
 */

/** Provided by the app's core feature: loads a principal by subject id; undefined ends the session. */
export const LoadPrincipal = token<(subjectId: string) => Promise<Omit<UnresolvedPrincipal, "via"> | undefined>>(
  "LoadPrincipal",
);

/** The API key store, for the key commands and admin screens. */
export const ApiKeys = token<ApiKeyStore>("ApiKeys");

/** A duration variable such as SESSION_IDLE_TIMEOUT=15m, in milliseconds. */
function duration(key: string): EnvVar<number> {
  return new EnvVar(key, (raw) => {
    try {
      return { ok: true, value: parseDuration(raw as Duration) };
    } catch {
      return { ok: false, expected: 'a duration such as "15m", "12h" or "7d"' };
    }
  });
}

interface EnvOption {
  /** Where settings not passed explicitly are read from. Default: process.env. */
  env?: EnvSource;
}

export interface SessionsFeatureOptions extends EnvOption {
  store?: SessionStore;
  cookie?: string;
  /** Default: SESSION_IDLE_TIMEOUT, else 30m. */
  idleTimeout?: Duration;
  /** Default: SESSION_ABSOLUTE_TIMEOUT, else 7d. */
  absoluteTimeout?: Duration;
  csrf?: CsrfOptions;
  now?: () => number;
}

/** Server-side sessions in the `sessions` table, plus csrf(), which cookie auth always needs. */
export function sessionsFeature(options: SessionsFeatureOptions = {}): AuthFeature {
  return defineAuthFeature({
    id: "auth:sessions",
    requires: ["auth:core"],
    register(container) {
      const settings = defineConfig(
        {
          idleTimeout: duration("SESSION_IDLE_TIMEOUT").default(parseDuration("30m")),
          absoluteTimeout: duration("SESSION_ABSOLUTE_TIMEOUT").default(parseDuration("7d")),
        },
        options.env,
      );
      container.factory(
        SessionManager,
        (resolver) =>
          new SessionManager({
            store: options.store ?? new DatabaseSessionStore(resolver.get(Database)),
            loadPrincipal: resolver.get(LoadPrincipal),
            cookie: options.cookie,
            idleTimeout: options.idleTimeout ?? settings.idleTimeout,
            absoluteTimeout: options.absoluteTimeout ?? settings.absoluteTimeout,
            now: options.now,
          }),
      );
    },
    strategies: (container) => [container.get(SessionManager).strategy()],
    middleware: () => [csrf(options.csrf)],
  });
}

export interface IssuedToken {
  token: string;
  tokenType: "Bearer";
  /** Seconds. */
  expiresIn: number;
}

/** Registered JWT claims and the ones that carry authority; callers cannot set these through `claims`. */
const RESERVED_CLAIMS = new Set(["iss", "sub", "aud", "exp", "nbf", "iat", "jti", "roles", "permissions", "scope"]);

/** Signs access tokens for the login routes when the app uses JWT instead of sessions. */
export class JwtIssuer {
  constructor(
    private readonly key: Promise<JwtKey>,
    private readonly options: { issuer?: string; audience?: string; ttlSeconds: number; now?: () => number },
  ) {}

  /** `claims` adds public claims such as the email; the registered ones (sub, iss, exp, …) always win. */
  async issue(subject: {
    id: string;
    roles: readonly string[];
    permissions?: readonly string[];
    claims?: Record<string, unknown>;
  }): Promise<IssuedToken> {
    const { issuer, audience, ttlSeconds, now } = this.options;
    const extra = Object.fromEntries(Object.entries(subject.claims ?? {}).filter(([name]) => !RESERVED_CLAIMS.has(name)));
    const claims = {
      ...extra,
      sub: subject.id,
      roles: [...subject.roles],
      ...(subject.permissions?.length ? { permissions: [...subject.permissions] } : {}),
      ...(issuer ? { iss: issuer } : {}),
      ...(audience ? { aud: audience } : {}),
    };
    const token = await signJwt(claims, await this.key, { expiresIn: ttlSeconds * 1000, now });
    return { token, tokenType: "Bearer", expiresIn: ttlSeconds };
  }
}

export interface JwtFeatureOptions extends EnvOption {
  /** Default: an HS256 key from JWT_SECRET (at least 32 characters). */
  key?: JwtKey;
  /** Default: JWT_ISSUER. */
  issuer?: string;
  /** Default: JWT_AUDIENCE. */
  audience?: string;
  /** Default: JWT_TTL, else 15m. */
  ttl?: Duration;
  now?: () => number;
}

const MIN_SECRET_LENGTH = 32;

/** Stateless bearer tokens signed by this app. */
export function jwtFeature(options: JwtFeatureOptions = {}): AuthFeature {
  let key: Promise<JwtKey> | undefined;
  let verify: { issuer?: string; audience?: string } = {};

  return defineAuthFeature({
    id: "auth:jwt",
    requires: ["auth:core"],
    register(container) {
      const settings = defineConfig(
        {
          secret: options.key ? env.string("JWT_SECRET").optional() : env.string("JWT_SECRET"),
          issuer: env.string("JWT_ISSUER").optional(),
          audience: env.string("JWT_AUDIENCE").optional(),
          ttl: duration("JWT_TTL").default(parseDuration("15m")),
        },
        options.env,
      );
      if (!options.key && settings.secret!.length < MIN_SECRET_LENGTH) {
        throw new ConfigError([{ key: "JWT_SECRET", problem: `expected at least ${MIN_SECRET_LENGTH} characters` }]);
      }
      key = options.key ? Promise.resolve(options.key) : hmacKey(settings.secret!);
      verify = { issuer: options.issuer ?? settings.issuer, audience: options.audience ?? settings.audience };
      const ttlSeconds = Math.floor(parseDuration(options.ttl ?? settings.ttl) / 1000);
      container.value(JwtIssuer, new JwtIssuer(key, { ...verify, ttlSeconds, now: options.now }));
    },
    strategies() {
      const ready = key!.then((resolved) => jwtStrategy({ keys: [resolved], ...verify, now: options.now }));
      return [{ name: "jwt", challenge: 'Bearer realm="api"', authenticate: async (ctx) => (await ready).authenticate(ctx) }];
    },
  });
}

export interface OidcFeatureOptions extends EnvOption, Partial<Omit<OidcStrategyOptions, "issuer" | "audience">> {
  /** Default: OIDC_ISSUER. */
  issuer?: string;
  /** Default: OIDC_AUDIENCE. */
  audience?: string;
}

/** Accepts bearer tokens from an external identity provider (resource server only, D1). */
export function oidcFeature(options: OidcFeatureOptions = {}): AuthFeature {
  let settings: { issuer: string; audience: string } | undefined;

  return defineAuthFeature({
    id: "auth:oidc",
    requires: ["auth:core"],
    register() {
      const fromEnv = defineConfig(
        {
          issuer: options.issuer ? env.url("OIDC_ISSUER").optional() : env.url("OIDC_ISSUER"),
          audience: options.audience ? env.string("OIDC_AUDIENCE").optional() : env.string("OIDC_AUDIENCE"),
        },
        options.env,
      );
      settings = { issuer: options.issuer ?? fromEnv.issuer!, audience: options.audience ?? fromEnv.audience! };
    },
    strategies: () => [oidcStrategy({ ...options, ...settings! })],
  });
}

export interface ApiKeysFeatureOptions {
  store?: ApiKeyStore;
}

/** Service-to-service keys from the `api_keys` table. */
export function apiKeysFeature(options: ApiKeysFeatureOptions = {}): AuthFeature {
  return defineAuthFeature({
    id: "auth:api-keys",
    requires: ["auth:core"],
    register(container) {
      container.factory(ApiKeys, (resolver) => options.store ?? new DatabaseApiKeyStore(resolver.get(Database)));
    },
    strategies: (container) => [apiKeyStrategy({ store: container.get(ApiKeys) })],
  });
}

/** `authConfig.features`: settings for each packaged feature, keyed like the feature factories. */
export interface PackagedFeatureOptions {
  sessions?: SessionsFeatureOptions;
  jwt?: JwtFeatureOptions;
  oidc?: OidcFeatureOptions;
  apiKeys?: ApiKeysFeatureOptions;
}
