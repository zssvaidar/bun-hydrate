import { contentHash, type Manifest } from "./manifest";
import { readBlock } from "./markers";
import { isSet, readText, renderOutputs, type Project } from "./plan";
import type { FeatureRegistry } from "./registry";

export interface Issue {
  /** `info` is worth knowing but not wrong; `problem` makes `hydrate doctor` exit non-zero. */
  level: "info" | "problem";
  message: string;
}

export interface DiagnoseOptions {
  env?: Record<string, string | undefined>;
  /** Pending migration names from the database, when one is configured. */
  pendingMigrations?: readonly string[];
}

/** Compares installed features with the disk, the environment and the database (spec-5 §9.2). */
export async function diagnose(
  project: Project,
  registry: FeatureRegistry,
  manifest: Manifest,
  { env = process.env, pendingMigrations }: DiagnoseOptions = {},
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const unknown = Object.keys(manifest.features).filter((id) => !registry.has(id));
  for (const id of unknown) {
    issues.push({ level: "problem", message: `${id} is installed but unknown to this CLI (was its package removed?)` });
  }
  const known: Manifest = {
    ...manifest,
    features: Object.fromEntries(Object.entries(manifest.features).filter(([id]) => registry.has(id))),
  };
  const ids = registry.order(Object.keys(known.features));

  for (const id of ids) {
    for (const [path, hash] of Object.entries(known.features[id]!.files)) {
      const current = await readText(project.cwd, path);
      if (current === undefined) issues.push({ level: "problem", message: `${path} (${id}) is missing` });
      else if (contentHash(current) !== hash) {
        issues.push({ level: "info", message: `${path} (${id}) was modified; that's fine, but remove will keep it` });
      }
    }
  }

  for (const { output, key, content } of renderOutputs(registry, known)) {
    const current = await readText(project.cwd, output.path);
    if (current === undefined) {
      issues.push({ level: "problem", message: `${output.path} is generated but missing; \`hydrate sync\` restores it` });
      continue;
    }
    const actual = output.kind === "file" ? current : readBlock(current, output.block);
    if (actual === undefined) {
      issues.push({ level: "problem", message: `${output.path} lost its hydrate:${(output as { block: string }).block} markers` });
    } else if (actual !== content) {
      const edited = contentHash(actual) !== manifest.outputs[key];
      const what = output.kind === "file" ? output.path : `The hydrate:${output.block} block in ${output.path}`;
      issues.push({
        level: "problem",
        message: edited
          ? `${what} is generated but was edited by hand; \`hydrate sync\` restores it`
          : `${what} is out of date; \`hydrate sync\` regenerates it`,
      });
    }
  }

  for (const id of ids) {
    for (const variable of registry.get(id).env ?? []) {
      if (variable.required && !isSet(env, variable.name)) {
        issues.push({ level: "problem", message: `${variable.name} is not set (${id}: ${variable.description})` });
      }
    }
  }

  if (pendingMigrations) {
    const pending = new Set(pendingMigrations);
    for (const id of ids) {
      for (const name of known.features[id]!.migrations) {
        if (pending.has(name)) {
          issues.push({ level: "problem", message: `Migration ${name} (${id}) is not applied; run \`bun hydrate db:migrate\`` });
        }
      }
    }
  }
  return issues;
}
