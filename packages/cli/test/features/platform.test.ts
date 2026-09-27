import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** cache, rate-limit, metrics and CORS features on a scratch project (spec-5 §9.7). */
const bin = join(import.meta.dir, "../../src/bin.ts");
const cwd = join(import.meta.dir, "../.tmp", `platform-${process.pid}`);
const SLOW = 120_000;

function hydrate(...args: string[]) {
  const result = Bun.spawnSync(["bun", bin, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, DATABASE_URL: "" } });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function typecheck(): Promise<string> {
  const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", cwd], { stdout: "pipe", stderr: "pipe" });
  return tsc.exitCode === 0 ? "" : tsc.stdout.toString() + tsc.stderr.toString();
}

function runTests(): string {
  return Bun.spawnSync(["bun", "test", "./src"], { cwd, stdout: "pipe", stderr: "pipe" }).stderr.toString();
}

beforeAll(async () => {
  await mkdir(cwd, { recursive: true });
  await Bun.write(join(cwd, "tsconfig.json"), JSON.stringify({ extends: "../../../../../tsconfig.json", include: ["src"], exclude: [] }));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rmdir(dirname(cwd)).catch(() => {});
});

describe("platform features", () => {
  test(
    "all four together: one installPlatform(), wiring explained once, code type-checks and tests pass",
    async () => {
      const added = hydrate("add", "rate-limit", "cache:memory", "metrics", "security:cors", "--yes");
      expect(added.stderr).toBe("");
      expect(added.stdout.match(/installPlatform\(app, container\) before installAuth/g)).toHaveLength(1);

      const root = await Bun.file(join(cwd, "src/platform/index.ts")).text();
      expect(root).toContain(
        "  installMetrics(app);\n  installCors(app);\n  installRateLimit(app);\n  installCache(container);\n}",
      );

      expect(await typecheck()).toBe("");
      const report = runTests();
      expect(report).toContain(" 0 fail");
      expect(report).toMatch(/ [5-9] pass/);
    },
    SLOW,
  );

  test("memory and Redis caches conflict", () => {
    expect(hydrate("add", "cache:redis").stderr).toContain("cache:redis cannot be installed together with cache:memory (installed)");
  });

  test(
    "switching to the Redis cache adds the shared redis, keeps the project compiling; doctor asks for REDIS_URL",
    async () => {
      expect(hydrate("remove", "cache:memory", "--yes").code).toBe(0);
      expect(hydrate("add", "cache:redis", "--yes").code).toBe(0);
      const root = await Bun.file(join(cwd, "src/platform/index.ts")).text();
      expect(root).toContain("  installRedis(app, container);\n  installMetrics(app);");
      expect(root).toContain("installCache(app, container);");
      expect(await typecheck()).toBe("");
      expect(runTests()).toContain(" 0 fail");

      const doctor = Bun.spawnSync(["bun", bin, "doctor"], {
        cwd,
        stdout: "pipe",
        env: { ...process.env, DATABASE_URL: "", REDIS_URL: "" },
      });
      expect(doctor.stdout.toString()).toContain("REDIS_URL is not set (redis");
    },
    SLOW,
  );

  test("removing them all removes the generated installPlatform()", async () => {
    expect(hydrate("remove", "rate-limit", "cache:redis", "redis", "metrics", "security:cors", "--yes").code).toBe(0);
    expect(await Bun.file(join(cwd, "src/platform")).exists()).toBe(false);
    expect(await Bun.file(join(cwd, "src/platform/index.ts")).exists()).toBe(false);
  });
});
