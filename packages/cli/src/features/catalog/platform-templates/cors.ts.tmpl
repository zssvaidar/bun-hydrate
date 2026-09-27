import { cors, defineConfig, env, type App } from "@bun-hydrate/core";

/**
 * Lets the browser apps in CORS_ORIGINS (comma-separated) call this API with cookies. If they
 * also POST with a session cookie, add them to csrf's allowedOrigins in src/auth/config.ts.
 */
export function installCors(app: App): void {
  const { origins } = defineConfig({ origins: env.string("CORS_ORIGINS").default("") });
  const allowed = origins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowed.length > 0) app.use(cors({ origin: allowed, credentials: true }));
}
