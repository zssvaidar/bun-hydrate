import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer, type RunningServer } from "@bun-hydrate/testing";

export const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "packages/cli/src/bin.ts");

export const E2E_ENV = { HOST: "127.0.0.1", PORT: "0", LOG_FORMAT: "json" };

let artifact: Promise<string> | undefined;

/**
 * Builds the reference app once per test run with the real CLI, then copies only dist/ into a
 * fresh directory with no node_modules — the same shape `build.sh` ships and `deploy.sh` runs.
 */
export function buildArtifact(): Promise<string> {
  artifact ??= (async () => {
    const buildDir = await mkdtemp(join(tmpdir(), "hydrate-build-"));
    const result = Bun.spawnSync(["bun", CLI, "build", "--out-dir", join(buildDir, "dist")], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`hydrate build failed:\n${result.stderr}\n${result.stdout}`);

    const releaseDir = await mkdtemp(join(tmpdir(), "hydrate-release-"));
    await cp(join(buildDir, "dist"), join(releaseDir, "dist"), { recursive: true });
    await rm(buildDir, { recursive: true, force: true });
    return releaseDir;
  })();
  return artifact;
}

export async function startArtifact(): Promise<RunningServer> {
  const releaseDir = await buildArtifact();
  return spawnServer({ cmd: ["bun", "dist/index.js"], cwd: releaseDir, env: E2E_ENV });
}
