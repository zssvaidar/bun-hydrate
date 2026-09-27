# bun-hydrate

A Bun-native application framework for TypeScript backends and server-rendered, hydrated React apps.

This repository contains the framework packages and a reference application built with them.

| Package | Purpose |
|---|---|
| `@bun-hydrate/core` | App, router, context, middleware, errors, typed config, lifecycle, logging, health checks, static files |
| `@bun-hydrate/react` | Streaming SSR, safe hydration payload, dev/production asset handling |
| `@bun-hydrate/validation` | Schema builder (Standard Schema v1, so Zod/Valibot/ArkType also work) and typed `validate()` for routes |
| `@bun-hydrate/di` | Explicit, type-checked dependency injection with singleton/scoped/transient lifetimes |
| `@bun-hydrate/database` | Bun.SQL (Postgres/MySQL/SQLite) with ambient transactions, error mapping and SQL migrations |
| `@bun-hydrate/auth` | Passwords (argon2id), sessions, CSRF, JWT, OIDC bearer tokens, API keys, permissions and policies, `createAuth` |
| `@bun-hydrate/cache` | JSON cache with memory (LRU + TTL) and Redis adapters, single-flight `remember()` |
| `@bun-hydrate/rate-limit` | Sliding-window limits with `RateLimit` headers, memory and Redis stores |
| `@bun-hydrate/observability` | Prometheus metrics: HTTP by route, process, cache, rate limits, query timing |
| `@bun-hydrate/testing` | In-process HTTP test client with a cookie jar, `spawnServer`, `connectWebSocket`, `createTestDatabase`, auth helpers |
| `@bun-hydrate/cli` | `hydrate dev \| build \| start \| generate \| db:*` and feature orchestration: `features \| add \| remove \| doctor \| sync` |

The kernel also covers trusted proxies (`ctx.ip`, `ctx.protocol`), cookies, security headers (on by default), CORS, W3C trace context and WebSocket routes.

The design lives in [`docs/design`](docs/design): spec-2 is the gap analysis, spec-3 the kernel, spec-4 the backend foundation (validation, DI, database) and spec-5 production concerns (auth, caching, rate limits, metrics, WebSockets, feature orchestration).

## Quick start

```bash
bun install
cp .env.example .env
bun run dev          # http://localhost:3000, reloads on change
```

| Command | What it does |
|---|---|
| `bun run dev` | Runs `src/main.ts` with `NODE_ENV=development`, client bundled in memory |
| `bun run build` | Writes a self-contained `dist/` (`index.js`, `public/assets/*`, `manifest.json`) |
| `bun run start` | Runs `dist/index.js` with `NODE_ENV=production` |
| `bun test` | Unit, integration and end-to-end tests (see below) |
| `bun hydrate generate module <name> [--auth]` | Scaffold a module (schema, repository, service, controller, routes, test) and its migration; `--auth` guards its routes with permissions |
| `bun hydrate add <feature>` / `remove` / `features` / `doctor` / `sync` | Add or remove capabilities such as auth, metrics or rate limiting (see below) |
| `bun hydrate db:migrate` / `db:rollback` / `db:status` / `db:seed` | Manage the database named by `DATABASE_URL` |
| `bun run typecheck` | Strict TypeScript check |

The built `dist/` needs no `node_modules`, so `bun dist/index.js` runs anywhere Bun is installed. The deploy scripts (`build.sh`, `deploy.sh`, `Jenkinsfile`) rely on this.

## A minimal app

```ts
import { App, NotFoundError, Router } from "@bun-hydrate/core";

const users = new Router().get("/:id", (ctx) => {
  if (ctx.params.id !== "1") throw new NotFoundError("User not found", { code: "USER_NOT_FOUND" });
  return { id: ctx.params.id, name: "Ada" }; // objects become JSON
});

const app = new App()
  .use(async (ctx, next) => {
    const res = await next(); // always a Response, even when a handler threw
    res.headers.set("x-powered-by", "bun-hydrate");
    return res;
  })
  .route("/api/users", users)
  .onStart(async () => {
    const db = await connect();  // hypothetical: any resource your app opens
    return () => db.close();     // cleanup runs on shutdown, or if a later start hook fails
  });

await app.listen({ port: 3000 }); // SIGTERM/SIGINT → graceful drain → stop hooks
```

Every app gets these defaults:
- `/health` (liveness) and `/ready` (running and all `app.readinessCheck()`s pass).
- An `x-request-id` on every response, also bound into `ctx.log`.
- JSON request logs.
- Errors in the form `{ "error": { "code", "message", "requestId" } }`. 5xx details are never exposed in production.

## Modules, validation, DI and the database

The reference `users` module (`src/modules/users`, served at `/api/v1/users`) shows the full path from route to database:

```ts
// users.controller.ts — typed, validated input; every issue reported at once as a 422
readonly create = validate({ body: CreateUserBody }, async (ctx, { body }) => {
  const user = await this.users.create(body);
  ctx.status(201).header("location", `/api/v1/users/${user.id}`);
  return user;
});

// users.service.ts — dependencies declared once and checked against the constructor by tsc
static readonly inject = [UsersRepository, Database, Clock] as const;

update(id: string, changes: UpdateUser) {
  return this.db.transaction(async () => {   // repositories using db.sql join this transaction
    await this.get(id);
    await this.users.update(id, changes);
    return this.get(id);
  });
}
```

Migrations are plain SQL files in `migrations/`, with `-- migrate:up` and `-- migrate:down` sections. `DATABASE_URL` defaults to an in-memory SQLite database that is migrated on start, so the app runs with zero setup.

## Features: add and remove capabilities

Auth, caching, rate limiting, metrics and CORS are **features** that the CLI adds and removes. It resolves their dependencies, writes their files and migrations, and keeps the wiring correct:

```bash
bun hydrate features                   # what exists, what is installed
bun hydrate add auth                   # preset: core, passwords, sessions, login, react, ui-login
bun hydrate add auth:api-keys --dry-run  # show the plan only
bun hydrate remove auth:ui-login       # deletes its files unless you edited them
bun hydrate doctor                     # edited/missing files, unset env, unapplied migrations
```

Every `add` shows its plan before writing anything and applies it all-or-nothing. The rules for `remove`:
- It deletes a generated file only if you haven't edited it. Edited files are kept and reported, unless you pass `--force`.
- It never deletes a migration. It writes a new one that keeps the feature's tables and data, unless you pass `--drop-data`.

Who owns which file:
- `hydrate.features.json` records what is installed.
- Files marked "generated", such as `src/auth/index.ts` and `src/platform/index.ts`, belong to the CLI. `hydrate sync` restores them.
- `src/auth/config.ts` is yours from the start: roles, policies, what the browser may see.
- Every other generated file becomes yours once created.

| Feature | Provides |
|---|---|
| `auth:core` | Accounts, principals, `src/shared/permissions.ts` (one typed list for server and browser), `installAuth()` |
| `auth:passwords`, `auth:sessions`, `auth:jwt`, `auth:oidc`, `auth:api-keys` | Credentials; sessions include CSRF protection |
| `auth:login` | `/api/v1/auth/register`, `/login` (brute-force limited), `/logout`, `/me` |
| `auth:react`, `auth:ui-login`, `auth:ui-register`, `auth:ui-account` | `AuthProvider`, `useAuth`, `useCan`, `<Can>`, and pages |
| `metrics`, `security:cors`, `rate-limit`, `cache:memory`, `cache:redis` | Wired through one generated `installPlatform()` |

Operational commands come with the features that need them. They run the app's own code against `DATABASE_URL`:

```bash
echo "$ADMIN_PASSWORD" | bun hydrate auth:create-user --email admin@example.com --role admin --password-stdin
bun hydrate auth:set-role --email ada@example.com --role admin   # also ends her sessions
bun hydrate auth:api-key create --name ci --permissions reports.read   # the key is shown once
bun hydrate auth:permissions                                      # role × permission matrix
```

Passwords are read at a hidden prompt or from stdin, never from arguments, because arguments end up in shell history and the process list.

## Auth in the reference app

The reference app's auth was generated with `bun hydrate add auth metrics security:cors rate-limit` and then wired by hand, as the command printed:

```ts
// src/app.ts
installPlatform(app, container); // metrics, CORS, global rate limit
installAuth(app, container);     // authenticate(), csrf(), /api/v1/auth routes

// routes check permissions; the same names type-check in React
.get("/", requirePermission("users.read"), controller.list)
```

```tsx
// any page: signed in from the first server-rendered byte, no flash
const { user, logout } = useAuth();
<Can permission="users.delete"><AdminTools /></Can>
```

Signed-in users can also chat at `/ws/rooms/:room`.

## Server-rendered React

```ts
// src/web/pages.ts — shared by server and browser
export const pages = definePages({ Home, PageDetail });

// server
const react = createReactRenderer({ pages, assets: await createAssets({ clientEntry: "src/web/client.tsx" }) });
app.get("/page/:id", (ctx) => react.render("PageDetail", { id: ctx.params.id }, { title: "Detail" }));

// src/web/client.tsx
hydratePage(pages);
```

Page names and props are type-checked. The hydration payload is escaped so props cannot break out of the `<script>` tag.

## Tests

```bash
bun test                  # everything
bun test packages         # framework unit + integration tests
bun test tests            # reference app, incl. end-to-end
```

Set `TEST_POSTGRES_URL` (a disposable Postgres database) and `TEST_REDIS_URL` to also run the database, cache and rate-limit tests against real servers.

The end-to-end tests cover three things:
- They start the real dev server and verify SIGTERM gives a graceful exit 0.
- They build with the real CLI, copy only `dist/` into an empty directory, and run it the way production does.
- They drive Chromium to check that pages hydrate and become interactive, render signed in with no flash, show admin controls only to admins, sign in under the default CSP, and sync logout across tabs. This suite is skipped when no Playwright Chromium is installed; install it with `bunx playwright-core install chromium`.

Generated code is tested too: every feature and preset is added to a scratch project, which must type-check and pass its own generated tests, and is then removed step by step.

## Configuration

See [`.env.example`](.env.example). Configuration is validated at startup. Every problem is reported at once, including hints for case mismatches such as `port` vs `PORT`.
