import { readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MANIFEST_FILE, serializeManifest } from "./manifest";
import { readText, type Plan, type Project } from "./plan";

/**
 * Applies a plan all-or-nothing: every change is journaled, and if any write fails the journal
 * is replayed backwards so the project is exactly as before (spec-5 §9.2).
 */
export async function applyPlan(project: Project, plan: Plan): Promise<void> {
  const changes = [
    ...plan.steps.flatMap((step) =>
      step.op === "keep" ? [] : [{ path: step.path, content: step.op === "delete" ? undefined : step.content }],
    ),
    { path: MANIFEST_FILE, content: serializeManifest(plan.manifest) },
  ];
  const undo: { path: string; previous: string | undefined }[] = [];

  try {
    for (const { path, content } of changes) {
      undo.push({ path, previous: await readText(project.cwd, path) });
      if (content === undefined) await rm(join(project.cwd, path));
      else await Bun.write(join(project.cwd, path), content);
    }
  } catch (error) {
    for (const { path, previous } of undo.reverse()) {
      if (previous === undefined) await rm(join(project.cwd, path), { force: true }).catch(() => {});
      else await Bun.write(join(project.cwd, path), previous).catch(() => {});
    }
    await pruneEmptyDirectories(project.cwd, changes.map((change) => change.path));
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Nothing was changed: ${reason}`, { cause: error });
  }

  await pruneEmptyDirectories(
    project.cwd,
    changes.filter((change) => change.content === undefined).map((change) => change.path),
  );
}

/** Removes directories left empty by deleted files, walking up to (not including) the project root. */
async function pruneEmptyDirectories(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    for (let directory = dirname(join(root, path)); directory.startsWith(root) && directory !== root; directory = dirname(directory)) {
      const entries = await readdir(directory).catch(() => undefined);
      if (entries === undefined || entries.length > 0) break;
      await rmdir(directory).catch(() => {});
    }
  }
}
