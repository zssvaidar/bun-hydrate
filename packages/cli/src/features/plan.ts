import { join, relative } from "node:path";
import { migrationFileName } from "@bun-hydrate/database";
import type { FeatureMigration, FeatureOutput, Slots } from "./define";
import { contentHash, type Manifest } from "./manifest";
import { replaceBlock } from "./markers";
import { FeaturePlanError, type FeatureRegistry } from "./registry";
import { resolveAdd, resolveRemove, type Resolved } from "./resolve";

export interface Project {
  cwd: string;
  /** Absolute path of the migrations directory. */
  migrations: string;
  now?: () => Date;
  /** For "set this variable" hints. Default: process.env. */
  env?: Record<string, string | undefined>;
}

/** One file change. Paths are relative to the project root. `keep` changes nothing and is shown for clarity. */
export type Step =
  | { op: "create"; path: string; content: string; note?: string }
  | { op: "update"; path: string; content: string; note: string }
  | { op: "delete"; path: string; note?: string }
  | { op: "keep"; path: string; note: string; warn?: boolean };

export interface Plan {
  action: "add" | "remove" | "sync";
  requested: readonly string[];
  features: Resolved[];
  steps: Step[];
  /** What to do next, shown after the steps. */
  notes: string[];
  /** The manifest once the plan is applied. */
  manifest: Manifest;
}

export interface RemoveOptions {
  cascade?: boolean;
  /** Delete generated files even when you edited them. */
  force?: boolean;
  /** Make the removal migration drop the feature's tables. */
  dropData?: boolean;
}

export async function planAdd(
  project: Project,
  registry: FeatureRegistry,
  manifest: Manifest,
  requested: readonly string[],
): Promise<Plan> {
  const { added } = resolveAdd(registry, new Set(Object.keys(manifest.features)), requested);
  const next = structuredClone(manifest);
  const steps: Step[] = [];
  const migrationName = migrationNamer(project);

  for (const { id, auto } of added) {
    const feature = registry.get(id);
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(feature.files ?? {})) {
      const current = await readText(project.cwd, path);
      if (current === undefined) steps.push({ op: "create", path, content });
      else if (current === content) steps.push({ op: "keep", path, note: "identical file already there — adopted" });
      else throw new FeaturePlanError(`${path} already exists. Move it away (or delete it) and run the command again.`);
      files[path] = contentHash(content);
    }
    for (const [path, content] of Object.entries(feature.scaffold ?? {})) {
      steps.push(
        (await readText(project.cwd, path)) === undefined
          ? { op: "create", path, content, note: "yours: created once, never overwritten" }
          : { op: "keep", path, note: "yours: already there, kept as it is" },
      );
    }
    const migrations: string[] = [];
    if (feature.migration) {
      const name = await migrationName(`add_${id}`);
      steps.push({ op: "create", path: migrationPath(project, name), content: migrationText(feature.migration.up, feature.migration.down) });
      migrations.push(name);
    }
    next.features[id] = auto ? { auto, files, migrations } : { files, migrations };
  }

  steps.push(...(await outputSteps(project, registry, manifest, next)));
  const features = added.map(({ id }) => registry.get(id));
  const env = project.env ?? process.env;
  const notes = [
    // Several features may share one-time wiring (e.g. installPlatform); say it once.
    ...new Set(features.flatMap((feature) => feature.instructions ?? [])),
    ...features.flatMap((feature) =>
      (feature.env ?? []).filter((variable) => variable.required && !isSet(env, variable.name)).map((v) => `Set ${v.name}: ${v.description}`),
    ),
    ...features.flatMap((feature) => (feature.commands ?? []).map((c) => `New command: hydrate ${c.name} — ${c.description}`)),
    ...(features.some((feature) => feature.migration) ? ["bun hydrate db:migrate"] : []),
  ];
  return { action: "add", requested, features: added, steps, notes, manifest: next };
}

export async function planRemove(
  project: Project,
  registry: FeatureRegistry,
  manifest: Manifest,
  requested: readonly string[],
  { cascade = false, force = false, dropData = false }: RemoveOptions,
): Promise<Plan> {
  const { removed } = resolveRemove(registry, new Set(Object.keys(manifest.features)), requested, { cascade });
  const next = structuredClone(manifest);
  const steps: Step[] = [];
  const notes: string[] = [];
  const migrationName = migrationNamer(project);

  for (const { id } of removed) {
    const feature = registry.get(id);
    for (const [path, hash] of Object.entries(manifest.features[id]?.files ?? {})) {
      const current = await readText(project.cwd, path);
      if (current === undefined) continue;
      if (contentHash(current) === hash) steps.push({ op: "delete", path });
      else if (force) steps.push({ op: "delete", path, note: "modified — deleted (--force)" });
      else steps.push({ op: "keep", path, note: "modified — kept; use --force to delete", warn: true });
    }
    for (const path of Object.keys(feature.scaffold ?? {})) {
      if ((await readText(project.cwd, path)) !== undefined) steps.push({ op: "keep", path, note: "yours — kept" });
    }
    if (feature.migration) {
      const name = await migrationName(`remove_${id}`);
      steps.push({ op: "create", path: migrationPath(project, name), content: removalMigration(id, feature.migration, dropData) });
      if (!dropData) notes.push(`Tables kept with their data: ${feature.migration.tables.join(", ")} (use --drop-data to drop them)`);
    }
    notes.push(...(feature.commands ?? []).map((command) => `Command removed: hydrate ${command.name}`));
    delete next.features[id];
  }

  steps.push(...(await outputSteps(project, registry, manifest, next)));
  if (removed.some(({ id }) => registry.get(id).migration)) notes.push("bun hydrate db:migrate");
  return { action: "remove", requested, features: removed, steps, notes, manifest: next };
}

/** Regenerates orchestrator-owned outputs only; feature files and scaffolds are never touched. */
export async function planSync(project: Project, registry: FeatureRegistry, manifest: Manifest): Promise<Plan> {
  const next = structuredClone(manifest);
  const steps = await outputSteps(project, registry, manifest, next);
  return { action: "sync", requested: [], features: [], steps, notes: [], manifest: next };
}

/** Everything installed features contribute, in dependency order, then contributions from the manifest. */
export function buildSlots(registry: FeatureRegistry, ids: readonly string[], extra: Manifest["extra"]): Slots {
  const slots = new Map<string, unknown[]>();
  const add = (contributions: Readonly<Record<string, readonly unknown[]>>) => {
    for (const [slot, items] of Object.entries(contributions)) slots.set(slot, [...(slots.get(slot) ?? []), ...items]);
  };
  for (const id of ids) add(registry.get(id).contributes ?? {});
  for (const owner of Object.keys(extra).sort()) add(extra[owner]!);
  return { get: <T>(slot: string) => (slots.get(slot) ?? []) as T[] };
}

export interface RenderedOutput {
  output: FeatureOutput;
  key: string;
  /** Whole file for `file` outputs; the block's contents for `block` outputs. */
  content: string;
}

/**
 * Every output of the installed features, rendered. Several features may declare the same output
 * (e.g. the platform composition root); it is rendered once and exists while any of them does.
 */
export function renderOutputs(registry: FeatureRegistry, manifest: Manifest): RenderedOutput[] {
  const ids = registry.order(Object.keys(manifest.features));
  const slots = buildSlots(registry, ids, manifest.extra);
  const rendered = new Map<string, RenderedOutput>();
  for (const output of ids.flatMap((id) => registry.get(id).outputs ?? [])) {
    const key = output.kind === "file" ? output.path : `${output.path}#${output.block}`;
    if (!rendered.has(key)) rendered.set(key, { output, key, content: output.render(slots) });
  }
  return [...rendered.values()];
}

/** Brings every output in line with `after`, recording hashes in `after.outputs`. */
async function outputSteps(project: Project, registry: FeatureRegistry, before: Manifest, after: Manifest): Promise<Step[]> {
  const steps: Step[] = [];
  after.outputs = {};

  for (const { output, key, content } of renderOutputs(registry, after)) {
    after.outputs[key] = contentHash(content);
    const current = await readText(project.cwd, output.path);
    if (output.kind === "file") {
      if (current === undefined) steps.push({ op: "create", path: output.path, content, note: "generated" });
      else if (current !== content) steps.push({ op: "update", path: output.path, content, note: "regenerated" });
      continue;
    }
    const note = `hydrate:${output.block} block`;
    if (current === undefined) {
      steps.push({ op: "create", path: output.path, content: replaceBlock(output.initial, output.block, content)!, note });
      continue;
    }
    const updated = replaceBlock(current, output.block, content);
    if (updated === undefined) {
      throw new FeaturePlanError(
        `${output.path} has no hydrate:${output.block}:start / hydrate:${output.block}:end markers. Put them back so the block can be updated.`,
      );
    }
    if (updated !== current) steps.push({ op: "update", path: output.path, content: updated, note });
  }

  // Generated files whose feature is gone. Blocks stay: the file around them is yours.
  for (const [key, hash] of Object.entries(before.outputs)) {
    if (key in after.outputs || key.includes("#")) continue;
    const current = await readText(project.cwd, key);
    if (current === undefined) continue;
    steps.push(
      contentHash(current) === hash
        ? { op: "delete", path: key }
        : { op: "keep", path: key, note: "generated, but edited by hand — kept", warn: true },
    );
  }
  return steps;
}

export async function readText(cwd: string, path: string): Promise<string | undefined> {
  const file = Bun.file(join(cwd, path));
  return (await file.exists()) ? file.text() : undefined;
}

export function isSet(env: Record<string, string | undefined>, name: string): boolean {
  return Boolean(env[name] || env[`${name}_FILE`]);
}

function migrationPath(project: Project, name: string): string {
  return relative(project.cwd, join(project.migrations, `${name}.sql`));
}

/** Timestamped names, one second apart within a plan so they apply in plan order. */
function migrationNamer(project: Project) {
  let at = (project.now ?? (() => new Date()))().getTime();
  return async (name: string): Promise<string> => {
    for (;; at += 1000) {
      const file = migrationFileName(name, new Date(at));
      if (!(await Bun.file(join(project.migrations, file)).exists())) {
        at += 1000;
        return file.slice(0, -".sql".length);
      }
    }
  };
}

function migrationText(up: string, down: string): string {
  return `-- migrate:up\n${up.trim()}\n\n-- migrate:down\n${down.trim()}\n`;
}

/** Migrations are history, so removal adds one. Without --drop-data it only records what was kept. */
function removalMigration(id: string, migration: FeatureMigration, dropData: boolean): string {
  if (dropData) return migrationText(migration.down, migration.up);
  const dropHint = migration.down
    .trim()
    .split("\n")
    .map((line) => `--   ${line}`)
    .join("\n");
  return migrationText(
    `-- ${id} was removed. Its tables were kept with their data: ${migration.tables.join(", ")}.\n-- To drop them, add a migration with:\n${dropHint}`,
    "-- Nothing to undo: no tables were dropped.",
  );
}
