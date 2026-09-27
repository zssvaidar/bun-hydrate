import { defineConfig, env, type App } from "@bun-hydrate/core";
import { rateLimit } from "@bun-hydrate/rate-limit";

/**
 * An app-wide limit per client IP (RATE_LIMIT_PER_MINUTE, default 300). Behind a proxy, set
 * TRUST_PROXY so the IP is the client's, not the proxy's. For several instances, pass
 * `store: new RedisRateLimitStore(...)` so they share one count.
 */
export function installRateLimit(app: App): void {
  const { limit } = defineConfig({ limit: env.integer("RATE_LIMIT_PER_MINUTE").default(300) });
  app.use(rateLimit({ name: "global", limit, window: "1m" }));
}
