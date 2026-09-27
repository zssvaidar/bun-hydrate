import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ASSETS_PREFIX, SAFE_MINIFY, bundleClient, writeManifest, type BuildManifest } from "@bun-hydrate/react";
import type { HydrateConfig } from "./config";

export interface BuildOptions {
  log?: (message: string) => void;
}

const SERVER_FILE = "index.js";

/**
 * Produces a self-contained dist/ (spec-3 §11): everything, React included, is bundled, so the
 * artifact runs as `bun dist/index.js` with no node_modules on the target.
 */
export async function build(config: HydrateConfig, options: BuildOptions = {}): Promise<BuildManifest> {
  const log = options.log ?? console.log;
  // Bun picks the JSX runtime (jsx vs jsxDEV) from NODE_ENV while transpiling, so it must be
  // "production" during the build itself, not only when the bundle later runs. Restored after.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return await buildProduction(config, log);
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
}

async function buildProduction(config: HydrateConfig, log: (message: string) => void): Promise<BuildManifest> {
  await rm(config.outDir, { recursive: true, force: true });

  let client: BuildManifest["client"];
  if (config.client) {
    log(`Building client  ${config.client}`);
    const bundle = await bundleClient({
      entry: config.client,
      production: true,
      outdir: join(config.outDir, "public", ASSETS_PREFIX),
    });
    client = { entry: bundle.entryUrl };
  }

  log(`Building server  ${config.server}`);
  await bundleServer(config.server, config.outDir);

  // Shipped with the artifact so a deployed app can migrate itself on start when configured to.
  if (existsSync(config.database.migrations)) {
    await cp(config.database.migrations, join(config.outDir, "migrations"), { recursive: true });
  }

  const manifest: BuildManifest = { builtAt: new Date().toISOString(), server: SERVER_FILE, client };
  await writeManifest(join(config.outDir, "manifest.json"), manifest);
  log(`Build complete   ${config.outDir}`);
  return manifest;
}

async function bundleServer(entry: string, outDir: string): Promise<void> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      outdir: outDir,
      target: "bun",
      minify: SAFE_MINIFY,
      sourcemap: "linked",
      naming: { entry: SERVER_FILE },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
  } catch (error) {
    throw new Error(`Server bundle failed for ${entry}`, { cause: error });
  }
  if (!result.success) throw new Error(`Server bundle failed for ${entry}:\n${result.logs.join("\n")}`);
}
