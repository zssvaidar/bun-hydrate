import { isAbsolute, join } from "node:path";
import type { ClientPlugin } from "@bun-hydrate/react";
import type { FeatureDefinition, FeaturePreset } from "./features/define";

export interface HydrateConfigInput {
  /** Server entry. Default: src/main.ts */
  server?: string;
  /** Worker entry, run by `hydrate worker` and built to dist/worker.js when it exists. Default: src/worker.ts */
  worker?: string;
  /** Browser entry for hydration; omit for API-only apps. */
  client?: string;
  /**
   * Bun plugins for the client bundle, e.g. sassPlugin() from `@bun-hydrate/react/sass`. Pass the
   * same list to createAssets({ plugins }) so development bundles the same way.
   */
  clientPlugins?: ClientPlugin[];
  /** Build output directory. Default: dist */
  outDir?: string;
  database?: {
    /** SQL migrations directory. Default: migrations */
    migrations?: string;
    /** Module whose default export seeds the database. Default: src/database/seed.ts */
    seed?: string;
  };
  /** Extra features and presets for `hydrate add`, e.g. from third-party packages. */
  features?: FeatureDefinition[];
  presets?: FeaturePreset[];
}

/** Resolved config: every path absolute. */
export interface HydrateConfig {
  server: string;
  client: string | undefined;
  clientPlugins: ClientPlugin[];
  outDir: string;
  database: { migrations: string; seed: string };
  features: FeatureDefinition[];
  presets: FeaturePreset[];
  worker: string;
}

export const CONFIG_FILE = "hydrate.config.ts";

export function defineHydrateConfig(config: HydrateConfigInput): HydrateConfigInput {
  return config;
}

export async function loadHydrateConfig(cwd: string): Promise<HydrateConfig> {
  const path = join(cwd, CONFIG_FILE);
  const input: HydrateConfigInput = (await Bun.file(path).exists()) ? (await import(path)).default ?? {} : {};
  const resolvePath = (value: string) => (isAbsolute(value) ? value : join(cwd, value));

  return {
    server: resolvePath(input.server ?? "src/main.ts"),
    client: input.client === undefined ? undefined : resolvePath(input.client),
    clientPlugins: input.clientPlugins ?? [],
    outDir: resolvePath(input.outDir ?? "dist"),
    database: {
      migrations: resolvePath(input.database?.migrations ?? "migrations"),
      seed: resolvePath(input.database?.seed ?? "src/database/seed.ts"),
    },
    features: input.features ?? [],
    presets: input.presets ?? [],
    worker: resolvePath(input.worker ?? "src/worker.ts"),
  };
}
