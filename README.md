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
| `@bun-hydrate/observability` | Prometheus metrics: HTTP by route, process, cache, rate limits, query timing, jobs, events, fan-out, storage |
| `@bun-hydrate/redis` | One Redis per process: shared command client, subscriber connection, key prefixing, clean shutdown |
| `@bun-hydrate/queue` | Background jobs: `defineJob`, dispatch (transactional with the database queue), workers with leases, retries, timeouts and cron; memory, database and Redis adapters |
| `@bun-hydrate/events` | Typed events: in-process listeners after commit, durable listeners as jobs, broadcasts across instances |
| `@bun-hydrate/storage` | Files: memory, local disk (signed URLs) and S3 adapters behind one `Storage` interface |
| `@bun-hydrate/testing` | In-process HTTP test client with a cookie jar, `spawnServer`, `connectWebSocket`, `createTestDatabase`, auth helpers, `createTestQueue`, queue and storage contract suites, a fake S3 |
| `@bun-hydrate/cli` | `hydrate dev \| worker \| build \| start \| generate \| db:*` and feature orchestration: `features \| add \| remove \| doctor \| sync` |

The kernel also covers:
- trusted proxies (`ctx.ip`, `ctx.protocol`), cookies, security headers (on by default) and CORS;
- W3C trace context, carried into jobs and event listeners;
- WebSocket routes with fan-out across instances;
- request body limits and checked file uploads.

The design lives in [`docs/design`](docs/design): spec-2 is the gap analysis, spec-3 the kernel, spec-4 the backend foundation (validation, DI, database) spec-5 production concerns (auth, caching, rate limits, metrics, WebSockets, feature orchestration) and spec-6 distributed systems (jobs, workers, events, storage, uploads, fan-out).

## Quick start

```bash
bun install
cp .env.example .env
bun run dev          # http://localhost:3000, reloads on change
```

| Command | What it does |
|---|---|
| `bun run dev` | Runs `src/main.ts` with `NODE_ENV=development`, client bundled in memory |
| `bun hydrate worker` | Runs `src/worker.ts` (jobs and durable listeners) with reload on change |
| `bun run build` | Writes a self-contained `dist/` (`index.js`, `worker.js`, `public/assets/*`, `manifest.json`) |
| `bun run start` | Runs `dist/index.js` with `NODE_ENV=production` |
| `bun test` | Unit, integration and end-to-end tests (see below) |
| `bun hydrate generate module <name> [--auth]` | Scaffold a module (schema, repository, service, controller, routes, test) and its migration; `--auth` guards its routes with permissions |
| `bun hydrate generate job \| event \| listener` | A job and its test, a typed event, or a listener (`--durable` runs it as a job); the registries regenerate |
| `bun hydrate jobs:status` / `jobs:dead` / `jobs:retry` / `jobs:purge` / `jobs:dispatch` | Inspect and operate the job queue |
| `bun hydrate add <feature>` / `remove` / `features` / `doctor` / `sync` | Add or remove capabilities such as auth, metrics or rate limiting (see below) |
| `bun hydrate db:migrate` / `db:rollback` / `db:status` / `db:seed` | Manage the database named by `DATABASE_URL` |
| `bun run typecheck` | Strict TypeScript check |

The built `dist/` needs no `node_modules`, so `bun dist/index.js` and `bun dist/worker.js` run anywhere Bun is installed. The deploy scripts (`build.sh`, `deploy.sh`, `Jenkinsfile`) rely on this. [`docs/deploy`](docs/deploy) has a systemd unit for the worker, a Dockerfile, a Docker Compose file with two web instances, a worker, Postgres and Redis, and a [`Caddyfile`](docs/deploy/Caddyfile) for running behind Caddy (HTTPS, compression, optionally serving `/assets` from disk).

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
| `redis` | One shared `AppRedis` connection; `cache:redis`, `jobs:redis` and `realtime:redis` use it |
| `jobs:database`, `jobs:redis` | `AppQueue`, the `hydrate_jobs` table (database), `src/worker.ts`, generated `src/jobs/index.ts`, `jobs:*` commands |
| `events` | `AppEvents`, generated `src/events/index.ts`; needs a jobs feature for durable listeners |
| `storage:local`, `storage:s3` | `AppStorage`; local files are served through signed `/files` URLs |
| `realtime:redis` | `app.publish()` reaches WebSocket clients on every instance |
| `styles:sass` | `.scss`/`.sass` in the client bundle through Dart Sass, a starter `src/web/styles/app.scss`, generated `src/web/client.plugins.ts` |

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

Signed-in users can also chat at `/ws/rooms/:room`. With `REDIS_URL` set, messages reach members connected to any instance.

For v0.4 it added `bun hydrate add jobs:database events storage:local` and generated:
- the `account.registered` event;
- a durable `welcome-email` listener;
- the `send-welcome-email` and `cleanup-expired-sessions` jobs.

With these in place:
- Registering emits the event in the same transaction that creates the account.
- The worker then mails through a `LogMailer`, which appends to `data/outbox.jsonl`.
- Expired sessions are deleted hourly.
- `PUT /api/v1/users/me/avatar` stores an avatar, and the home page shows it through a signed URL.

## Jobs, events and files

```ts
// src/jobs/send-welcome-email.job.ts (bun hydrate generate job send-welcome-email)
export const sendWelcomeEmailJob = defineJob({
  name: "send-welcome-email",
  payload: schema.object({ accountId: schema.string(), email: schema.email() }),
  retry: { attempts: 5 },           // exponential backoff from 10s
  inject: [Mailer],
  async handle({ email }, { services: [mailer], job }) {
    await mailer.send({ to: email, subject: "Welcome", text: "…" }); // job.signal aborts on timeout and shutdown
  },
});

// anywhere: with the database queue, the job commits or rolls back with the transaction
await db.transaction(async () => {
  const account = await accounts.create(input);
  await events.emit(AccountRegistered, { accountId: account.id, email: account.email });
});
```

How they run:
- **Workers are a separate process** (`src/worker.ts`). They claim only jobs they have handlers for, hold them under a lease that is renewed while they run, and retry failures with backoff. Jobs out of attempts become dead jobs, which `hydrate jobs:dead` and `jobs:retry` show and revive. On SIGTERM a worker finishes or releases its jobs and exits 0.
- **Cron.** `worker.schedule(job, "17 * * * *")` runs once per slot, however many workers there are.
- **Events.**
  - In-process listeners run after the emitting transaction commits.
  - Durable listeners (`--durable`) are jobs, run at least once on any worker.
  - `events.broadcast()` reaches every instance when the bus has a transport such as Redis.
- **Uploads.** `ctx.upload("avatar", { types: ["image/png", "image/jpeg"], maxSize: "2mb" })` checks the file's bytes, not its name or declared type. Bodies over `MAX_BODY_SIZE` get a 413 before they are read.
- **Storage.** `storage.put(key, file)` stores a file and `storage.signedUrl(key, { expiresIn: "10m" })` gives a URL for it. Served files get `nosniff`, a sandboxing CSP, and a download disposition for anything that could render as a page.

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

### Stylesheets

Import CSS from the client entry, and every page links the result from `<head>`, so server-rendered HTML is styled before any script runs:

```ts
// src/web/client.tsx
import "./styles/app.css";
```

Bun's bundler handles the CSS: `@import`, nesting and modern syntax are bundled and lowered, and `hydrate build` writes one minified, content-hashed stylesheet that `dist/manifest.json` lists under `client.styles`. In development, stylesheets are not modules the server imports, so `hydrate dev` cannot restart for them; instead the next request rebundles when any bundled file has changed, and a stylesheet that fails to compile shows its error in place of the page.

For Sass, `bun hydrate add styles:sass`, then follow the steps it prints: `bun add -d sass-embedded`, and pass the generated `clientPlugins` to both `hydrate.config.ts` and `createAssets({ plugins })`. Sass runs only while bundling (partials included in the change tracking), so `dist/` still needs no `node_modules`. A `.scss` import without the plugin fails the bundle rather than shipping uncompiled Sass.

CSS Modules (`*.module.css`) are not supported yet: during development the server renders them with empty class names.

## Tests

```bash
bun test                  # everything
bun test packages         # framework unit + integration tests
bun test tests            # reference app, incl. end-to-end
```

Set `TEST_POSTGRES_URL` (a disposable Postgres database) and `TEST_REDIS_URL` to also run the database, cache, rate-limit, queue and fan-out tests against real servers. `TEST_S3_URL` runs the storage contract against a real S3-compatible store; otherwise it runs against a built-in fake.

The end-to-end tests cover four things:
- They start the real dev server and verify SIGTERM gives a graceful exit 0.
- They build with the real CLI, copy only `dist/` into an empty directory, and run it the way production does.
- They run the worker as a separate process from `dist/`: registration mail arrives, SIGTERM exits 0, and mail queued while no worker ran is delivered after a restart. With Redis, a chat message crosses two web instances.
- They drive Chromium to check that pages hydrate and become interactive, render signed in with no flash, show admin controls only to admins, sign in under the default CSP, and sync logout across tabs. This suite is skipped when no Playwright Chromium is installed; install it with `bunx playwright-core install chromium`.

Generated code is tested too: every feature and preset is added to a scratch project, which must type-check and pass its own generated tests, and is then removed step by step.

## Configuration

See [`.env.example`](.env.example). Configuration is validated at startup. Every problem is reported at once, including hints for case mismatches such as `port` vs `PORT`.
