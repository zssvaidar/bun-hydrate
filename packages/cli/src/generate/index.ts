import { join, relative } from "node:path";
import { migrationFileName } from "@bun-hydrate/database";
import type { HydrateConfig } from "../config";
import { middlewareFiles } from "./middleware-template";
import { SHARED_FILES, moduleFiles, moduleMigration } from "./module-templates";
import { moduleNames } from "./names";

export const GENERATORS = ["module", "middleware"] as const;
export type GeneratorKind = (typeof GENERATORS)[number];

export interface GenerateOptions {
  cwd: string;
  config: HydrateConfig;
  now?: Date;
  log?: (message: string) => void;
  /** Guard the module's routes with permissions (needs auth:core). */
  auth?: boolean;
}

export async function generate(kind: string, name: string | undefined, options: GenerateOptions): Promise<void> {
  if (!GENERATORS.includes(kind as GeneratorKind)) {
    throw new Error(`Unknown generator "${kind}". Available: ${GENERATORS.join(", ")}`);
  }
  if (!name) throw new Error(`Usage: hydrate generate ${kind} <name>`);

  if (kind === "module") await generateModule(name, options);
  else await generateMiddleware(name, options);
}

async function generateModule(name: string, { cwd, config, now = new Date(), log = console.log }: GenerateOptions) {
  const n = moduleNames(name);
  const moduleDir = join(cwd, "src/modules", n.kebab);
  const migrationPath = join(config.database.migrations, migrationFileName(`create_${n.snake}`, now));

  const files = Object.entries(moduleFiles(n)).map(([file, content]) => ({ path: join(moduleDir, file), content }));
  await writeAllOrNothing([...files, { path: migrationPath, content: moduleMigration(n) }], cwd);
  const sharedCreated = await writeMissing(join(cwd, "src/shared"), SHARED_FILES);

  const shown = (path: string) => relative(cwd, path);
  log(`Created ${shown(moduleDir)}/ (${files.length} files) and ${shown(migrationPath)}`);
  for (const path of sharedCreated) log(`Created ${shown(path)}`);
  log(`
Next steps:
  1. Register the module in src/app.ts (its container needs Database and Clock):
       import { ${n.camel}Module } from "./modules/${n.kebab}/${n.kebab}.module";
       .route("/api/v1/${n.kebab}", ${n.camel}Module(container))
  2. Apply the migration:
       bun hydrate db:migrate`);
}

async function generateMiddleware(name: string, { cwd, log = console.log }: GenerateOptions) {
  const n = moduleNames(name);
  const directory = join(cwd, "src/middleware");
  const files = Object.entries(middlewareFiles(n)).map(([file, content]) => ({ path: join(directory, file), content }));

  await writeAllOrNothing(files, cwd);
  log(`Created ${files.map((file) => relative(cwd, file.path)).join(", ")}`);
  log(`\nUse it with app.use(${n.camel}()) or on a single route.`);
}

/** Checks every target first, so a conflict never leaves a half-generated module behind. */
async function writeAllOrNothing(files: { path: string; content: string }[], cwd: string): Promise<void> {
  for (const { path } of files) {
    if (await Bun.file(path).exists()) throw new Error(`${relative(cwd, path)} already exists; nothing was generated`);
  }
  for (const { path, content } of files) await Bun.write(path, content);
}

async function writeMissing(directory: string, files: Record<string, string>): Promise<string[]> {
  const created: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    const path = join(directory, file);
    if (await Bun.file(path).exists()) continue;
    await Bun.write(path, content);
    created.push(path);
  }
  return created;
}
