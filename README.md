# bun-hydrate

A Bun-native application framework for TypeScript backends and server-rendered, hydrated React apps.

This repository contains the framework packages and a reference application built with them.

| Package | Purpose |
|---|---|
| `@bun-hydrate/core` | App, router, context, middleware, errors, typed config, lifecycle, logging, health checks, static files |
| `@bun-hydrate/react` | Streaming SSR, safe hydration payload, dev/production asset handling |
| `@bun-hydrate/testing` | In-process HTTP test client and a real-process `spawnServer` helper |
| `@bun-hydrate/cli` | `hydrate dev`, `hydrate build`, `hydrate start` |

The design lives in [`docs/design`](docs/design): spec-2 is the gap analysis, and spec-3 is the kernel design this code implements.

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

The end-to-end tests cover three things:
- They start the real dev server and verify SIGTERM gives a graceful exit 0.
- They build with the real CLI, copy only `dist/` into an empty directory, and run it the way production does.
- They drive Chromium to check the page hydrates and becomes interactive. This suite is skipped when no Playwright Chromium is installed; install it with `bunx playwright-core install chromium`.

## Configuration

See [`.env.example`](.env.example). Configuration is validated at startup. Every problem is reported at once, including hints for case mismatches such as `port` vs `PORT`.
