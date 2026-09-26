import { isAbsolute, join } from "node:path";

export interface HydrateConfigInput {
  /** Server entry. Default: src/main.ts */
  server?: string;
  /** Browser entry for hydration; omit for API-only apps. */
  client?: string;
  /** Build output directory. Default: dist */
  outDir?: string;
}

/** Resolved config: every path absolute. */
export interface HydrateConfig {
  server: string;
  client: string | undefined;
  outDir: string;
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
    outDir: resolvePath(input.outDir ?? "dist"),
  };
}
