import { defineFeature, type FeatureOutput, type Slots } from "../define";
import { generatedHeader, renderImports, type NamedImport } from "./render";
import cacheMemoryTest from "./platform-templates/cache-memory.test.ts.tmpl" with { type: "text" };
import cacheMemory from "./platform-templates/cache-memory.ts.tmpl" with { type: "text" };
import cacheRedisTest from "./platform-templates/cache-redis.test.ts.tmpl" with { type: "text" };
import cacheRedis from "./platform-templates/cache-redis.ts.tmpl" with { type: "text" };
import corsTest from "./platform-templates/cors.test.ts.tmpl" with { type: "text" };
import cors from "./platform-templates/cors.ts.tmpl" with { type: "text" };
import metricsTest from "./platform-templates/metrics.test.ts.tmpl" with { type: "text" };
import metrics from "./platform-templates/metrics.ts.tmpl" with { type: "text" };
import rateLimitTest from "./platform-templates/rate-limit.test.ts.tmpl" with { type: "text" };
import rateLimit from "./platform-templates/rate-limit.ts.tmpl" with { type: "text" };

/** cache, rate-limit, metrics and CORS (spec-5 §9.7), wired by one generated installPlatform(). */

/** Slot `platform.install`: one call in installPlatform(), run in `order` (lowest first). */
interface PlatformInstall extends NamedImport {
  call: string;
  order: number;
}

/** Declared by every platform feature: it exists while any of them is installed. */
const platformRoot: FeatureOutput = {
  kind: "file",
  path: "src/platform/index.ts",
  render(slots: Slots) {
    const installs = slots.get<PlatformInstall>("platform.install").toSorted((a, b) => a.order - b.order);
    return [
      generatedHeader("Each capability lives in its own file next to it."),
      'import type { App } from "@bun-hydrate/core";',
      'import type { Container } from "@bun-hydrate/di";',
      ...renderImports(installs),
      "",
      "/** Call once in src/app.ts, before installAuth() and your routes: installPlatform(app, container). */",
      "export function installPlatform(app: App, container: Container): void {",
      ...installs.map((install) => `  ${install.call};`),
      "}",
      "",
    ].join("\n");
  },
};

const WIRING = 'Once, in src/app.ts: import { installPlatform } from "./platform"; call installPlatform(app, container) before installAuth() and your routes';

export const platformFeatures = [
  defineFeature({
    id: "metrics",
    description: "Prometheus metrics at /metrics (HTTP by route, process), behind METRICS_TOKEN",
    files: { "src/platform/metrics.ts": metrics, "src/platform/metrics.test.ts": metricsTest },
    env: [{ name: "METRICS_TOKEN", description: "Bearer token scrapers send to GET /metrics (required in production)" }],
    contributes: { "platform.install": [{ from: "./metrics", name: "installMetrics", call: "installMetrics(app)", order: 10 }] },
    outputs: [platformRoot],
    instructions: [WIRING],
  }),
  defineFeature({
    id: "security:cors",
    description: "CORS for the browser apps listed in CORS_ORIGINS",
    files: { "src/platform/cors.ts": cors, "src/platform/cors.test.ts": corsTest },
    env: [{ name: "CORS_ORIGINS", description: "Comma-separated origins allowed to call the API with cookies" }],
    contributes: { "platform.install": [{ from: "./cors", name: "installCors", call: "installCors(app)", order: 20 }] },
    outputs: [platformRoot],
    instructions: [WIRING],
  }),
  defineFeature({
    id: "rate-limit",
    description: "App-wide rate limit per client IP (RATE_LIMIT_PER_MINUTE)",
    files: { "src/platform/rate-limit.ts": rateLimit, "src/platform/rate-limit.test.ts": rateLimitTest },
    env: [{ name: "RATE_LIMIT_PER_MINUTE", description: "Requests per minute per client IP (default 300)" }],
    contributes: {
      "platform.install": [{ from: "./rate-limit", name: "installRateLimit", call: "installRateLimit(app)", order: 30 }],
    },
    outputs: [platformRoot],
    instructions: [WIRING],
  }),
  defineFeature({
    id: "cache:memory",
    description: "In-process LRU cache as AppCache in the container",
    conflicts: ["cache:redis"],
    files: { "src/platform/cache.ts": cacheMemory, "src/platform/cache.test.ts": cacheMemoryTest },
    contributes: { "platform.install": [{ from: "./cache", name: "installCache", call: "installCache(container)", order: 40 }] },
    outputs: [platformRoot],
    instructions: [WIRING],
  }),
  defineFeature({
    id: "cache:redis",
    description: "Redis cache as AppCache in the container, with a readiness check",
    conflicts: ["cache:memory"],
    files: { "src/platform/cache.ts": cacheRedis, "src/platform/cache.test.ts": cacheRedisTest },
    env: [{ name: "REDIS_URL", description: "redis://… for the cache", required: true }],
    contributes: {
      "platform.install": [{ from: "./cache", name: "installCache", call: "installCache(app, container)", order: 40 }],
    },
    outputs: [platformRoot],
    instructions: [WIRING],
  }),
];
