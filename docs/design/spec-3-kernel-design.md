# bun-hydrate Spec 3 — Kernel Detailed Design (v0.1)

**Document:** `spec-3`
**Status:** Accepted for implementation
**Builds on:** `spec-1` (requirements), `user-process-landscape` (developer UX), `spec-2` (gap analysis)
**Scope:** The v0.1 kernel listed in spec-1 §32 — App, Context, Router, Middleware, Errors, Configuration, Lifecycle, Build, Tests — plus the pieces the kernel cannot be tested end to end without: request IDs, structured logging, health/readiness, static files, and React SSR + hydration (the "hydrate" in the name, and what the existing app already does).

Out of scope for this cycle (unchanged from spec-1 §32): validation, DI, database, auth, cache, queues, events, WebSockets, generators.

---

## 1. Repository layout

```text
bun-hydrate/
├── packages/
│   ├── core/        @bun-hydrate/core     App, Router, Context, errors, config, logger, health, static files
│   ├── testing/     @bun-hydrate/testing  in-process HTTP test client
│   ├── react/       @bun-hydrate/react    SSR renderer, safe hydration payload, client hydrate, assets
│   └── cli/         @bun-hydrate/cli      `hydrate dev | build | start`
├── src/                                   reference application (what is deployed today)
│   ├── main.ts                            process entry: config → app → listen
│   ├── app.ts                             createApp(config): App   (imported by tests)
│   ├── config.ts                          typed configuration
│   ├── modules/system/routes.ts           JSON endpoints
│   └── web/
│       ├── pages/                         React pages
│       ├── pages.ts                       page registry shared by server and client
│       └── client.tsx                     browser entry: hydratePage(pages)
├── tests/                                 application-level e2e tests
├── hydrate.config.ts                      build entries
└── docs/design/
```

Bun workspaces link the packages; no Nx/Turborepo (spec-2 PR-007). Each package exports TypeScript source directly (`"exports": "./src/index.ts"`) — Bun executes TS natively and the production build bundles everything, so there is no per-package compile step to keep in sync.

**Why packages now, although spec-2 MG-001 suggested staying flat:** the kernel and the reference app must not import each other's internals. Package boundaries make that a resolver error instead of a code-review rule, and they cost nothing extra under Bun workspaces.

---

## 2. Request pipeline

```text
Bun.serve fetch(request)
   │
   ▼
App.fetch(request)                       ← also the entry point for the test client
   │  1. resolve request ID (incoming x-request-id if well-formed, else randomUUID)
   │  2. build Context (params empty, logger bound to requestId)
   │  3. router.match(method, path)  →  { handler, params, middleware }  |  404  |  405
   │  4. compose [global middleware..., router middleware..., route middleware..., handler]
   │  5. normalize handler return value into a Response
   │  6. on throw → error handler → JSON error Response
   │  7. set x-request-id on the final response; log the request line
   ▼
Response
```

Steps 1, 6 and 7 are part of dispatch, not middleware, so a request ID exists and the error format holds even when a middleware throws before calling `next()`.

### 2.1 Middleware model

```ts
type Next = () => Promise<Response>;
type Middleware = (ctx: Context, next: Next) => Response | Promise<Response>;
type Handler<P> = (ctx: Context<P>) => HandlerResult | Promise<HandlerResult>;
type HandlerResult = Response | string | object | null | undefined;
```

Onion model: a middleware may act before `next()`, short-circuit by returning its own Response, or post-process the Response `next()` resolves to. Calling `next()` twice is a programming error and throws.

### 2.2 Return-value normalization (FR-013)

| Handler returns | Response |
|---|---|
| `Response` | as is |
| `string` | `200 text/plain; charset=utf-8` |
| plain object / array | `200 application/json` |
| `null` / `undefined` | `204 No Content` |

`ctx.status(code)` and `ctx.header(name, value)` set values applied by the ctx response builders and by normalization, so `ctx.status(201); return user;` works.

---

## 3. Context (FR-011, FR-012, FR-013)

```ts
class Context<Params = Record<string, string>> {
  readonly request: Request;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly params: Params;
  readonly query: URLSearchParams;
  readonly headers: Headers;           // request headers
  readonly requestId: string;
  readonly log: Logger;                // child logger with { requestId }
  readonly state: ContextState;        // augmentable interface, see below
  readonly body: RequestBody;          // json / text / formData / bytes

  status(code: number): this;
  header(name: string, value: string): this;
  json(data: unknown, status?: number): Response;
  text(text: string, status?: number): Response;
  html(html: string | ReadableStream, status?: number): Response;
  redirect(location: string, status?: 301 | 302 | 303 | 307 | 308): Response;
  file(path: string | BunFile): Promise<Response>;   // 404 if missing
}
```

**Deviation from spec-1 FR-012:** spec-1 lists both `await ctx.json()` (read body) and `ctx.json(data)` (respond). One method name with two meanings chosen by arity is a trap, so reading lives under `ctx.body`: `await ctx.body.json<T>()`, `.text()`, `.formData()`, `.bytes()`. Malformed JSON raises `BadRequestError` (400), not a 500. The raw `ctx.request` stays available (spec-1 §23 escape hatches).

**Deviation from spec-1 FR-011 `ctx.response`:** a mutable response object would duplicate what `Response` already is. Pending status/headers (`ctx.status`, `ctx.header`) cover the use case.

**Typed state** uses declaration merging, so it needs no generics threaded through every API:

```ts
declare module "@bun-hydrate/core" {
  interface ContextState { user?: User }
}
```

---

## 4. Router (FR-010)

- Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD, plus `all()`.
- Path syntax: static segments, `:param`, and a trailing `*` wildcard (captured as `params["*"]`).
- Matching is a segment trie with fixed priority **static > param > wildcard**, independent of registration order, so adding a route never silently shadows another.
- Params are typed from the path literal: `app.get("/users/:id", (ctx) => ctx.params.id)` — `ctx.params` is `{ id: string }`.
- Percent-encoded segments are decoded for params; a malformed encoding is a 400.
- Trailing slashes are ignored (`/users/` matches `/users`).
- `HEAD` falls back to the `GET` handler with the body removed.
- Path matches but method does not → **405** with an `Allow` header. Automatic `OPTIONS` → 204 with `Allow`.
- Duplicate registration of the same method + path throws at registration time.
- Composition: `const users = new Router(); users.use(mw); users.get("/:id", h); app.route("/users", users);` — router middleware (FR-014) applies only to that router's routes.

---

## 5. Errors (FR-020, FR-021)

```ts
class HttpError extends Error {
  constructor(status: number, message: string, options?: { code?: string; details?: unknown; cause?: unknown; headers?: HeadersInit });
  readonly status: number;
  readonly code: string;       // default derived from status, e.g. 404 → NOT_FOUND
  readonly details?: unknown;
  readonly expose: boolean;    // true for 4xx: message is safe to send to the client
}
```

Subclasses: `BadRequestError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `MethodNotAllowedError` 405, `ConflictError` 409, `ValidationError` 422 (carries `details`), `InternalServerError` 500.

Wire format:

```json
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found", "requestId": "…", "details": [] } }
```

- Unknown thrown values become 500 `INTERNAL_SERVER_ERROR` with the generic message "Internal Server Error".
- 5xx messages are never sent unless `exposeErrors` is on; stack traces are included only when `exposeErrors` is on (default: on in development, off otherwise).
- Every 5xx is logged at `error` with the stack and the request ID; 4xx are not logged as errors.
- `app.onError((error, ctx) => Response | undefined)` lets an app customize; returning `undefined` falls back to the default.

---

## 6. Configuration (FR-030, FR-031)

```ts
export const loadConfig = (source = process.env) => defineConfig({
  port: env.number("PORT").default(3000),
  host: env.string("HOST").default("0.0.0.0"),
  appEnv: env.enum("APP_ENV", ["development", "test", "production"]).default("development"),
  databaseUrl: env.url("DATABASE_URL").optional(),
  debug: env.boolean("DEBUG").default(false),
}, source);
```

- Fields are **required unless** `.default()` or `.optional()` is used; the return type follows (`.optional()` → `T | undefined`).
- Parsers: `string`, `number` (finite), `integer`, `port` (1–65535; 0 allowed for ephemeral), `boolean` (`true/false/1/0/yes/no`), `enum`, `url`.
- Empty string counts as unset.
- All problems are collected and thrown together as one `ConfigError`, so a broken deploy shows every missing key at once, with a next action:

```text
Invalid configuration:
  - DATABASE_URL: required but not set
  - PORT: expected a port number (0-65535), received "http"
  - HOST: required but not set (found "host" — environment variable names are case-sensitive)
Set these in .env or the process environment.
```

  The case-sensitivity hint exists because this repo already shipped that exact bug once (commit `fb61ab7`).
- `source` is injectable, so tests never mutate `process.env`.
- `.env` loading is Bun's built-in behaviour (`.env`, `.env.{NODE_ENV}`, `.env.local`) — the framework does not reimplement it (spec-1 §2.1).
- The result is frozen.

---

## 7. Lifecycle (FR-001, FR-002, FR-003)

```text
created ──listen()──▶ initializing ──hooks ok──▶ ready ──server bound──▶ running
                           │                                               │
                     hook throws                                        stop()
                           ▼                                               ▼
                        stopped ◀───────── onStop hooks ◀──────────── stopping
```

- `app.onStart(fn)` hooks run in registration order before the port is bound. If one throws, the already-started hooks' matching `onStop` hooks run and `listen()` rejects: the app never accepts traffic half-initialised.
- `app.onStop(fn)` hooks run in **reverse** order (resources close in the opposite order to how they opened).
- `app.stop({ timeoutMs = 10_000 })`:
  1. state → `stopping`; `/ready` starts returning 503 so load balancers drain.
  2. `server.stop()` stops accepting connections and waits for in-flight requests.
  3. If the timeout elapses first, remaining connections are force-closed.
  4. `onStop` hooks run; state → `stopped`.
  Calling `stop()` twice returns the same promise.
- `listen({ port, hostname, handleSignals = true })` installs SIGTERM/SIGINT handlers that call `stop()` and removes them again on stop, so tests that start and stop many apps don't leak listeners.
- `app.state` exposes the current stage.

---

## 8. Observability built into the kernel

**Request IDs (FR-150).** An incoming `x-request-id` is reused only if it matches `^[A-Za-z0-9._:-]{1,128}$`, so it can't inject into logs. Otherwise `crypto.randomUUID()` is used. The ID is exposed as `ctx.requestId`, bound into `ctx.log`, included in error bodies, and echoed on every response.

**Logger (FR-140).** `createLogger({ level, format: "json" | "pretty", bindings, write })` has levels `trace … fatal`, plus `silent`. Each line is one JSON object: `{ time, level, msg, ...bindings, ...fields }`. `Error` values are serialized as `{ name, message, stack }`. `logger.child(bindings)` adds fields. `write` is injectable so tests assert on log output. The default format is `json` in production and `pretty` otherwise.

**Request logging.** Each response logs `{ method, path, status, durationMs, requestId }` at `info` (at `warn` for 5xx, and the error is logged separately). It can be turned off with `logRequests: false`.

**Health (FR-160, FR-161).** These are registered by default and can be turned off with `health: false`:
- `GET /health` → `200 { status: "ok", uptime }` while the process can answer. `deploy.sh` depends on this route.
- `GET /ready` → `200 { status: "ready", checks }` only when state is `running` and every check registered with `app.readinessCheck(name, fn)` resolves truthy within 2s. Otherwise it returns `503 { status: "not_ready", checks }`, with each failing check reported by name.

`/metrics` (FR-162) stays in v0.3 as planned.

---

## 9. Static files

`serveStatic({ root, prefix = "/", cacheControl })` is middleware. It answers GET/HEAD only and falls through to `next()` on a miss. It resolves paths with `path.resolve` and rejects anything outside `root`, including `..` and encoded traversal. Content types come from `Bun.file().type`.

---

## 10. React SSR and hydration (FR-120, FR-121, FR-122, spec-2 FR-225)

### 10.1 Model

A page is a React component whose props are plain JSON data. A **page registry** is shared by the server and the client:

```ts
// src/web/pages.ts
export const pages = definePages({ Home, Counter });
```

Server:

```ts
const react = createReactRenderer({ pages, assets });
app.get("/", () => react.render("Home", { message: "hi" }, { title: "Home" }));
//                                ^ key checked      ^ props type-checked against Home
```

Client (`src/web/client.tsx`):

```ts
hydratePage(pages);
```

### 10.2 Document

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" …><title>…escaped…</title></head>
<body>
  <div id="app">…streamed React output…</div>
  <script type="application/json" id="__HYDRATE__">{"page":"Home","props":{…}}</script>
  <script type="module" src="/assets/client-[hash].js"></script>
</body>
</html>
```

- React renders only into `#app`; the shell is a string. This avoids hydration mismatches on `<html>`/`<head>` and keeps the document small.
- The body is streamed with `renderToReadableStream` (Bun's native web streams). An error before the shell is ready becomes a normal 500 through the app error handler.
- **Payload safety (FR-225):** the JSON payload escapes `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX`. That makes `</script>` breakout impossible while `JSON.parse` stays exact. The title is HTML-escaped. This is a unit-tested contract.

### 10.3 Assets

`createAssets({ clientEntry, publicDir, manifestPath, mode })` returns `{ scripts, middleware }`:
- `development`: the client is built in memory with `Bun.build` at startup and served from memory under `/assets/`. No stale `dist/` can leak into dev, which was a latent issue in the old `index.tsx`.
- `production`: script URLs are read from `dist/manifest.json`, and files are served from `dist/public` with `cache-control: public, max-age=31536000, immutable` (file names are content-hashed).
- The mode comes from `NODE_ENV`, which the build inlines as `"production"`.

Client navigation is plain full-page loads in v0.1. A client router is a v0.5 concern (spec-1 roadmap).

---

## 11. Build (FR-210)

`hydrate build` (package `@bun-hydrate/cli`) reads `hydrate.config.ts`:

```ts
export default { server: "src/main.ts", client: "src/web/client.tsx", outDir: "dist" };
```

and produces:

```text
dist/
├── index.js          server bundle (target bun, minified, sourcemap linked)
├── public/assets/    client chunks, content-hashed
└── manifest.json     { "client": { "entry": "/assets/client-ab12.js" }, "builtAt": … }
```

- **Self-contained:** React and all framework code are bundled, and `process.env.NODE_ENV` is defined as `"production"` at bundle time. This fixes the root cause behind commit `3759704`: the JSX runtime was chosen by an env var at build time. `dist/` then runs with `bun dist/index.js` with no `node_modules`, so `build.sh` no longer needs `bun install --production` on the artifact.
- `hydrate dev` runs `bun --watch <server>` with `NODE_ENV=development`.
- `hydrate start` runs `bun <outDir>/index.js` with `NODE_ENV=production`.
- The contract with `deploy.sh` is unchanged: the artifact contains `dist/index.js`, and the app answers `GET /health` on `PORT`.

---

## 12. Testing (FR-200) and TDD workflow

`@bun-hydrate/testing`:

```ts
const client = createTestClient(app);
const res = await client.post("/users").json({ name: "Ada" }).header("x-request-id", "t-1");
expect(res.status).toBe(201);
expect(await res.json()).toEqual({ … });
```

It drives `app.fetch()` in process with no socket and no port (spec-2 §2.6), so tests run in parallel with no port conflicts. The request builder is thenable, so awaiting it sends the request.

Test layers, all on `bun test`:

| Layer | Where | What it proves |
|---|---|---|
| Unit | `packages/*/test/*.test.ts` | router matching, config parsing, error mapping, serializer, logger |
| Integration (in-process) | `packages/*/test`, `tests/app.test.ts` | the full pipeline through `app.fetch` via the test client |
| E2E (real socket) | `tests/e2e/server.test.ts` | `listen()`, signals/`stop()`, graceful drain, over real HTTP |
| E2E (built artifact) | `tests/e2e/build.test.ts` | `hydrate build` output runs as `bun dist/index.js` with no source tree; `/health`, SSR and assets work |
| E2E (browser) | `tests/e2e/browser.test.ts` | the built app hydrates in Chromium and becomes interactive |

TDD order: each module gets a failing test first, then the implementation, then refactoring with the tests green. Build order: errors → logger → config → router → context/response → app pipeline → lifecycle/health → static → testing client → react → cli/build → reference app → e2e.

---

## 13. Code standards

- `strict: true` TypeScript, ESM only, no default exports in packages (named exports make the public API explicit).
- No runtime dependencies in `@bun-hydrate/core`; `@bun-hydrate/react` depends only on `react`/`react-dom` as peers.
- Small files, each with one concept. Comments explain only *why*.
- Public API = what each package's `src/index.ts` exports. Everything else is internal and may change.
