import { defineConfig, env, type EnvSource } from "@bun-hydrate/core";

export function loadConfig(source: EnvSource = process.env) {
  return defineConfig(
    {
      port: env.port("PORT").default(3000),
      host: env.string("HOST").default("0.0.0.0"),
      logLevel: env.enum("LOG_LEVEL", ["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
      logFormat: env.enum("LOG_FORMAT", ["json", "pretty"]).optional(),
      databaseUrl: env.string("DATABASE_URL").default("sqlite://:memory:"),
      migrateOnStart: env.boolean("MIGRATE_ON_START").default(false),
    },
    source,
  );
}

export type AppConfig = ReturnType<typeof loadConfig>;
