import { fileURLToPath } from "node:url";
import type { ClientPlugin } from "./bundle";

export interface SassPluginOptions {
  /** Extra directories `@use` and `@import` search, e.g. ["node_modules"] for packages' Sass. */
  loadPaths?: string[];
  /** Hide deprecation warnings from stylesheets loaded through `loadPaths`. Default: true. */
  quietDeps?: boolean;
}

/** The part of sass-embedded's API this plugin uses. */
interface SassCompiler {
  compileAsync(
    path: string,
    options: { loadPaths?: string[]; quietDeps?: boolean; style: "expanded" },
  ): Promise<{ css: string; loadedUrls: URL[] }>;
}

/**
 * Compiles `.scss` and `.sass` imports with Dart Sass (sass-embedded), then hands the CSS to Bun,
 * which bundles, minifies and hashes it like any stylesheet. Runs only while bundling the client:
 * sass-embedded is a dev dependency and never part of dist/.
 */
export function sassPlugin(options: SassPluginOptions = {}): ClientPlugin {
  // Per stylesheet the bundler loaded, every file Sass read for it (partials included).
  const loaded = new Map<string, string[]>();

  return {
    name: "bun-hydrate:sass",
    setup(build) {
      build.onLoad({ filter: /\.s[ac]ss$/ }, async ({ path }) => {
        const sass = await loadSass();
        const result = await sass.compileAsync(path, {
          loadPaths: options.loadPaths,
          quietDeps: options.quietDeps ?? true,
          style: "expanded",
        });
        loaded.set(path, result.loadedUrls.filter((url) => url.protocol === "file:").map((url) => fileURLToPath(url)));
        return { contents: result.css, loader: "css" };
      });
    },
    watchFiles: () => [...loaded.values()].flat(),
  };
}

let sass: Promise<SassCompiler> | undefined;

function loadSass(): Promise<SassCompiler> {
  // A specifier the bundler cannot follow: the server bundle that imports this plugin for
  // development must not pull the Sass compiler (and its native binary) into dist/.
  const specifier = ["sass", "embedded"].join("-");
  sass ??= (import(specifier) as Promise<SassCompiler>).catch((error: unknown) => {
    sass = undefined;
    throw new Error("sassPlugin() needs the sass-embedded package: run `bun add -d sass-embedded`", { cause: error });
  });
  return sass;
}
