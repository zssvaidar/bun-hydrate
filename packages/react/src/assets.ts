import { statSync } from "node:fs";
import { basename } from "node:path";
import { serveStatic, type Middleware } from "@bun-hydrate/core";
import { ASSETS_PREFIX, bundleClient, type ClientBundle, type ClientPlugin } from "./bundle";
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
  /** Bun plugins for the development bundle, e.g. sassPlugin(); the same list as `clientPlugins` in hydrate.config.ts. */
  plugins?: readonly ClientPlugin[];
}

export interface Assets {
  scripts: readonly string[];
  /** Stylesheets for <link> tags in <head>. In development they change when the bundle is rebuilt. */
  styles: readonly string[];
  middleware: Middleware;
}

export async function createAssets(options: AssetsOptions): Promise<Assets> {
  const mode = options.mode ?? (process.env.NODE_ENV === "production" ? "production" : "development");
  return mode === "production" ? productionAssets(options) : developmentAssets(options.clientEntry, options.plugins);
}

/** Serves what `hydrate build` produced; file names are content-hashed, so they can be cached forever. */
async function productionAssets(options: AssetsOptions): Promise<Assets> {
  const manifestPath = options.manifestPath ?? "dist/manifest.json";
  const manifest = await readManifest(manifestPath);
  if (!manifest.client) {
    throw new Error(`${manifestPath} has no client bundle. Set \`client\` in hydrate.config.ts and rebuild.`);
  }
  const publicDir = options.publicDir ?? "dist/public";

  return {
    scripts: [manifest.client.entry],
    styles: manifest.client.styles ?? [],
    middleware: serveStatic({
      root: `${publicDir}${ASSETS_PREFIX}`,
      prefix: ASSETS_PREFIX,
      cacheControl: "public, max-age=31536000, immutable",
    }),
  };
}

interface DevBundle {
  bundle: ClientBundle;
  files: Map<string, ClientBundle["outputs"][number]>;
  /** Modification time of every input when it was bundled; -1 for a file that did not exist. */
  stamps: Map<string, number>;
}

const modifiedAt = (file: string) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? -1;

/**
 * Bundles fresh on every start, so a stale dist/ can never leak into development. `hydrate dev`
 * restarts the server when the modules it imports change, but stylesheets (and the client entry)
 * are only read by the bundler, so requests rebundle first when any bundled file has changed.
 */
async function developmentAssets(clientEntry: string, plugins: readonly ClientPlugin[] = []): Promise<Assets> {
  const bundleNow = async (): Promise<DevBundle> => {
    const bundle = await bundleClient({ entry: clientEntry, production: false, plugins });
    return {
      bundle,
      files: new Map(bundle.outputs.map((output) => [`${ASSETS_PREFIX}/${basename(output.path)}`, output])),
      stamps: new Map(bundle.inputs.map((file) => [file, modifiedAt(file)])),
    };
  };

  let current = await bundleNow();
  let rebuilding: Promise<void> | undefined;
  const isStale = () => [...current.stamps].some(([file, stamp]) => modifiedAt(file) !== stamp);
  // Concurrent requests share one rebuild; a failed one is retried by the next request.
  const refresh = () =>
    (rebuilding ??= bundleNow()
      .then((next) => void (current = next))
      .finally(() => (rebuilding = undefined)));

  return {
    get scripts() {
      return [current.bundle.entryUrl];
    },
    get styles() {
      return current.bundle.styleUrls;
    },
    middleware: async (ctx, next) => {
      if (ctx.method !== "GET" && ctx.method !== "HEAD") return next();
      const file = current.files.get(ctx.path);
      if (file) return new Response(file, { headers: { "content-type": file.type, "cache-control": "no-cache" } });
      if (ctx.path.startsWith(`${ASSETS_PREFIX}/`) || !isStale()) return next();

      try {
        await refresh();
      } catch (error) {
        // Shown in place of the page, like a compile error in any dev server, until the source is fixed.
        const message = error instanceof Error ? `${error.message}${error.cause ? `\n\n${String(error.cause)}` : ""}` : String(error);
        return new Response(message, { status: 500, headers: { "content-type": "text/plain;charset=utf-8" } });
      }
      return next();
    },
  };
}
