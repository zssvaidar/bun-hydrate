import { App, createLogger, type Logger } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { createReactRenderer, type Assets } from "@bun-hydrate/react";
import type { AppConfig } from "./config";
import { systemRoutes } from "./modules/system/routes";
import { usersModule } from "./modules/users/users.module";
import { Clock } from "./shared/clock";
import { pages } from "./web/pages";
import { webRoutes } from "./web/routes";

export interface CreateAppOptions {
  config: AppConfig;
  assets: Assets;
  db: Database;
  logger?: Logger;
}

/** Builds the application without starting it, so tests can drive it in process. */
export function createApp({ config, assets, db, logger }: CreateAppOptions): App {
  const container = new Container().value(Database, db).value(Clock, () => new Date());
  const react = createReactRenderer({ pages, assets, defaultTitle: "bun-hydrate" });

  return new App({ logger: logger ?? createLogger({ level: config.logLevel, format: config.logFormat }) })
    .readinessCheck("database", () => db.ping())
    .use(assets.middleware)
    .route("/api/v1", systemRoutes())
    .route("/api/v1/users", usersModule(container))
    .route("/", webRoutes(react));
}
