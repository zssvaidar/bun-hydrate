import { defineConfig, env, type App } from "@bun-hydrate/core";
import { createMetrics } from "@bun-hydrate/observability";

/**
 * Prometheus metrics at GET /metrics: request counts and durations by route, plus process
 * metrics. Scrapers send `Authorization: Bearer $METRICS_TOKEN`. In production, /metrics is only
 * served when METRICS_TOKEN is set, so route names and load never leak by default.
 */
export function installMetrics(app: App): void {
  const { token } = defineConfig({ token: env.string("METRICS_TOKEN").optional() });
  const metrics = createMetrics();
  app.use(metrics.http());
  app.onStop(() => metrics.close());

  if (!token && process.env.NODE_ENV === "production") {
    app.logger.warn("METRICS_TOKEN is not set; /metrics is not served");
    return;
  }
  app.get("/metrics", metrics.endpoint({ token }));
}
