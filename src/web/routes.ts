import { Router, type Context } from "@bun-hydrate/core";
import type { ReactRenderer } from "@bun-hydrate/react";
import { authPageRoutes } from "./auth-pages";
import type { pages } from "./pages";

/** Every render gets `ctx`, so the signed-in user is in the first HTML and the hydration payload. */
export function webRoutes(react: ReactRenderer<typeof pages>, avatarUrl: (ctx: Context<any>) => Promise<string | undefined>): Router {
  const router = new Router()
    .get("/", async (ctx) => react.render("Home", { initialCount: 0, avatarUrl: await avatarUrl(ctx) }, { title: "bun-hydrate", ctx }))
    .get("/page/:id", (ctx) => react.render("PageDetail", { id: ctx.params.id }, { title: `Page ${ctx.params.id}`, ctx }));
  for (const page of authPageRoutes) router.get(page.path, (ctx) => react.render(page.name, {}, { title: page.title, ctx }));
  return router;
}
