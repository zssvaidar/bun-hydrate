import { Router } from "@bun-hydrate/core";
import type { ReactRenderer } from "@bun-hydrate/react";
import type { pages } from "./pages";

export function webRoutes(react: ReactRenderer<typeof pages>): Router {
  return new Router()
    .get("/", () => react.render("Home", { initialCount: 0 }, { title: "bun-hydrate" }))
    .get("/page/:id", (ctx) => react.render("PageDetail", { id: ctx.params.id }, { title: `Page ${ctx.params.id}` }));
}
