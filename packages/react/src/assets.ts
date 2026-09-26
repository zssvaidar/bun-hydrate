import { basename } from "node:path";
import { serveStatic, type Middleware } from "@bun-hydrate/core";
import { ASSETS_PREFIX, bundleClient } from "./bundle";
import { readManifest } from "./manifest";

export interface AssetsOptions {
  /** Browser entry, e.g. `src/web/client.tsx`. Bundled in memory in development. */
  clientEntry: string;
  /** Default: "production" when NODE_ENV is production, else "development". */
  mode?: "development" | "production";
  /** Built public files (production). Default: dist/public */
  publicDir?: string;
  /** Build manifest (production). Default: dist/manifest.json */
  manifestPath?: string;
}

export interface Assets {
  scripts: readonly string[];
  middleware: Middleware;
}

export async function createAssets(options: AssetsOptions): Promise<Assets> {
  const mode = options.mode ?? (process.env.NODE_ENV === "production" ? "production" : "development");
  return mode === "production" ? productionAssets(options) : developmentAssets(options.clientEntry);
}

/** Serves what `hydrate build` produced; file names are content-hashed, so they can be cached forever. */
async function productionAssets(options: AssetsOptions): Promise<Assets> {
  const manifest = await readManifest(options.manifestPath ?? "dist/manifest.json");
  const publicDir = options.publicDir ?? "dist/public";

  return {
    scripts: [manifest.client.entry],
    middleware: serveStatic({
      root: `${publicDir}${ASSETS_PREFIX}`,
      prefix: ASSETS_PREFIX,
      cacheControl: "public, max-age=31536000, immutable",
    }),
  };
}

/** Bundles fresh on every start, so a stale dist/ can never leak into development. */
async function developmentAssets(clientEntry: string): Promise<Assets> {
  const bundle = await bundleClient({ entry: clientEntry, production: false });
  const files = new Map(bundle.outputs.map((output) => [`${ASSETS_PREFIX}/${basename(output.path)}`, output]));

  return {
    scripts: [bundle.entryUrl],
    middleware: async (ctx, next) => {
      const file = ctx.method === "GET" || ctx.method === "HEAD" ? files.get(ctx.path) : undefined;
      if (!file) return next();
      return new Response(file, { headers: { "content-type": file.type, "cache-control": "no-cache" } });
    },
  };
}
