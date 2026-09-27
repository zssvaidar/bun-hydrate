import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFeature, type Slots } from "../../src/features/define";
import { diagnose } from "../../src/features/doctor";
import { applyPlan } from "../../src/features/apply";
import { formatPlan } from "../../src/features/format";
import { readManifest } from "../../src/features/manifest";
import { planAdd, planRemove, planSync, type Project } from "../../src/features/plan";
import { FeatureRegistry } from "../../src/features/registry";

const parts = (slots: Slots) => slots.get<{ name: string }>("demo.parts").map((part) => part.name);

const registry = new FeatureRegistry([
  defineFeature({
    id: "demo:core",
    description: "Core demo feature",
    files: { "src/demo/core.ts": "export const core = 1;\n" },
    scaffold: { "src/demo/config.ts": "export const config = {};\n" },
    migration: {
      up: "create table if not exists demo_items (id integer primary key);",
      down: "drop table if exists demo_items;",
      tables: ["demo_items"],
    },
    env: [{ name: "DEMO_SECRET", description: "Signs demo things", required: true }],
    contributes: { "demo.parts": [{ name: "core" }], permissions: ["demo.read"] },
    outputs: [
      {
        kind: "file",
        path: "src/demo/index.ts",
        render: (slots) => `// generated\nexport const parts = ${JSON.stringify(parts(slots))};\n`,
      },
      {
        kind: "block",
        path: "src/shared/permissions.ts",
        block: "permissions",
        initial: "export const PERMISSIONS = [\n  // hydrate:permissions:start\n  // hydrate:permissions:end\n] as const;\n",
        render: (slots) => slots.get<string>("permissions").map((name) => `  "${name}",`).join("\n"),
      },
    ],
    instructions: ["Wire it once: installDemo(app)"],
  }),
  defineFeature({
    id: "demo:extra",
    description: "Extra demo feature",
    requires: ["demo:core"],
    files: { "src/demo/extra/extra.ts": "export const extra = 2;\n", "src/demo/extra/extra.test.ts": "// test\n" },
    contributes: { "demo.parts": [{ name: "extra" }], permissions: ["demo.write"] },
    commands: [{ name: "demo:hello", usage: "demo:hello", description: "Says hello" }],
  }),
]);

let cwd: string;
let project: Project;
const read = (path: string) => Bun.file(join(cwd, path)).text();
const exists = (path: string) => Bun.file(join(cwd, path)).exists();

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hydrate-features-"));
  project = { cwd, migrations: join(cwd, "migrations"), now: () => new Date("2026-10-01T12:00:00Z") };
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

async function add(...ids: string[]) {
  const plan = await planAdd(project, registry, await readManifest(cwd), ids);
  await applyPlan(project, plan);
  return plan;
}

describe("add", () => {
  test("the plan lists pulled-in requirements, files, migrations, outputs and next steps", async () => {
    const plan = await planAdd(project, registry, await readManifest(cwd), ["demo:extra"]);

    expect(formatPlan(plan)).toBe(
      [
        "Plan: add demo:extra",
        "  + demo:core                          (required by demo:extra)",
        "  + demo:extra",
        "",
        "  + src/demo/core.ts",
        "  + src/demo/config.ts                 (yours: created once, never overwritten)",
        "  + migrations/20261001120000_add_demo_core.sql",
        "  + src/demo/extra/extra.ts",
        "  + src/demo/extra/extra.test.ts",
        "  + src/demo/index.ts                  (generated)",
        "  + src/shared/permissions.ts          (hydrate:permissions block)",
        "",
        "Then:",
        "  - Wire it once: installDemo(app)",
        "  - Set DEMO_SECRET: Signs demo things",
        "  - New command: hydrate demo:hello — Says hello",
        "  - bun hydrate db:migrate",
      ].join("\n"),
    );
    expect(await exists("src/demo/core.ts")).toBe(false); // planning writes nothing
  });

  test("apply writes the files, the migration, the outputs and a manifest with content hashes", async () => {
    await add("demo:core");

    expect(await read("src/demo/core.ts")).toBe("export const core = 1;\n");
    expect(await read("src/demo/index.ts")).toBe('// generated\nexport const parts = ["core"];\n');
    expect(await read("src/shared/permissions.ts")).toBe(
      'export const PERMISSIONS = [\n  // hydrate:permissions:start\n  "demo.read",\n  // hydrate:permissions:end\n] as const;\n',
    );
    expect(await read("migrations/20261001120000_add_demo_core.sql")).toBe(
      "-- migrate:up\ncreate table if not exists demo_items (id integer primary key);\n\n-- migrate:down\ndrop table if exists demo_items;\n",
    );
    const manifest = await readManifest(cwd);
    expect(manifest.features["demo:core"]).toEqual({
      files: { "src/demo/core.ts": expect.stringMatching(/^sha256-[0-9a-f]{64}$/) },
      migrations: ["20261001120000_add_demo_core"],
    });
    expect(Object.keys(manifest.outputs)).toEqual(["src/demo/index.ts", "src/shared/permissions.ts#permissions"]);
  });

  test("adding a feature later regenerates outputs and rewrites only the marked block", async () => {
    await add("demo:core");
    const permissions = (await read("src/shared/permissions.ts")).replace("] as const;", "] as const;\nexport const MINE = 1;");
    await Bun.write(join(cwd, "src/shared/permissions.ts"), permissions);

    const plan = await add("demo:extra");

    expect(formatPlan(plan)).toContain("  ~ src/demo/index.ts                  (regenerated)");
    expect(await read("src/demo/index.ts")).toContain('["core","extra"]');
    expect(await read("src/shared/permissions.ts")).toBe(
      'export const PERMISSIONS = [\n  // hydrate:permissions:start\n  "demo.read",\n  "demo.write",\n  // hydrate:permissions:end\n] as const;\nexport const MINE = 1;\n',
    );
  });

  test("an existing file that differs stops the plan; an identical one is adopted", async () => {
    await Bun.write(join(cwd, "src/demo/core.ts"), "// mine\n");
    expect(planAdd(project, registry, await readManifest(cwd), ["demo:core"])).rejects.toThrow(
      "src/demo/core.ts already exists. Move it away (or delete it) and run the command again.",
    );

    await Bun.write(join(cwd, "src/demo/core.ts"), "export const core = 1;\n");
    const plan = await planAdd(project, registry, await readManifest(cwd), ["demo:core"]);
    expect(formatPlan(plan)).toContain("  = src/demo/core.ts                   (identical file already there — adopted)");
  });

  test("an existing scaffold file is kept as it is", async () => {
    await Bun.write(join(cwd, "src/demo/config.ts"), "// my settings\n");
    await add("demo:core");
    expect(await read("src/demo/config.ts")).toBe("// my settings\n");
  });

  test("a failed apply rolls back everything it wrote", async () => {
    const ok = await planAdd(project, registry, await readManifest(cwd), ["demo:core"]);
    // A file where a directory is needed makes the last write fail.
    await Bun.write(join(cwd, "src/shared"), "appeared after planning\n");

    expect(applyPlan(project, ok)).rejects.toThrow("Nothing was changed");
    expect(await exists("src/demo/core.ts")).toBe(false);
    expect(await exists("migrations/20261001120000_add_demo_core.sql")).toBe(false);
    expect(await exists("hydrate.features.json")).toBe(false);
    expect(await readdir(cwd)).toEqual(["src"]);
    expect(await readdir(join(cwd, "src"))).toEqual(["shared"]);
  });
});

describe("remove", () => {
  beforeEach(() => add("demo:extra"));

  test("deletes unchanged files, keeps edited ones, and regenerates outputs", async () => {
    await Bun.write(join(cwd, "src/demo/extra/extra.test.ts"), "// my edits\n");

    const plan = await planRemove(project, registry, await readManifest(cwd), ["demo:extra"], {});
    expect(formatPlan(plan)).toContain("  - src/demo/extra/extra.ts");
    expect(formatPlan(plan)).toContain("  ! src/demo/extra/extra.test.ts       (modified — kept; use --force to delete)");
    await applyPlan(project, plan);

    expect(await exists("src/demo/extra/extra.ts")).toBe(false);
    expect(await read("src/demo/extra/extra.test.ts")).toBe("// my edits\n");
    expect(await read("src/demo/index.ts")).toContain('["core"]');
    expect(await read("src/shared/permissions.ts")).not.toContain("demo.write");
    expect((await readManifest(cwd)).features["demo:extra"]).toBeUndefined();
  });

  test("--force deletes edited files too, and empty directories go with them", async () => {
    await Bun.write(join(cwd, "src/demo/extra/extra.test.ts"), "// my edits\n");
    await applyPlan(project, await planRemove(project, registry, await readManifest(cwd), ["demo:extra"], { force: true }));
    expect(await readdir(join(cwd, "src/demo"))).not.toContain("extra");
  });

  test("migrations are never deleted: removal writes a new one that keeps data unless asked", async () => {
    const keep = await planRemove(project, registry, await readManifest(cwd), ["demo:core"], { cascade: true });
    const drop = await planRemove(project, registry, await readManifest(cwd), ["demo:core"], { cascade: true, dropData: true });
    const migrationOf = (plan: typeof keep) =>
      plan.steps.find((step) => step.op === "create" && step.path.includes("_remove_demo_core")) as { path: string; content: string };

    expect(migrationOf(keep)).toMatchObject({ path: "migrations/20261001120000_remove_demo_core.sql" });
    expect(migrationOf(keep).content).toBe(
      "-- migrate:up\n-- demo:core was removed. Its tables were kept with their data: demo_items.\n-- To drop them, add a migration with:\n--   drop table if exists demo_items;\n\n-- migrate:down\n-- Nothing to undo: no tables were dropped.\n",
    );
    expect(migrationOf(drop).content).toBe(
      "-- migrate:up\ndrop table if exists demo_items;\n\n-- migrate:down\ncreate table if not exists demo_items (id integer primary key);\n",
    );
    expect(formatPlan(keep)).toContain("  - Tables kept with their data: demo_items (use --drop-data to drop them)");
    expect(await exists("migrations/20261001120000_add_demo_core.sql")).toBe(true);
  });

  test("removing the feature that declares an output deletes it, unless it was edited", async () => {
    await applyPlan(project, await planRemove(project, registry, await readManifest(cwd), ["demo:core"], { cascade: true }));

    expect(await exists("src/demo/index.ts")).toBe(false);
    expect(await exists("src/shared/permissions.ts")).toBe(true); // yours outside the markers
    expect(await exists("src/demo/config.ts")).toBe(true); // scaffold: yours
    expect(await readManifest(cwd)).toEqual({ version: 1, features: {}, outputs: {}, extra: {} });
  });
});

describe("doctor and sync", () => {
  beforeEach(() => add("demo:extra"));

  test("doctor reports each kind of drift", async () => {
    await Bun.write(join(cwd, "src/demo/core.ts"), "// edited\n");
    await rm(join(cwd, "src/demo/extra/extra.ts"));
    await Bun.write(join(cwd, "src/demo/index.ts"), "// hand edit\n");

    const issues = await diagnose(project, registry, await readManifest(cwd), {
      env: {},
      pendingMigrations: ["20261001120000_add_demo_core"],
    });

    expect(issues).toEqual([
      { level: "info", message: "src/demo/core.ts (demo:core) was modified; that's fine, but remove will keep it" },
      { level: "problem", message: "src/demo/extra/extra.ts (demo:extra) is missing" },
      { level: "problem", message: "src/demo/index.ts is generated but was edited by hand; `hydrate sync` restores it" },
      { level: "problem", message: "DEMO_SECRET is not set (demo:core: Signs demo things)" },
      { level: "problem", message: "Migration 20261001120000_add_demo_core (demo:core) is not applied; run `bun hydrate db:migrate`" },
    ]);
    expect(await diagnose(project, registry, await readManifest(cwd), { env: { DEMO_SECRET: "x" } })).toHaveLength(3);
  });

  test("a clean project has no issues", async () => {
    expect(await diagnose(project, registry, await readManifest(cwd), { env: { DEMO_SECRET: "x" }, pendingMigrations: [] })).toEqual([]);
  });

  test("sync restores generated outputs and never touches your files", async () => {
    await Bun.write(join(cwd, "src/demo/index.ts"), "// hand edit\n");
    await Bun.write(join(cwd, "src/demo/core.ts"), "// edited\n");

    const plan = await planSync(project, registry, await readManifest(cwd));
    expect(plan.steps.map((step) => `${step.op} ${step.path}`)).toEqual(["update src/demo/index.ts"]);
    await applyPlan(project, plan);

    expect(await read("src/demo/index.ts")).toContain('["core","extra"]');
    expect(await read("src/demo/core.ts")).toBe("// edited\n");
  });

  test("extra contributions recorded in the manifest (e.g. from generate module --auth) are rendered", async () => {
    const manifest = await readManifest(cwd);
    manifest.extra["module:orders"] = { permissions: ["orders.read"] };
    await applyPlan(project, await planSync(project, registry, manifest));
    expect(await read("src/shared/permissions.ts")).toContain('"demo.write",\n  "orders.read",');
    expect((await readManifest(cwd)).extra).toEqual({ "module:orders": { permissions: ["orders.read"] } });
  });
});

describe("shared outputs", () => {
  const shared = {
    kind: "file" as const,
    path: "src/platform/index.ts",
    render: (slots: Slots) => `export const installed = ${JSON.stringify(slots.get<string>("platform"))};\n`,
  };
  const platform = new FeatureRegistry([
    defineFeature({ id: "p:one", description: "One", outputs: [shared], contributes: { platform: ["one"] } }),
    defineFeature({ id: "p:two", description: "Two", outputs: [shared], contributes: { platform: ["two"] } }),
  ]);

  test("an output declared by several features is rendered once and lives until the last one goes", async () => {
    const run = async (plan: Promise<Parameters<typeof applyPlan>[1]>) => applyPlan(project, await plan);
    const added = await planAdd(project, platform, await readManifest(cwd), ["p:one", "p:two"]);
    expect(added.steps.map((step) => step.path)).toEqual(["src/platform/index.ts"]);
    await run(Promise.resolve(added));
    expect(await read("src/platform/index.ts")).toBe('export const installed = ["one","two"];\n');

    await run(planRemove(project, platform, await readManifest(cwd), ["p:one"], {}));
    expect(await read("src/platform/index.ts")).toBe('export const installed = ["two"];\n');

    await run(planRemove(project, platform, await readManifest(cwd), ["p:two"], {}));
    expect(await exists("src/platform/index.ts")).toBe(false);
  });
});
