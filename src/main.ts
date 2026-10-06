import { join } from "node:path";
import { ConfigError } from "@bun-hydrate/core";
import { Migrator, createDatabase } from "@bun-hydrate/database";
import { createAssets } from "@bun-hydrate/react";
import { createApp } from "./app";
import { loadConfig, type AppConfig } from "./config";
import { clientPlugins } from "./web/client.plugins";

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

const config = loadConfigOrExit();

// import.meta.dir is src/ in development and dist/ in the built bundle. `hydrate build` puts the
// client assets and migrations next to dist/index.js, so they resolve from any working directory.
const isBuilt = process.env.NODE_ENV === "production";
const migrationsDir = isBuilt ? join(import.meta.dir, "migrations") : join(import.meta.dir, "../migrations");

const assets = await createAssets({
  clientEntry: join(import.meta.dir, "web/client.tsx"),
  publicDir: join(import.meta.dir, "public"),
  manifestPath: join(import.meta.dir, "manifest.json"),
  plugins: clientPlugins,
});

const db = createDatabase({ url: config.databaseUrl });
// An in-memory database starts empty, so it is always migrated; real databases only on request.
const migrateOnStart = config.migrateOnStart || config.databaseUrl === "sqlite://:memory:";

const app = createApp({ config, assets, db }).onStart(async () => {
  if (migrateOnStart) {
    const applied = await new Migrator({ db, directory: migrationsDir }).migrate();
    if (applied.length > 0) app.logger.info("Migrations applied", { migrations: applied });
  }
  return () => db.close();
});

await app.listen({ port: config.port, hostname: config.host });
