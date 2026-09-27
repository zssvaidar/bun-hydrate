import { Migrator, createDatabase } from "@bun-hydrate/database";
import type { HydrateConfig } from "../config";
import { applyPlan } from "./apply";
import { diagnose } from "./doctor";
import { formatPlan } from "./format";
import { readManifest } from "./manifest";
import { planAdd, planRemove, planSync, type Plan, type Project } from "./plan";
import type { FeatureRegistry } from "./registry";

export const FEATURE_COMMANDS = ["features", "add", "remove", "doctor", "sync"] as const;

export interface FeatureFlags {
  dryRun?: boolean;
  yes?: boolean;
  cascade?: boolean;
  force?: boolean;
  dropData?: boolean;
}

export interface FeatureCommandOptions {
  cwd: string;
  config: HydrateConfig;
  registry: FeatureRegistry;
  flags?: FeatureFlags;
  log?: (message: string) => void;
  /** Asked before applying add/remove. Default: a [Y/n] prompt on the terminal. */
  confirm?: (question: string) => Promise<boolean>;
}

/** `hydrate features | add | remove | doctor | sync` (spec-5 §9.2). Returns the exit code. */
export async function runFeatureCommand(command: string, ids: readonly string[], options: FeatureCommandOptions): Promise<number> {
  const { cwd, config, registry, flags = {}, log = console.log } = options;
  const project: Project = { cwd, migrations: config.database.migrations };
  const manifest = await readManifest(cwd);

  switch (command) {
    case "features":
      log(listFeatures(registry, new Set(Object.keys(manifest.features))));
      return 0;
    case "add":
    case "remove": {
      if (ids.length === 0) throw new Error(`Usage: hydrate ${command} <feature|preset>... (see \`hydrate features\`)`);
      const plan =
        command === "add"
          ? await planAdd(project, registry, manifest, ids)
          : await planRemove(project, registry, manifest, ids, flags);
      return present(plan, project, options);
    }
    case "sync":
      return present(await planSync(project, registry, manifest), project, { ...options, flags: { ...flags, yes: true } });
    case "doctor": {
      const issues = await diagnose(project, registry, manifest, { pendingMigrations: await pendingMigrations(config) });
      if (issues.length === 0) log("No problems found.");
      for (const issue of issues) log(`${issue.level === "problem" ? "✗" : "·"} ${issue.message}`);
      return issues.some((issue) => issue.level === "problem") ? 1 : 0;
    }
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

async function present(plan: Plan, project: Project, options: FeatureCommandOptions): Promise<number> {
  const { flags = {}, log = console.log, confirm = confirmOnTerminal } = options;
  log(formatPlan(plan));
  const changes = plan.steps.some((step) => step.op !== "keep") || plan.features.length > 0;
  if (!changes || flags.dryRun) return 0;
  if (!flags.yes && !(await confirm("Apply? [Y/n] "))) {
    log("Nothing was changed.");
    return 1;
  }
  await applyPlan(project, plan);
  log("Done.");
  return 0;
}

function listFeatures(registry: FeatureRegistry, installed: ReadonlySet<string>): string {
  const width = Math.max(...registry.all().map((feature) => feature.id.length), ...registry.allPresets().map((p) => p.id.length));
  const lines = ["Features ([x] installed):"];
  for (const feature of registry.all()) {
    const requires = (feature.requires ?? []).map((r) => (typeof r === "string" ? r : r.join(" or "))).join(", ");
    lines.push(
      `  [${installed.has(feature.id) ? "x" : " "}] ${feature.id.padEnd(width)}  ${feature.description}${requires ? ` (requires ${requires})` : ""}`,
    );
  }
  lines.push("", "Presets:");
  for (const preset of registry.allPresets()) lines.push(`      ${preset.id.padEnd(width)}  ${preset.description}`);
  lines.push("", "Add with `bun hydrate add <feature|preset>`, remove with `bun hydrate remove <feature>`.");
  return lines.join("\n");
}

/** Pending migration names when DATABASE_URL is set; undefined otherwise (doctor then skips the check). */
async function pendingMigrations(config: HydrateConfig): Promise<string[] | undefined> {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  const db = createDatabase({ url });
  try {
    return (await new Migrator({ db, directory: config.database.migrations }).status()).pending;
  } finally {
    await db.close();
  }
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("No terminal to confirm on. Re-run with --yes to apply this plan.");
  process.stdout.write(question);
  for await (const line of console) return !/^\s*n/i.test(line);
  return false;
}
