import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "@bun-hydrate/testing";
import { build } from "../src/build";
import { loadHydrateConfig } from "../src/config";

const bin = join(import.meta.dir, "../src/bin.ts");
const fixture = join(import.meta.dir, "fixtures/server-only");
const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "hydrate-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function runCli(args: string[]) {
  const result = Bun.spawnSync(["bun", bin, ...args], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("hydrate CLI", () => {
  test("--help lists the commands", () => {
    const { code, stdout } = runCli(["--help"]);

    expect(code).toBe(0);
    for (const command of ["dev", "build", "start"]) expect(stdout).toContain(command);
  });

  test("unknown commands fail with a suggestion", () => {
    const { code, stderr } = runCli(["biuld"]);

    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command "biuld"');
    expect(stderr).toContain("hydrate --help");
  });
});

describe("loadHydrateConfig", () => {
  test("reads hydrate.config.ts and fills defaults", async () => {
    expect(await loadHydrateConfig(fixture)).toEqual({
      server: join(fixture, "src/main.ts"),
      client: undefined,
      outDir: join(fixture, "dist"),
      database: { migrations: join(fixture, "migrations"), seed: join(fixture, "src/database/seed.ts") },
      features: [],
      presets: [],
      worker: join(fixture, "src/worker.ts"),
    });
  });

  test("uses defaults when there is no config file", async () => {
    const dir = await tempDir();
    expect(await loadHydrateConfig(dir)).toEqual({
      server: join(dir, "src/main.ts"),
      client: undefined,
      outDir: join(dir, "dist"),
      database: { migrations: join(dir, "migrations"), seed: join(dir, "src/database/seed.ts") },
      features: [],
      presets: [],
      worker: join(dir, "src/worker.ts"),
    });
  });
});

describe("build", () => {
  test("produces a self-contained dist/ that runs without node_modules", async () => {
    const outDir = join(await tempDir(), "dist");
    const config = { ...(await loadHydrateConfig(fixture)), outDir };

    await build(config, { log: () => {} });

    expect(await Bun.file(join(outDir, "index.js")).exists()).toBe(true);
    const manifest = await Bun.file(join(outDir, "manifest.json")).json();
    expect(manifest.server).toBe("index.js");
    expect(manifest.client).toBeUndefined();
    expect(await Bun.file(join(outDir, "migrations/20260101000000_create_fixture.sql")).exists()).toBe(true);

    // Copy the artifact somewhere with no node_modules above it, like a deploy target.
    const deployDir = await tempDir();
    await cp(outDir, join(deployDir, "dist"), { recursive: true });
    const server = await spawnServer({ cmd: ["bun", "dist/index.js"], cwd: deployDir });
    try {
      expect(await (await fetch(server.url)).json()).toEqual({ built: true, nodeEnv: "production" });
    } finally {
      await server.stop();
    }
  });

  test("bundles the worker entry to dist/worker.js when there is one (spec-6 §12.2)", async () => {
    const outDir = join(await tempDir(), "dist");
    const manifest = await build({ ...(await loadHydrateConfig(fixture)), outDir }, { log: () => {} });

    expect(manifest.worker).toBe("worker.js");
    const deployDir = await tempDir();
    await cp(outDir, join(deployDir, "dist"), { recursive: true });
    const run = Bun.spawnSync(["bun", "dist/worker.js"], { cwd: deployDir, stdout: "pipe", env: { ...process.env, NODE_ENV: "production" } });
    expect(JSON.parse(run.stdout.toString())).toEqual({ worker: true, nodeEnv: "production" });
  });

  test("hydrate worker explains what is missing when there is no worker entry", async () => {
    const dir = await tempDir();
    const result = Bun.spawnSync(["bun", bin, "worker"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("No worker entry at src/worker.ts. Add one with: bun hydrate add jobs:database");
  });

  test("the build command writes to the configured out dir", async () => {
    const outDir = join(await tempDir(), "out");
    const { code, stdout } = runCli(["build", "--out-dir", outDir]);

    expect(code).toBe(0);
    expect(stdout).toContain("Build complete");
    expect(await Bun.file(join(outDir, "index.js")).exists()).toBe(true);
  });

  test("build leaves NODE_ENV as it found it, even when it fails, so later work in the process is unaffected", async () => {
    process.env.NODE_ENV = "test";
    const dir = await tempDir();
    await Bun.write(join(dir, "src/main.ts"), "export const = ;");

    await expect(build(await loadHydrateConfig(dir), { log: () => {} })).rejects.toThrow(/Server bundle failed/);
    expect(process.env.NODE_ENV).toBe("test");
  });

  test("build fails loudly when the server entry is broken", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "src/main.ts"), "export const = ;");

    await expect(build(await loadHydrateConfig(dir), { log: () => {} })).rejects.toThrow(/Server bundle failed/);
  });
});
