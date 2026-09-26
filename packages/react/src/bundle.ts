import { basename } from "node:path";
import type { BuildArtifact } from "bun";

export const ASSETS_PREFIX = "/assets";

/**
 * Everything except `syntax`: Bun 1.3's syntax minifier corrupts labelled statements in React's
 * production builds — the server bundle fails to load ("Cannot find scope for the label") and V8
 * rejects the client bundle ("Label has already been declared"). Covered by tests/e2e/build.test.ts
 * and tests/e2e/browser.test.ts.
 */
export const SAFE_MINIFY = { whitespace: true, identifiers: true, syntax: false } as const;

export interface ClientBundleOptions {
  entry: string;
  production: boolean;
  /** Write files here; omit to keep the bundle in memory. */
  outdir?: string;
}

export interface ClientBundle {
  /** URL of the entry script, e.g. `/assets/client-3fa2.js`. */
  entryUrl: string;
  outputs: BuildArtifact[];
}

/** Bundles the browser entry with content-hashed names. Shared by dev (in memory) and `hydrate build` (to disk). */
export async function bundleClient({ entry, production, outdir }: ClientBundleOptions): Promise<ClientBundle> {
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
    });
  } catch (error) {
    throw new Error(`Client bundle failed for ${entry}`, { cause: error });
  }
  if (!result.success) {
    throw new Error(`Client bundle failed for ${entry}:\n${result.logs.join("\n")}`);
  }

  const entryOutput = result.outputs.find((output) => output.kind === "entry-point");
  if (!entryOutput) throw new Error(`Client bundle for ${entry} produced no entry point`);

  return { entryUrl: `${ASSETS_PREFIX}/${basename(entryOutput.path)}`, outputs: result.outputs };
}
