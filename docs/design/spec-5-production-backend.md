# bun-hydrate Spec 5 — Production Backend Detailed Design (v0.3)

**Document:** `spec-5`
**Status:** Implemented (v0.3). Decisions D1–D10 were taken as recommended; the deviations are recorded in §16 "As built"
**Builds on:** `spec-1` §28 (v0.3: authentication, authorization, logging, request IDs, metrics, rate limiting, caching, WebSockets), `spec-2` §2.2/§2.4 (security baseline FR-220–227, tracing FR-242, WebSocket fan-out FR-241, shutdown scope FR-243), `spec-3` (kernel), `spec-4` (validation, DI, database)
**Out of scope:** `Jenkinsfile` and `deploy.sh` (unchanged); queues, jobs, events and multi-instance WebSocket fan-out (v0.4)

---

## 0. Summary

| Area | Outcome | Where |
|---|---|---|
| Kernel additions | client IP behind trusted proxies, cookies, matched route pattern, `traceparent`, WebSocket routes, 429 error | `@bun-hydrate/core` |
| Security baseline | security headers, CORS, CSRF, secrets from files | `core` (+ `auth` for CSRF) |
| Authentication | passwords (argon2id), server-side sessions, JWT bearer tokens, OIDC resource server, API keys | `@bun-hydrate/auth` (new) |
| Authorization | roles → permissions, wildcard permissions, resource-level policies | `@bun-hydrate/auth` |
| Caching | `Cache` interface, memory (LRU + TTL) and Redis, `remember()` with stampede protection | `@bun-hydrate/cache` (new) |
| Rate limiting | sliding-window limiter, memory and Redis stores, standard headers | `@bun-hydrate/rate-limit` (new) |
| Metrics | Prometheus registry, HTTP/process/cache/rate-limit metrics, `/metrics` | `@bun-hydrate/observability` (new) |
| Logging, request IDs | already done in v0.1; v0.3 adds `route` and `traceId` to log lines | `core` |
| React auth | `AuthProvider` seeded from SSR, `useAuth`, `useCan`, `<Can>`, typed permissions shared with the server | `@bun-hydrate/react/auth` |
| Feature orchestration | `hydrate add` / `remove` for auth features (sessions, JWT, OIDC, API keys, login, React, UI pages) with dependency resolution, plans, safe removal and a runtime composition root; `hydrate auth:*` console commands | `@bun-hydrate/cli`, `@bun-hydrate/auth` |
| Reference app | register/login/logout/me, protected users API, login brute-force limits, `/metrics`, a WebSocket room | `src/` |

Every capability is verified to exist in Bun 1.3.11 (probed while writing this spec). That covers `Bun.password` (argon2id), `Bun.CookieMap`, `Bun.RedisClient` (GET/SET/INCR/EXPIRE/EVAL/pub-sub), `server.requestIP()`, `server.upgrade()` with topics, WebCrypto ECDSA/RSA/HMAC, and `perf_hooks.monitorEventLoopDelay`. So no new third-party runtime dependency is needed.

---

## 1. Kernel changes (`@bun-hydrate/core`)

These are the only changes to the stable kernel. Each is additive: no existing API changes meaning, and all 279 existing tests must keep passing unmodified.

### 1.1 Client IP, protocol and trusted proxies (spec-2 FR-226)

Rate limiting, audit logs and HSTS all need the real client address, but the app normally runs behind a load balancer or tunnel. Trusting `X-Forwarded-For` blindly lets any client spoof its IP and bypass rate limits. So trust is explicit, and off by default.

```ts
new App({ trustProxy: false });            // default: ctx.ip = socket address
new App({ trustProxy: 1 });                // one proxy hop (e.g. a single load balancer)
new App({ trustProxy: ["10.0.0.0/8", "127.0.0.1"] });  // trust these proxy addresses
```

- `App.fetch(request, server?)` receives Bun's server. `ctx.ip` starts from `server.requestIP(request)`, then walks `X-Forwarded-For` right to left, skipping only trusted hops.
- `ctx.protocol` is `"https"` or `"http"`, taken from `X-Forwarded-Proto` only when the immediate peer is trusted.
- In-process tests have no socket, so `ctx.ip` falls back to `"127.0.0.1"`. The test client can set it with `.ip("203.0.113.9")`.

### 1.2 Matched route pattern

`ctx.route` is the pattern that matched (for example `"/api/v1/users/:id"`), or `undefined` for 404s. Metrics must label by pattern, never by raw path: raw paths contain IDs, which would create unbounded label cardinality. The request log line gains a `route` field.

### 1.3 Cookies

```ts
ctx.cookies.get("sid");
ctx.cookies.set("sid", value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3600 });
ctx.cookies.delete("sid");
```

- The jar is backed by `Bun.CookieMap`, parsed lazily from the request.
- Changes are appended as `Set-Cookie` headers to the **final** response at dispatch, the same place `x-request-id` is added. So they apply even when a handler returns its own `Response` or an error response is produced.
- Defaults applied to every `set`: `path=/`, `httpOnly`, `sameSite=lax`, and `secure` when `ctx.protocol` is `https` (FR-223).

### 1.4 Trace context (spec-2 FR-242, propagation part)

- An incoming W3C `traceparent` is parsed and validated. Otherwise a new trace ID is generated.
- `ctx.traceId` and `ctx.spanId` are exposed, and `traceId` is bound into `ctx.log` next to `requestId`.
- `propagationHeaders(ctx)` returns `{ traceparent, "x-request-id" }` for outgoing `fetch` calls, so one trace follows a request across services.
- **Not included:** exporting spans to an OpenTelemetry collector. That needs the OTel SDK, which conflicts with the no-dependency core, and belongs in an optional adapter package later. v0.3 gives correlation (the same IDs in every log line and downstream call), which is most of the debugging value.

### 1.5 WebSocket routes (FR-110, spec-2 FR-243)

```ts
app.websocket("/ws/rooms/:room", {
  // Runs after global middleware (auth, rate limits, CORS), like any GET route.
  upgrade(ctx) {
    const user = requireUser(ctx);           // throw → normal HTTP error response, no upgrade
    return { user, room: ctx.params.room };  // becomes ws.data (typed)
  },
  open(ws) { ws.subscribe(`room:${ws.data.room}`); },
  message(ws, message) { ws.publish(`room:${ws.data.room}`, message); },
  close(ws, code, reason) {},
});
app.publish("room:lobby", "server says hi");  // publish from anywhere, e.g. an HTTP handler
```

- **Routing:** `app.websocket(path, handlers)` registers a GET route whose terminal step calls `server.upgrade()`. The upgrade request therefore goes through the full middleware stack and error format.
- **Handler dispatch:** Bun has one global `websocket` handler per server. The App installs it and dispatches to the right route's handlers through `ws.data`.
- **Cross-site WebSocket hijacking:** browsers send cookies on cross-site WebSocket upgrades, and CORS does not apply to them. So the `Origin` header is checked against `allowedOrigins`, which defaults to same-origin. A mismatch returns 403 before upgrading.
- **Limits:** `maxPayloadLength` (default 64 KiB), `idleTimeout` (default 120 s) and `backpressureLimit` are set per app, with safe defaults.
- **Shutdown (FR-243):** on `stop()`, new upgrades are refused with 503, and open sockets are closed with code `1001` ("going away") before the HTTP drain.
- **Scope:** pub/sub is **process-local** in v0.3, because Bun topics live in one process. Multi-instance fan-out through Redis pub/sub is v0.4 (spec-2 FR-241). The docs will say this explicitly.

### 1.6 Other kernel additions

- `TooManyRequestsError` (429), with an optional `retryAfter` that sets `Retry-After`.
- **Secrets from files (FR-227):** `defineConfig` also honours the `<NAME>_FILE` convention. If `DATABASE_URL_FILE=/run/secrets/db` is set, the value is read from that file, which is how Docker and Kubernetes secrets are mounted. Setting both `NAME` and `NAME_FILE` is a config error. Vault/SSM adapters stay out of scope.

---

## 2. Security baseline middleware (spec-2 FR-220–222)

### 2.1 `securityHeaders()` — core

Enabled by default in `new App()` (`securityHeaders: false` opts out), because a secure default beats a forgotten opt-in.

| Header | Default |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, **only** when `ctx.protocol === "https"` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` (for browsers without `frame-ancestors`) |
| `Cross-Origin-Opener-Policy` | `same-origin` |

The default CSP was checked against our own SSR output. The hydration payload is `<script type="application/json">`, a data block that `script-src` doesn't govern. The client bundle is a same-origin module script. So hydration works under `script-src 'self'` with no inline-script hash or nonce. The browser e2e test gains an assertion that no CSP violation is reported. `connect-src 'self'` must be widened by apps that call other origins, and the option is documented.

### 2.2 `cors()` — core

```ts
app.use(cors({ origin: ["https://app.example.com"], credentials: true, maxAge: 600 }));
```

- `origin` is a list or a predicate `(origin) => boolean`. `origin: "*"` together with `credentials: true` throws at construction: browsers reject it anyway, and it is a common misconfiguration.
- It answers preflight requests (`OPTIONS` with `Access-Control-Request-Method`) itself, before routing. On other responses it sets `Access-Control-Allow-Origin` to the request origin (never a reflected wildcard) and adds `Vary: Origin`.
- Disallowed origins get no CORS headers (the browser blocks the response). The request isn't failed server-side, because non-browser clients legitimately send no `Origin`.

### 2.3 `csrf()` — auth package

CSRF only matters for **ambient** credentials, i.e. cookies. Bearer tokens and API keys are exempt, because a cross-site form can't attach them.

- Applies to unsafe methods (POST/PUT/PATCH/DELETE) on requests authenticated by a session cookie.
- The request passes if `Sec-Fetch-Site` is `same-origin`, or `Origin` is in the allowed list, which defaults to the app's own origin. Failing that, `Referer` is checked the same way. Anything else gets `403 CSRF_REJECTED`.
- This is the header-based defense OWASP recommends. It needs no token plumbing through forms and SSR, and combined with `SameSite=Lax` cookies it covers all current browsers. A synchronizer-token mode is **not** included; it can be added if an app must support very old browsers.

---

## 3. Authentication (`@bun-hydrate/auth`, FR-070/071)

### 3.1 The principal and how routes use it

```ts
interface Principal {
  id: string;
  kind: "user" | "service";
  roles: readonly string[];
  permissions: readonly string[];   // resolved from roles + direct grants
  via: "session" | "jwt" | "api-key";
  claims?: Record<string, unknown>; // JWT/OIDC claims
}

app.use(authenticate(sessionStrategy, jwtStrategy, apiKeyStrategy));  // tries each in order

router.get("/me", requireAuth(), (ctx) => principal(ctx));            // 401 if anonymous
router.delete("/:id", requirePermission("users.delete"), handler);    // 403 if lacking
```

- **Anonymous is not an error.** `authenticate()` never rejects anonymous requests, so public routes stay public. It rejects only **invalid** credentials: an expired token or a forged cookie gets `401`, never a silent downgrade to anonymous. This avoids confusing half-authenticated states.
- **Reading the principal:** `principal(ctx)` returns the `Principal` or `undefined`, and `requirePrincipal(ctx)` throws 401. This is the same accessor pattern as `scopeOf(ctx)`, so there is no core change and no untyped `ctx.state` lookup.
- **401 responses** include `WWW-Authenticate` (`Bearer realm="api"` when bearer is enabled).

### 3.2 Passwords

- `hashPassword(plain)` and `verifyPassword(plain, hash)` wrap `Bun.password`. The algorithm is argon2id, with Bun's current parameters `m=65536, t=2, p=1`.
- `needsRehash(hash)` compares the parameters in the stored hash with the current ones, so the app can upgrade a hash transparently on the next successful login.
- `verifyPassword` against a **missing** user still performs a hash with a dummy value. This equalizes response time, so login timing doesn't reveal which emails exist.
- No API accepts or stores a reversible password (FR-224).

### 3.3 Sessions (server-side, opaque)

A cookie carries a random 256-bit session ID. The store keeps only its **SHA-256 hash**, so a leaked sessions table cannot be replayed as live sessions.

```ts
const sessions = new SessionManager({
  store: new DatabaseSessionStore(db),   // or CacheSessionStore(cache) for memory/Redis
  cookie: "sid",
  idleTimeout: "30m",                    // sliding: extended on use (at most once a minute)
  absoluteTimeout: "7d",                 // hard cap, regardless of activity
});

await sessions.create(ctx, principalId);   // after login; always issues a NEW id (no fixation)
await sessions.destroy(ctx);               // logout
await sessions.destroyAllFor(userId);      // "sign out everywhere", password change
```

- **Stores:**
  - `DatabaseSessionStore` is the default for apps with a database. It uses a `sessions` table from a migration shipped with the package and added by the `auth:sessions` feature (§9). It supports `destroyAllFor`.
  - `CacheSessionStore` runs on any `Cache` (memory for dev/tests, Redis in production). It has no `destroyAllFor`, because a cache can't be enumerated by user, and this is documented.
- **Session fixation:** the ID is rotated on login and privilege change.
- **Cookie flags** come from §1.3, with `Max-Age` equal to the absolute timeout.

### 3.4 JWT bearer tokens

A small in-house implementation on WebCrypto. JWT libraries are a known source of algorithm-confusion bugs, and the required surface is small.

- **Algorithms:** HS256, ES256 and RS256 (sign and verify). **Each key is bound to exactly one algorithm**, and a token's `alg` header must match it. This blocks algorithm-confusion attacks (e.g. `RS256`→`HS256` with the public key as HMAC secret). `none` is always rejected.
- **Validated claims:** `exp`, `nbf` and `iat`, with configurable clock skew (default 30 s); `iss` and `aud` when configured. `sub` becomes `Principal.id`.
- **API:** `signJwt(payload, key, { expiresIn })` and `verifyJwt(token, keys, expectations)`. The strategy is `jwtStrategy({ keys, issuer, audience, toPrincipal })`.

### 3.5 OIDC (resource server)

`oidcStrategy({ issuer, audience })` validates bearer tokens issued by an external identity provider (Auth0, Keycloak, Entra, Cognito…):

- Reads `<issuer>/.well-known/openid-configuration` once, then the `jwks_uri`.
- Caches keys by `kid`. An unknown `kid` triggers one JWKS refresh, rate-limited to once a minute, so key rotation works and junk tokens can't make us hammer the provider.
- Maps claims to a `Principal` through a user-supplied `toPrincipal(claims)`, with a default of `sub` plus the `roles`/`scope` claims.

The **browser login flow** (authorization code + PKCE, callback route, state/nonce cookies) is decision D1 (§9).

### 3.6 API keys (service-to-service)

- **Format:** `hk_<keyId>_<secret>`, where the secret is 32 random bytes in base64url. The `keyId` prefix makes keys identifiable in logs and by secret scanners without revealing the secret.
- **Storage:** only `sha256(secret)` is stored, in the `api_keys` table: `key_id`, `hash`, `name`, `principal_id`, `permissions`, `created_at`, `last_used_at`, `revoked_at`. Comparison is constant-time (`crypto.timingSafeEqual`).
- **Transport:** `Authorization: Bearer hk_…` or an `X-API-Key` header.
- **Managing keys:** `createApiKey()` returns the full key **once**; `revokeApiKey()` revokes one.

---

## 4. Authorization (FR-072)

```ts
const policy = definePolicy({
  roles: {
    admin: ["*"],
    support: ["users.read", "users.update"],
    member: ["profile.*"],
  },
});

requireRole("admin");
requirePermission("users.read");
requirePermission("users.update", "users.delete");   // all of them
```

- **Permissions** are dot-separated strings. `*` matches everything, and `users.*` matches `users.read` but not `users` itself.
- **When roles resolve:** a principal's permissions are resolved from its roles **once**, in `authenticate()`, so checks are set lookups.
- **Resource-level rules** (e.g. "users may edit only themselves") are plain functions in the service layer:
  ```ts
  if (!can(actor, "users.update") && actor.id !== targetId) throw new ForbiddenError();
  ```
  `can(principal, permission)` is exported for this. The framework deliberately doesn't invent a policy DSL.
- **Status codes:** 401 when there is no principal, and 403 when the principal is authenticated but lacks the permission. An error response never lists which permission was missing (least disclosure); the log line does.

---

## 5. Caching (`@bun-hydrate/cache`, FR-080/081)

```ts
interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;   // ttl in seconds (spec-1 signature)
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  remember<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T>;
  namespace(prefix: string): Cache;                              // "users:" + key
}
```

- **Values are JSON-serialized in every adapter**, including memory. Behaviour is then identical in tests (memory) and production (Redis): a cached object can't be mutated through a shared reference, and non-JSON values (Dates, class instances) fail the same way everywhere. `null` is not cacheable (it means a miss) and throws. `undefined` is rejected too.
- **`MemoryCache({ maxEntries: 10_000 })`:** LRU eviction plus TTL. Expired entries are dropped on access and by a periodic sweep whose timer is `unref`'d, so it never keeps the process alive.
- **`RedisCache({ url | client, prefix })`:** built on `Bun.RedisClient` (`SET key value EX ttl`). Errors surface to the caller: a cache outage should be visible, not silently turned into misses. Apps that prefer fail-open wrap the call.
- **`remember()` stampede protection:** concurrent misses for the same key **in this process** share one `load()` call (single flight). Cross-instance stampede protection (distributed locks) is not included.
- **Readiness:** `cache.ping()` for `app.readinessCheck("cache", …)`.

---

## 6. Rate limiting (`@bun-hydrate/rate-limit`, FR-170)

```ts
app.use(rateLimit({ limit: 100, window: "1m" }));                    // per client IP
router.post("/login", rateLimit({
  limit: 5, window: "15m",
  key: async (ctx) => `login:${ctx.ip}:${(await peekJson(ctx))?.email ?? ""}`,
  store: redisStore,
}), loginHandler);
```

- **Algorithm:** a sliding-window counter. It keeps two fixed-window counters, current and previous, weighted by overlap. It is accurate to within a few percent, costs O(1) memory per key, and needs one atomic Lua script in Redis (`EVAL` was verified in the probe). This avoids fixed-window bursts at window edges without storing every timestamp.
- **Stores:** `MemoryRateLimitStore` (single instance and tests) and `RedisRateLimitStore` (shared across instances). A store outage **fails open** by default, logged at `warn`, because a Redis blip shouldn't take the API down. `failClosed: true` makes it strict for sensitive routes such as login.
- **Key:** defaults to `ctx.ip`, so §1.1's trusted-proxy handling is what makes this safe behind a load balancer. It can be keyed by user, API key or route instead.
- **Headers:**
  - Every response gets `RateLimit-Policy: "default";q=100;w=60` and `RateLimit: "default";r=37;t=23`, following the IETF draft `draft-ietf-httpapi-ratelimit-headers`.
  - A rejected request gets `429 TOO_MANY_REQUESTS` with `Retry-After`.
- **Window syntax:** durations like `"30s"`, `"1m"`, `"15m"`, `"1h"` or `"1d"`, parsed once at construction; invalid ones throw immediately.

---

## 7. Metrics (`@bun-hydrate/observability`, FR-162)

```ts
const metrics = createMetrics();                 // registry with default process metrics
app.use(metrics.http());                         // HTTP metrics middleware
app.get("/metrics", metrics.endpoint({ token: config.metricsToken }));

const signups = metrics.counter("signups_total", "Accounts created", ["plan"]);
signups.inc({ plan: "free" });
```

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram (buckets 5 ms … 10 s) | `method`, `route` |
| `http_requests_in_flight` | gauge | — |
| `process_resident_memory_bytes`, `process_heap_bytes` | gauge | — |
| `process_uptime_seconds` | gauge | — |
| `process_eventloop_lag_seconds` (p50/p99) | gauge | — (via `perf_hooks.monitorEventLoopDelay`) |
| `cache_requests_total` | counter | `cache`, `result` (hit/miss) |
| `rate_limit_decisions_total` | counter | `limiter`, `decision` (allowed/limited/store_error) |
| `db_query_duration_seconds` | histogram | `operation` (see D4) |

- **Exposition:** Prometheus text format 0.0.4, implemented in-house as a counter/gauge/histogram registry of about 200 lines. There is no `prom-client` dependency.
- **Cardinality guard:** `route` is the matched pattern (§1.2), and unmatched requests are labelled `route="<unmatched>"`. A metric refuses to create more than `maxSeries` label combinations (default 1000); it logs one warning and drops new series instead of eating memory.
- **Exposure:** `/metrics` leaks internals, so it is protected by a bearer token when `METRICS_TOKEN` is set. When the token isn't set in production, the endpoint is **not registered** and a startup warning is logged. See D3 for a separate internal port.
- **Queue latency:** spec-1 lists it, but queues arrive in v0.4, so it is deferred there.

---

## 8. React auth integration (`@bun-hydrate/react/auth`)

The backend is the only real gatekeeper. The session cookie is `HttpOnly`, so React can't read it and can't decide who the user is. React **reflects** what the server says, and hiding UI is cosmetic: every API route still enforces `requirePermission()`. The React side's job is to show the right UI from the first paint, and to stay consistent with the server.

### 8.1 Auth state travels in the hydration payload

```ts
// server: every page render gets the signed-in user, without each route passing it
const react = createReactRenderer({
  pages, assets,
  shared: (ctx) => ({ auth: authSnapshot(ctx, { user: (p) => ({ id: p.id, name: p.claims?.name }) }) }),
});
app.get("/", (ctx) => react.render("Home", props, { ctx }));
```

- **Payload:** it becomes `{ page, props, shared }`. `shared.auth` is `{ user: {…} | null, permissions: string[] }`, taken from `principal(ctx)` with permissions already resolved from roles.
- **Allow-listed fields:** `authSnapshot` sends only the fields its `user` mapper returns. Password hashes, raw JWT claims and session IDs can't leak into the HTML by accident. The payload goes through the same escaping serializer as page props (FR-225).
- **Why SSR seeding:** the first paint already shows the signed-in UI. There is no flash of the logged-out state, no extra `/me` request on load, and no hydration mismatch.
- **Renderer changes (additive):** `render()` gains an optional `{ ctx }` option, and `createReactRenderer` a `shared(ctx)` hook. Existing calls keep working.

### 8.2 Client API

```tsx
// src/web/auth.ts — generated by the auth:react feature (§9), typed with the app's permission names (§8.3)
export const { AuthProvider, useAuth, useCan, Can, wrapAuth } = createAuthClient<Permission>({ basePath: "/api/v1/auth" });

// src/web/client.tsx — wrapAuth = (page, shared) => <AuthProvider initial={shared.auth}>{page}</AuthProvider>
hydratePage(pages, { wrap: wrapAuth });

// in any component
const { user, status, login, logout } = useAuth();
const canDelete = useCan("users.delete");
<Can permission="users.delete" fallback={null}><DeleteButton /></Can>
```

| Piece | Behaviour |
|---|---|
| `useAuth()` | `user`, `status` (`"signed-in"` / `"signed-out"`), plus `login()`, `register()`, `logout()`, `refresh()` |
| `login()` / `register()` | Return `{ ok: true }` or `{ ok: false, fieldErrors, message }`, built from the server's 422/401 `details`, so forms show errors per field without parsing responses |
| After login | The server responds with a fresh snapshot, so the provider updates immediately |
| `logout()` | Calls the API, then does a full navigation to `/`, so no private server-rendered data stays in memory (important on shared computers) |
| `useCan()` / `<Can>` | Use the **same** `can()` function as the server's `requirePermission()` (§8.3), so wildcards like `users.*` mean exactly the same on both sides |
| Session expiry | `authFetch()` (a `fetch` wrapper) switches the provider to signed-out on any 401 and calls an optional `onSessionExpired` (e.g. show "please sign in again") |
| Multiple tabs | Login and logout are broadcast over `BroadcastChannel`, so every open tab updates |
| CSRF | Nothing to do: same-origin `fetch` sends the `Origin` header that `csrf()` checks (§2.3) |

`can()` lives in `@bun-hydrate/auth/permissions`, a browser-safe subpath with no Bun or database imports, so the client bundle can include it.

### 8.3 One typed permission list for both sides

```ts
// src/shared/permissions.ts
export const PERMISSIONS = [
  // hydrate:permissions:start
  "users.read", "users.update", "users.delete",
  "profile.read", "profile.update",
  // hydrate:permissions:end
] as const;
export type Permission = (typeof PERMISSIONS)[number];
```

- **Server:** `createAuthorization<Permission>()` returns typed `requirePermission`, `can` and `definePolicy`. A typo such as `requirePermission("users.dlete")` is a **compile error**.
- **Client:** `createAuthClient<Permission>()` types `useCan` and `<Can>` the same way, so `<Can permission="users.dlete">` fails `tsc` too.
- **Policies:** role definitions may use wildcards, typed as `Permission | "<prefix>.*" | "*"`, so `users.*` is accepted but `user.*` (no such prefix) is not.

### 8.4 Identity-provider SDKs (D1)

With an external identity provider (OIDC), its React SDK (Auth0, Keycloak…) signs the user in and holds the access token in memory. `authFetch` attaches it as a bearer token, and the backend's `oidcStrategy` validates it. `AuthProvider` then takes its user from the SDK instead of from the payload, and `useCan`/`<Can>` work unchanged on the permissions the backend returns from `/me`.

---

## 9. Feature orchestration: add and remove auth capabilities (`@bun-hydrate/cli`, `@bun-hydrate/auth`)

Auth isn't one thing. An internal API may want only API keys; a SaaS app wants sessions, a login page and later OIDC; a mobile backend wants JWT. So auth is split into small **features** that can be added and removed independently. An **orchestrator** resolves their dependencies, generates and deletes their files, writes their migrations, and keeps the wiring correct. You never hand-edit wiring when a capability changes.

The same pattern runs at two levels:

```text
 CLI (development time)                         Runtime (the app)
 ─────────────────────                          ─────────────────
 hydrate add auth:api-keys                      createAuth({ features: [...] })
        │                                              │
        ▼                                              ▼
 Orchestrator ── resolves dependency graph ──▶  Composition root (src/auth/index.ts,
        │        plans file/migration changes    generated) registers each feature's
        │        applies, records in manifest    services, middleware, routes, permissions
        ▼
 hydrate.features.json (what is installed, and which files it owns)
```

### 9.1 Features

Each feature is a self-contained unit with a declared contract:

```ts
defineFeature({
  id: "auth:api-keys",
  description: "Service-to-service API keys (hashed at rest)",
  requires: ["auth:core"],
  conflicts: [],
  files: { "src/auth/api-keys/…": template },        // created on add, tracked by content hash
  migrations: { up: "create table api_keys …", down: "drop table api_keys;" },
  env: [{ name: "API_KEY_PREFIX", optional: true }],
  permissions: ["api-keys.manage"],
  runtime: "apiKeysFeature",                           // export wired into the composition root
  commands: ["auth:api-key"],                          // console commands it enables
});
```

| Feature | Requires | Provides |
|---|---|---|
| `auth:core` | — | Principal, `authenticate()`, typed permissions list, `policy.ts`, `installAuth()` composition root |
| `auth:passwords` | core | argon2id hashing, `password_hash` column, rehash-on-login |
| `auth:sessions` | core | Session manager and database store, `sessions` table, cookie strategy, **`csrf()`** (always installed with sessions, since cookies need it) |
| `auth:jwt` | core | Bearer JWT strategy, signing keys from `JWT_*` env |
| `auth:oidc` | core | IdP bearer-token validation (§3.5) |
| `auth:api-keys` | core | API key strategy, `api_keys` table, `auth:api-key` commands |
| `auth:login` | passwords + (sessions **or** jwt) | `/register`, `/login`, `/logout`, `/me` routes, and the login rate limit |
| `auth:react` | core | `src/web/auth.ts`: `AuthProvider`, `useAuth`, `useCan`, `<Can>` (§8), the SSR `shared` hook |
| `auth:ui-login` | login + react | `Login.tsx` page |
| `auth:ui-register` | login + react | `Register.tsx` page |
| `auth:ui-account` | sessions + react | `Account.tsx` page ("sign out everywhere") |

**Presets** are named sets, so the common path stays one command:

| Preset | Expands to |
|---|---|
| `auth` | core, passwords, sessions, login, react, ui-login |
| `auth:api` | core, passwords, jwt, login |
| `auth:service` | core, api-keys |

### 9.2 Commands

```bash
bun hydrate features                        # installed and available features, with dependencies
bun hydrate add auth                        # preset
bun hydrate add auth:api-keys auth:oidc     # individual features
bun hydrate remove auth:ui-register
bun hydrate add auth:jwt --dry-run          # show the plan only
bun hydrate doctor                          # check installed features against disk and database
```

**`add` always shows a plan first, then applies it:**

```text
Plan: add auth:api-keys
  + requires auth:core (already installed)
  + src/auth/api-keys/strategy.ts
  + src/auth/api-keys/strategy.test.ts
  + migrations/20261001120000_add_auth_api_keys.sql
  ~ src/auth/index.ts            (composition root regenerated: +apiKeysFeature)
  ~ src/shared/permissions.ts    (+ "api-keys.manage" between markers)
  + commands: hydrate auth:api-key create|list|revoke
Next: bun hydrate db:migrate
Apply? [Y/n]
```

- Missing dependencies are added to the plan automatically and marked as such. Conflicts stop the plan with an explanation, e.g. `auth:ui-account` requires `auth:sessions` and cannot run with `auth:jwt` alone.
- `--yes` skips the prompt for scripts; `--dry-run` prints the plan and exits.
- **All-or-nothing:** every target is checked before anything is written, and a failed apply rolls back the files it created. A half-installed feature is never left behind.

**`remove` is the exact inverse, and it's conservative about your data and your edits:**

- **Dependents block removal.** Removing `auth:sessions` while `auth:ui-account` is installed stops and lists the dependents; `--cascade` removes them too, and the plan shows everything that will go.
- **Your edits are never destroyed.** A generated file is deleted only if its content hash still matches the manifest. A file you modified is kept, reported as "modified — kept", and simply unregistered. `--force` deletes it anyway.
- **Migrations are history, so they're never deleted.** Removal writes a new `remove_<feature>` migration that undoes the schema change. Its `up` drops the tables, and its `down` re-creates them.
- **Dropping data needs explicit consent.** Without `--drop-data`, the removal migration leaves tables in place (code removed, data kept) and says so. With `--drop-data`, it drops them.
- **Removed features lose their commands:** e.g. `hydrate auth:api-key` disappears with `auth:api-keys`.

**`doctor`** reports:
- generated files you modified (fine, but they won't be updated by `sync`);
- generated files that are missing;
- feature migrations not yet applied (when `DATABASE_URL` is set);
- env vars the installed features need but that are unset;
- a composition root edited by hand.

`hydrate sync` regenerates orchestrator-owned files, for example after upgrading bun-hydrate, and **never** touches user-owned files (§9.3).

### 9.3 Who owns which file

This is what makes safe add/remove possible:

| Owner | Files | Rule |
|---|---|---|
| **Orchestrator** | `src/auth/index.ts` (composition root), `src/web/auth-pages.ts`, `hydrate.features.json` | Fully regenerated on every add/remove/sync. The header says "generated by hydrate — do not edit", and `doctor` flags hand edits. |
| **Orchestrator, in markers** | `src/shared/permissions.ts` between `hydrate:permissions` markers | Only the marked block is rewritten; everything outside it is yours (D7) |
| **You, from the start** | `src/auth/config.ts`: roles/policy, session timeouts, the `authSnapshot` user mapper, login limits | Created once, never overwritten; the composition root imports it. Customization goes here. |
| **You, after creation** | Feature files (strategies, pages, tests) | Tracked by hash only so `remove` knows whether it's safe to delete them |

**One-time wiring, then never again.** The first `hydrate add auth…` prints three lines to add to files you own:
- `installAuth(app, container)` in `app.ts`;
- `...authPages` in `definePages()`;
- `wrapAuth` in `hydratePage()`.

After that, every add or remove only changes orchestrator-owned files, so `app.ts` never needs editing again.

### 9.4 Runtime side: the composition root

```ts
// src/auth/index.ts — generated from hydrate.features.json
import { createAuth } from "@bun-hydrate/auth";
import { config } from "./config";
import { coreFeature } from "@bun-hydrate/auth/features/core";
import { passwordsFeature } from "@bun-hydrate/auth/features/passwords";
import { sessionsFeature } from "@bun-hydrate/auth/features/sessions";
import { loginFeature } from "./login/feature";

export const auth = createAuth({ config, features: [coreFeature, passwordsFeature, sessionsFeature, loginFeature] });
export const { installAuth, requirePermission, principal } = auth;
```

```ts
interface AuthFeature {
  id: string;
  requires?: readonly string[];
  register?(container: Container, config: AuthConfig): void;   // services, stores
  strategies?(container: Container): Strategy[];                // contributed to authenticate()
  middleware?(container: Container): Middleware[];              // e.g. csrf, login rate limit
  routes?(container: Container): { path: string; router: Router }[];
  permissions?: readonly string[];
  snapshot?(principal: Principal): Record<string, unknown>;     // contributed to the React payload
}
```

- `createAuth` validates at startup that every feature's `requires` is present, so a hand-edited composition root with a missing dependency fails with a clear message instead of misbehaving at runtime.
- It orders features topologically and composes their contributions: strategies in order into `authenticate()`, then middleware, routes and permissions.
- Features can be unit-tested in isolation by giving `createAuth` just that feature and its dependencies.

### 9.5 `hydrate generate module <name> --auth`

It generates the normal module plus:

- Routes guarded with `requirePermission("<name>.read" | ".create" | ".update" | ".delete")`.
- Those four permissions added between the `hydrate:permissions` markers, so they are immediately usable, with type checking, in `<Can>` and `useCan`.
- A test that signs in as principals with and without the permissions, and asserts 200 vs 403.

It requires `auth:core`, and offers to add it if it's missing. `hydrate remove` of a module-owned permission block isn't needed: deleting the module and its permissions is a normal code change.

### 9.6 Operational console commands

These are enabled by the features that provide them, and run the **app's own** code (`src/auth/commands.ts`, generated with `auth:core`), the same way `db:seed` runs the app's seed file. The CLI therefore never assumes a table layout you may have changed. Like `db:*`, they read `DATABASE_URL`.

| Command | Feature | Purpose |
|---|---|---|
| `hydrate auth:create-user --email <e> --role admin` | passwords | Bootstraps the first admin, which no HTTP route can do safely. The password is typed at a hidden prompt, or passed with `--password-stdin`; **never as an argument**, which would land in shell history and the process list. |
| `hydrate auth:set-role --email <e> --role <r>` | core | Changes a role and revokes the user's sessions, so new permissions apply immediately |
| `hydrate auth:revoke-sessions --email <e>` | sessions | Signs a user out everywhere |
| `hydrate auth:api-key create --name <n> --permissions a,b [--owner <e>]` | api-keys | Prints the key **once**; only its hash is stored |
| `hydrate auth:api-key list` / `revoke <keyId>` | api-keys | Shows id, name, owner, last used and revoked (never the secret); revokes a key |
| `hydrate auth:permissions` | core | Role × permission matrix; flags grants of names not in `PERMISSIONS` |

### 9.7 Beyond auth

The orchestrator (feature registry, dependency resolution, plan/apply, manifest, ownership rules, `doctor`, `sync`) is generic and lives in `@bun-hydrate/cli`. Auth is its first consumer. In the same release, the other v0.3 capabilities become features with the same `add`/`remove` behaviour:

| Feature | What it installs |
|---|---|
| `cache:memory`, `cache:redis` | cache in the container, readiness check |
| `rate-limit` | global limiter |
| `metrics` | HTTP metrics and the `/metrics` endpoint |
| `security:cors` | CORS configured from `CORS_ORIGINS` |

Later versions add jobs, queues and storage the same way. Third-party packages can ship features, since a feature is just a `defineFeature()` export.

---

## 10. Testing and tooling

- **Test client:**
  - `createTestClient(app, { cookies: true })` keeps a cookie jar across requests, so session tests read naturally: register, log in, call a protected route.
  - `.ip("203.0.113.9")` sets the client IP for rate-limit tests.
  - `.bearer(token)` is shorthand for the `Authorization` header.
- **Auth test helpers:** `signTestToken(claims)` / `testKeys()` provide a throwaway ES256 key pair for JWT tests. `createTestPrincipal({ roles })` builds a principal for unit-testing services.
- **WebSockets:** `connectWebSocket(url, { headers })` returns an object with `send()`, `next()` (awaits the next message, with a timeout) and `close()`. It is used against real servers started with `spawnServer` or `app.listen({ port: 0 })`; there is no in-process WebSocket.
- **Redis:** Redis-backed tests run when `TEST_REDIS_URL` is set, mirroring `TEST_POSTGRES_URL`. The memory adapters always run.
- **CLI:** feature orchestration (`hydrate add` / `remove` / `features` / `doctor` / `sync`) and the `hydrate auth:*` commands are specified in §9.

---

## 11. Reference app changes

- **Migration:**
  - Add `password_hash` and `role` (`member` | `admin`, default `member`) to `users`.
  - New `sessions` table: `id_hash`, `user_id`, `created_at`, `last_seen_at`, `expires_at`, `user_agent`, `ip`.
- **Auth routes (`/api/v1/auth`):**
  - `POST /register` (hashes the password, returns 201, starts a session).
  - `POST /login`, rate-limited per IP+email with 5 attempts per 15 min, fail-closed. The response is the same `401 INVALID_CREDENTIALS` for an unknown email and a wrong password, and it rehashes on success when `needsRehash`.
  - `POST /logout` and `GET /me`.
- **Users API authorization:**
  - `GET /` and `DELETE /:id` need `users.read` / `users.delete` (admins).
  - `PATCH /:id` is allowed for the user themself or with `users.update`.
  - `GET /:id` is allowed for self or `users.read`.
- **App-wide:** `securityHeaders()` (default), `csrf()`, `cors()` from `CORS_ORIGINS`, a global `rateLimit` (300/min per IP), `/metrics` behind `METRICS_TOKEN`, and a readiness check for the cache when Redis is configured.
- **WebSocket:** `/ws/rooms/:room` (signed-in users only) broadcasts messages to the room, showing upgrade auth, origin checks and shutdown.
- **React:** the reference app's auth is produced by running `hydrate add auth` itself, then wiring it by hand exactly as printed. That dogfoods the generator. The app gets `AuthProvider` seeded from SSR, "Signed in as …" on Home, `<Can permission="users.delete">` on an admin-only control, and a `/login` page (see D2).
- **New config:** `TRUST_PROXY`, `CORS_ORIGINS`, `REDIS_URL` (optional: memory stores when unset), `METRICS_TOKEN`, `SESSION_IDLE_TIMEOUT`, `SESSION_ABSOLUTE_TIMEOUT`. `.env.example` is updated. There are no new required variables, so the app still starts with zero setup.

---

## 12. Test plan (what "done" means)

Every item below is written as a failing test first, as in v0.1/v0.2:

| Area | Key tests |
|---|---|
| Trusted proxy | spoofed `X-Forwarded-For` ignored by default; hop count and CIDR modes pick the right address; `X-Forwarded-Proto` only from trusted peers |
| Cookies | set/delete appear on handler `Response`s and error responses; secure flag follows protocol |
| Security headers | defaults present; HSTS only on https; CSP allows our SSR hydration (browser e2e, no violations) |
| CORS | preflight allowed/denied; `Vary: Origin`; `*`+credentials throws |
| CSRF | cross-site cookie POST → 403; same-origin passes; bearer/API-key requests exempt; safe methods exempt |
| Passwords | argon2id; verify; `needsRehash`; unknown-user timing path executes a hash |
| Sessions | fixation (new ID on login); idle and absolute expiry with an injected clock; only hashes stored; destroyAllFor; forged/expired cookie → 401 |
| JWT | round-trip per alg; `none` rejected; alg-confusion (HS256 signed with an RS256 public key) rejected; exp/nbf/aud/iss; skew |
| OIDC | discovery + JWKS against a local fake issuer; key rotation via unknown `kid`; refresh rate limit |
| API keys | shown once; hashed at rest; revoked keys rejected; constant-time compare used |
| Authorization | wildcard matching; 401 vs 403; self-or-permission rule in users service |
| Cache | TTL, LRU eviction, JSON semantics, `remember` single-flight (1 load for 50 concurrent misses), namespaces; same suite against Redis when `TEST_REDIS_URL` set |
| Rate limit | limit + 1 → 429 with headers; sliding window math with injected clock; fail-open vs fail-closed on store error; same suite against Redis |
| Metrics | exposition format parses; route label uses pattern; cardinality cap; token protection; histogram buckets |
| WebSockets | upgrade through middleware; auth failure → HTTP 401 (no upgrade); cross-origin upgrade → 403; room broadcast between two clients; payload limit; `stop()` closes with 1001 |
| React auth | snapshot contains only allow-listed fields; `useCan`/`<Can>` agree with server 403s for the same principal (one table-driven test runs both); typo'd permission fails `tsc`; logout broadcasts to a second tab; 401 from `authFetch` flips to signed-out |
| Orchestrator | dependency resolution (missing deps added, conflicts rejected, cycles impossible); plan output matches apply; failed apply rolls back files; remove blocked by dependents, `--cascade` works; modified files kept, unmodified deleted; remove writes a new migration and keeps data without `--drop-data`; `doctor` detects each drift kind; `sync` never touches user-owned files |
| Auth features | every preset and every single feature added to a fresh project → type-checks, generated tests pass; then removed one by one → the project still type-checks and passes (add → remove round-trip); same starting from a project with a users module; `generate module --auth` edits only between markers; `auth:create-user` refuses a password argument; `auth:api-key create` prints once, stores a hash; `auth:set-role` revokes sessions |
| Composition root | `createAuth` rejects missing `requires` with a clear message; features compose in dependency order; strategies tried in order |
| Reference app e2e | register → login (cookie) → /me → CSRF-protected PATCH → logout; in Chromium: signed-in UI on first paint with no flash, admin-only control hidden for members and shown for admins, logout in one tab updates another; login brute-force → 429; `/metrics` with/without token; WebSocket chat between two sessions |

Postgres and Redis suites run when their `TEST_*_URL` is set. Before v0.3 is called done, both will be run locally against the installed Postgres 16 and Redis.

---

## 13. Implementation order

Each step is a separate commit with its tests green:

1. **Kernel:** `trustProxy`/`ctx.ip`/`ctx.protocol`, `ctx.route`, cookies, `TooManyRequestsError`, `_FILE` secrets.
2. **Kernel:** `securityHeaders()`, `cors()`, trace context.
3. `@bun-hydrate/cache` (memory → Redis).
4. `@bun-hydrate/rate-limit` (memory → Redis).
5. `@bun-hydrate/auth`:
   - 5a. passwords
   - 5b. principal + `authenticate`/`require*` + policies
   - 5c. sessions + CSRF
   - 5d. JWT
   - 5e. API keys
   - 5f. OIDC
6. `@bun-hydrate/observability` (metrics).
7. Kernel: WebSocket routes + shutdown.
8. Testing helpers (cookie jar, `.ip()`, `connectWebSocket`, auth helpers).
9. React auth: renderer `shared`/`ctx`, `hydratePage` wrap, `createAuthClient` (`AuthProvider`, `useAuth`, `useCan`, `<Can>`, `authFetch`), and the browser-safe `can()`.
10. Orchestrator in `@bun-hydrate/cli` (registry, resolver, plan/apply, manifest, ownership, `doctor`, `sync`), then `createAuth` + `defineFeature` in `@bun-hydrate/auth`, then the auth features and presets, `generate module --auth`, and the `auth:*` commands. Last, the cache, rate-limit, metrics and CORS features.
11. Reference app: `hydrate add auth` with the CLI, protected users API, config, `/metrics`, WebSocket room, e2e and browser tests.
12. Docs: README, `.env.example`, and a spec-5 "as built" pass recording deviations.

---

## 14. Risks found while writing this spec

- **Redis subscriber shutdown:** in the probe, a `Bun.RedisClient` that had entered subscriber mode kept the process alive after `close()`. This matters for graceful shutdown (the "exit cleanly after SIGTERM" guarantee from v0.1). v0.3 doesn't need Redis pub/sub (fan-out is v0.4), and GET/SET/INCR/EVAL clients were not tested for this; the rate-limit and cache stores will get the same "process exits after stop" test the kernel has.
- **Bun minifier:** labelled-statement bugs were already found in React bundles (spec-3 §11). Any new client code (the login page) goes through the same V8 syntax guard and browser e2e.
- **Bun.CookieMap** is a relatively recent Bun API. It is used behind our own `ctx.cookies` interface, so it can be replaced without an API change if a bug shows up.

---

## 15. Decisions needed before implementation

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | OIDC scope in v0.3 | (a) resource server only: validate IdP-issued bearer tokens; (b) also the browser login flow (authorization code + PKCE, callback, state/nonce) | **(a)** now, (b) as v0.3.1. (a) covers APIs and SPAs using an IdP SDK; (b) roughly doubles the auth surface and needs a real IdP for e2e. |
| D2 | What the default `auth` preset includes (and so the reference app) | (a) no UI features; (b) `ui-login` only; (c) login, register and account pages | **(b)**: proves cookies, CSRF and CSP in a real browser; register/account are one `hydrate add` away. |
| D3 | Where `/metrics` is served | (a) same port, bearer token; (b) separate internal port (e.g. 9091) with no auth | **(a)** by default, with (b) as an option. (a) needs no infra change, and `deploy.sh`/security groups stay untouched. |
| D4 | DB query duration metric | (a) instrument `db.sql` (wrap the tagged template; timing per query, labelled `select`/`insert`/…); (b) transaction-level timing only; (c) defer to v0.4 | **(a)**, but treated as the step most likely to slip: wrapping Bun.SQL's callable object must keep `db.sql(obj)`, `.unsafe`, and transactions working, and will get its own tests. |
| D5 | Default session store in the reference app | (a) database (`sessions` table); (b) cache (memory, Redis when `REDIS_URL` set) | **(a)**: supports "sign out everywhere" and survives Redis restarts; the app already has a database. |
| D6 | Package layout | (a) as proposed: `auth`, `cache`, `rate-limit`, `observability` as separate packages; (b) fewer, larger packages | **(a)**, matching spec-1 §3's list and "use only what you need" (§2.3). |
| D7 | May generators edit existing files? | (a) never: always print the lines to add; (b) only inside `hydrate:*` marker blocks the generator itself created, otherwise print; (c) edit freely (AST rewrite of `app.ts`, etc.) | **(b)**: permissions stay in one typed list without manual copying, while `app.ts`/`client.tsx` stay the developer's; (c) is fragile and surprising. |
| D8 | Frontend state library for `AuthProvider` | (a) plain React context + `useSyncExternalStore`; (b) depend on a library (Zustand, TanStack Query) | **(a)**: no new dependency, and apps can still use TanStack Query for their own data. |
| D9 | What `remove` does to data | (a) keep tables unless `--drop-data`; (b) always drop | **(a)**: removing a feature should never silently delete production data; the removal migration says what it left behind. |
| D10 | Orchestrator scope in v0.3 | (a) generic engine, used by auth **and** cache/rate-limit/metrics/CORS; (b) auth only, generalize in v0.4 | **(a)**, provided it stays on schedule: the engine is the same code either way, and the four non-auth features are small. If time runs short, (b) is the fallback. |

---

## 16. As built

v0.3 was implemented in the order of §13, test first, and every §12 row has tests. Where the code differs from the text above, the code is right, for the reasons below.

### 16.1 Kernel

| Topic | Spec | As built, and why |
|---|---|---|
| `fetch` vs upgrade | `app.fetch` for everything | `app.fetch(request)` never upgrades, so WebSocket routes answer `426` there. `app.handle(request, server)` can upgrade, and `listen()` uses it. In-process tests keep a plain `fetch`. |
| Shutdown of WebSockets | close code `1001` | Close code `1012` ("service restart"): Bun rewrites a server-sent `1001` to `1000`, which clients read as a normal close. |
| Draining | `server.stop()` | The app counts its own in-flight requests and open sockets and drains those. In Bun 1.3.11, `server.stop()` never settles once a WebSocket has connected. |
| Migrations | — | Sections that hold only comments are deliberate no-ops (SQLite rejects an empty query). Removal migrations that keep data rely on this. |
| `build()` | — | Restores `NODE_ENV` afterwards, even on failure. The CLI loads the bundler only for `hydrate build`, so other commands never load React. |

### 16.2 Auth

| Topic | Spec | As built, and why |
|---|---|---|
| `authenticate()` | Variadic strategies | Takes `authenticate({ strategies, policy })`, so role → permission resolution happens once per request. |
| Forged or expired session cookie | `401` | The request continues anonymous and the cookie is cleared. Browsers resend cookies on every request, so a stale cookie must not break public pages. Protected routes still answer `401` through `requireAuth()`/`requirePermission()`. |
| OIDC principals | — | `via: "jwt"`, because they are bearer tokens: CSRF exempts them the same way. |
| JWT with OIDC | Both allowed | `auth:jwt` and `auth:oidc` conflict. Both read `Authorization: Bearer`, and one verifier per app keeps a foreign token from being rejected by the wrong one. |
| Issued JWTs | `sub`, roles | `JwtIssuer.issue()` also carries public claims such as `email`. Registered claims (`sub`, `iat`, `exp`, …) and `roles`/`permissions` cannot be overridden this way. |
| Data model (§11) | `password_hash` and `role` columns on `users` | Features own their own tables: `accounts` (auth:core) and `account_passwords` (auth:passwords). A fresh project has no `users` table, and the CLI must never assume one exists (§9.6). The reference app's `users` module is a directory; the "self" rule matches the entry by the signed-in email. |
| Runtime features | Values (`sessionsFeature`) | Factories: `sessionsFeature(options)`, `jwtFeature`, `oidcFeature`, `apiKeysFeature`. They read their settings from `authConfig.features` or the environment (with `_FILE` support), and fail at startup with a `ConfigError`. |
| `AuthFeature` hooks | `Resolver` | Receive the `Container`, so features can ask `has()`. For example, the login routes check for `SessionManager` and `JwtIssuer`, so the login files don't change when switching between sessions and JWT. |
| Console commands | — | `createAuth(...).register(container)` wires services without an HTTP app. The generated commands use it. |
| Test helpers | `@bun-hydrate/testing` | Split into subpaths (`/auth`, `/database`), so the base helpers stay free of auth and database dependencies. |

### 16.3 Other packages

| Topic | As built |
|---|---|
| `rateLimit({ failClosed: true })` | Answers `503 RATE_LIMIT_UNAVAILABLE` when the store fails. |
| `cache.remember()` | Returns `null`/`undefined` from the loader without caching it. `null` means "absent" in the cache API. |
| React renderer | Gained `shared(ctx)` and `wrap(page, shared)`, and `render()` takes `{ ctx }`. `hydratePage(pages, { wrap })` must use the same `wrap`. |
| Metrics (D3) | In production, `/metrics` is served only when `METRICS_TOKEN` is set; otherwise a warning is logged. The app still starts. Refusing to start would break existing deploys, which set no new variables. |

### 16.4 Feature orchestration

- **Where the pieces live.** `defineFeature`/`definePreset` (development time: files, migrations, outputs) live in `@bun-hydrate/cli`. `defineAuthFeature`/`createAuth` (runtime) live in `@bun-hydrate/auth`. Both use the same feature ids.
- **Composed files.** Features contribute to named slots, and outputs render the slots. Several features may declare the same output. It is rendered once and deleted with the last of them: this is how every platform feature shares one generated `installPlatform(app, container)` (`src/platform/index.ts`).
- **Tracked files.** Templates are `.tmpl` files imported as text, so generated code is written as real code. Every preset and single feature is added to a scratch project in the tests. The project must type-check and pass its generated tests, then survive a step-by-step removal.
- **Generated login tests.** They check the modes the app actually installed (`auth.has("auth:sessions")`, `auth.has("auth:jwt")`), so they stay valid after switching between them.
- **Confirmation.** `add`/`remove` prompt `Apply? [Y/n]` on a terminal. Without one, they require `--yes`.
- **Command options.** Options are `--name value` or `--name=value`. `--password`, `--secret` and `--token` are refused outright.
- **Not built.** `generate module --auth` stops with the command to run instead of offering to add `auth:core` interactively.

### 16.5 Reference app

- It was produced with `bun hydrate add auth metrics security:cors rate-limit` and wired by hand as printed. The generated files are committed unchanged, and `bun hydrate doctor` is clean.
- No cache feature is installed, because nothing in the app is worth caching yet. `REDIS_URL` belongs to `cache:redis`.
- Its e2e databases are prepared with the real CLI: `db:migrate`, then `auth:create-user --password-stdin`.

### 16.6 Bun 1.3.11 behaviour found along the way

- The bundler's `minify.syntax` breaks React's labelled statements. Builds use whitespace and identifier minification only, behind a V8 syntax check (spec-3).
- `Bun.SQL` queries are lazy. `expect(query).rejects` hangs; `await` or `.catch()` them.
- A `RedisClient` in subscriber mode keeps the process alive after `close()`. v0.3 doesn't use pub/sub.
- `expect(x).toMatchObject({ key: expect.any(String) })` replaces `x.key` with the matcher object. Read values before asserting on them.
- A second in-process `Bun.build` of the same entry occasionally fails with "Unexpected reading file". Tests avoid depending on repeated in-process builds.
- React 19's SSR keeps `autoComplete` camel-cased in HTML, which browsers treat case-insensitively.
- Playwright's `APIRequestContext` fails under Bun ("Target … closed"). Browser tests sign in with a same-origin `fetch` from the page, which is also the more faithful flow.

