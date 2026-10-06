import { basename, resolve } from "node:path";
import type { BuildArtifact, BunPlugin } from "bun";

export const ASSETS_PREFIX = "/assets";

/**
 * Everything except `syntax`: Bun 1.3's syntax minifier corrupts labelled statements in React's
 * production builds — the server bundle fails to load ("Cannot find scope for the label") and V8
 * rejects the client bundle ("Label has already been declared"). Covered by tests/e2e/build.test.ts
 * and tests/e2e/browser.test.ts.
 */
export const SAFE_MINIFY = { whitespace: true, identifiers: true, syntax: false } as const;

/**
 * A Bun plugin for the client bundle, e.g. sassPlugin() from `@bun-hydrate/react/sass`. One that
 * reads files the bundler never sees (Sass partials) lists them in `watchFiles`, so development
 * rebundles when they change.
 */
export interface ClientPlugin extends BunPlugin {
  watchFiles?(): Iterable<string>;
}

export interface ClientBundleOptions {
  entry: string;
  production: boolean;
  /** Write files here; omit to keep the bundle in memory. */
  outdir?: string;
  plugins?: readonly ClientPlugin[];
}

export interface ClientBundle {
  /** URL of the entry script, e.g. `/assets/client-3fa2.js`. */
  entryUrl: string;
  /** URLs of the stylesheets the client imports, e.g. `/assets/client-9c1e.css`, for <link> tags in <head>. */
  styleUrls: string[];
  outputs: BuildArtifact[];
  /** Absolute paths of the app's source files in the bundle (node_modules left out). */
  inputs: string[];
}

/** Bundles the browser entry with content-hashed names. Shared by dev (in memory) and `hydrate build` (to disk). */
export async function bundleClient({ entry, production, outdir, plugins = [] }: ClientBundleOptions): Promise<ClientBundle> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      outdir,
      target: "browser",
      splitting: true,
      minify: production ? SAFE_MINIFY : false,
      sourcemap: production ? "linked" : "inline",
      naming: "[name]-[hash].[ext]",
      define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
      plugins: [...plugins],
      metafile: !production,
    });
  } catch (error) {
    // Bun rejects with an AggregateError whose own message says nothing; show what failed.
    const reasons = error instanceof AggregateError ? `:\n${error.errors.map(String).join("\n")}` : "";
    throw new Error(`Client bundle failed for ${entry}${reasons}`, { cause: error });
  }
  if (!result.success) {
    throw new Error(`Client bundle failed for ${entry}:\n${result.logs.join("\n")}`);
  }

  const entryOutput = result.outputs.find((output) => output.kind === "entry-point");
  if (!entryOutput) throw new Error(`Client bundle for ${entry} produced no entry point`);

  // Without a Sass plugin Bun copies .scss files as opaque assets, and the styles silently never apply.
  const rawSass = result.outputs.find((output) => /\.s[ac]ss$/.test(output.path));
  if (rawSass) {
    throw new Error(`Client bundle failed for ${entry}: it imports Sass (${basename(rawSass.path)}) but no plugin compiles it. Run: bun hydrate add styles:sass`);
  }

  const urlOf = (output: BuildArtifact) => `${ASSETS_PREFIX}/${basename(output.path)}`;
  // CSS imported anywhere in the client becomes its own file; images it references are assets too.
  const styleUrls = result.outputs.filter((output) => output.kind === "asset" && output.path.endsWith(".css")).map(urlOf);

  const inputs = new Set(
    Object.keys(result.metafile?.inputs ?? {})
      .filter((input) => !input.includes("node_modules/") && !input.includes(":"))
      .map((input) => resolve(input)),
  );
  for (const plugin of plugins) for (const file of plugin.watchFiles?.() ?? []) inputs.add(file);

  return { entryUrl: urlOf(entryOutput), styleUrls, outputs: result.outputs, inputs: [...inputs] };
}
