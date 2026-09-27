import { App, createLogger, type Logger } from "@bun-hydrate/core";
import type { Database } from "@bun-hydrate/database";
import { createReactRenderer, type Assets } from "@bun-hydrate/react";
import { createRedis, redisPubSub } from "@bun-hydrate/redis";
import { authShared, installAuth } from "./auth";
import type { AppConfig } from "./config";
import { createContainer } from "./container";
import { avatarRoutes, avatarUrlFor } from "./modules/avatars/avatars";
import { roomsWebSocket } from "./modules/rooms/rooms";
import { systemRoutes } from "./modules/system/routes";
import { usersModule } from "./modules/users/users.module";
import { installPlatform } from "./platform";
import { wrapAuth } from "./web/auth";
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
  const container = createContainer({ config, db });
  const react = createReactRenderer({ pages, assets, defaultTitle: "bun-hydrate", shared: authShared, wrap: wrapAuth });

  const app = new App({
    logger: logger ?? createLogger({ level: config.logLevel, format: config.logFormat }),
    trustProxy: config.trustProxy,
  })
    .readinessCheck("database", () => db.ping())
    .use(assets.middleware);

  // With REDIS_URL, app.publish() reaches chat clients on every instance; without it, this one.
  if (config.redisUrl) {
    const redis = createRedis({ url: config.redisUrl, prefix: config.redisPrefix });
    app.usePubSub(redisPubSub(redis)).readinessCheck("redis", () => redis.ping()).onStop(() => redis.close());
  }

  // Metrics, CORS and the global rate limit first, then authentication and CSRF, then routes.
  installPlatform(app, container);
  installAuth(app, container);

  return roomsWebSocket(app)
    .route("/api/v1", systemRoutes())
    .route("/api/v1/users/me/avatar", avatarRoutes(container))
    .route("/api/v1/users", usersModule(container))
    .route("/", webRoutes(react, avatarUrlFor(container)));
}
