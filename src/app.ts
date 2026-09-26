import { App, createLogger, type Logger } from "@bun-hydrate/core";
import { createReactRenderer, type Assets } from "@bun-hydrate/react";
import type { AppConfig } from "./config";
import { systemRoutes } from "./modules/system/routes";
import { pages } from "./web/pages";
import { webRoutes } from "./web/routes";

export interface CreateAppOptions {
  config: AppConfig;
  assets: Assets;
  logger?: Logger;
}

/** Builds the application without starting it, so tests can drive it in process. */
export function createApp({ config, assets, logger }: CreateAppOptions): App {
  const app = new App({
    logger: logger ?? createLogger({ level: config.logLevel, format: config.logFormat }),
  });
  const react = createReactRenderer({ pages, assets, defaultTitle: "bun-hydrate" });

  return app.use(assets.middleware).route("/api", systemRoutes()).route("/", webRoutes(react));
}
