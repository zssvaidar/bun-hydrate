import { Router } from "@bun-hydrate/core";

export function systemRoutes(): Router {
  return new Router().get("/time", () => ({ time: new Date().toISOString() }));
}
