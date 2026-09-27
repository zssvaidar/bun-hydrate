import { defineAuthFeature } from "@bun-hydrate/auth";
import { loginRoutes } from "./login.routes";

/** Where the login routes are mounted; the browser's auth client uses the same path. */
export const AUTH_BASE_PATH = "/api/v1/auth";

export const loginFeature = defineAuthFeature({
  id: "auth:login",
  requires: ["auth:passwords", ["auth:sessions", "auth:jwt"]],
  routes: (container) => [{ path: AUTH_BASE_PATH, router: loginRoutes(container) }],
});
