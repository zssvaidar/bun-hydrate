import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFeature } from "../../src/features/define";
import { runAppCommand } from "../../src/features/app-commands";
import { MANIFEST_FILE, emptyManifest, serializeManifest, type Manifest } from "../../src/features/manifest";
import { FeatureRegistry } from "../../src/features/registry";

/** Two interchangeable features that provide the same command, like jobs:database and jobs:redis. */
const provider = (id: string, module: string) =>
  defineFeature({
    id,
    description: id,
    conflicts: [id === "queue:a" ? "queue:b" : "queue:a"],
    commands: [{ name: "queue:echo", usage: "", description: "Echoes stdin" }],
    commandsModule: module,
  });
const registry = new FeatureRegistry([provider("queue:a", "a.commands.ts"), provider("queue:b", "b.commands.ts")]);

const commandModule = (label: string) => `export const commands = {
  "queue:echo": async (ctx) => ctx.print("${label}: " + (await ctx.readInput())),
};
`;

let cwd: string;
const writeManifest = (manifest: Manifest) => Bun.write(join(cwd, MANIFEST_FILE), serializeManifest(manifest));
let url: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hydrate-app-commands-"));
  await Bun.write(join(cwd, "a.commands.ts"), commandModule("a"));
  await Bun.write(join(cwd, "b.commands.ts"), commandModule("b"));
  url = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "sqlite://:memory:";
});

afterEach(async () => {
  if (url === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = url;
  await rm(cwd, { recursive: true, force: true });
});

test("a command two features provide runs from the one that is installed, and reads stdin", async () => {
  const manifest = emptyManifest();
  manifest.features["queue:b"] = { files: {}, migrations: [] };
  await writeManifest(manifest);

  const lines: string[] = [];
  const ran = await runAppCommand("queue:echo", [], { cwd, registry, log: (line) => lines.push(line), stdin: { text: async () => '{"id":1}' } });

  expect(ran).toBe(true);
  expect(lines).toEqual(['b: {"id":1}']);
});

test("with neither installed, it names the first provider to add", async () => {
  await writeManifest(emptyManifest());
  expect(runAppCommand("queue:echo", [], { cwd, registry })).rejects.toThrow("hydrate queue:echo comes with queue:a. Add it with: bun hydrate add queue:a");
});
