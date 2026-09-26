import { join } from "node:path";
import { ConfigError } from "@bun-hydrate/core";
import { createAssets } from "@bun-hydrate/react";
import { createApp } from "./app";
import { loadConfig, type AppConfig } from "./config";

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

// import.meta.dir is src/ in development and dist/ in the built bundle, so the production
// assets resolve next to dist/index.js whatever directory the process is started from.
const assets = await createAssets({
  clientEntry: join(import.meta.dir, "web/client.tsx"),
  publicDir: join(import.meta.dir, "public"),
  manifestPath: join(import.meta.dir, "manifest.json"),
});

await createApp({ config, assets }).listen({ port: config.port, hostname: config.host });
