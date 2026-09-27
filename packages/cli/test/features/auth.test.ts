import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDatabase } from "@bun-hydrate/database";

/**
 * End to end: `hydrate add` on scratch projects inside the repo (so @bun-hydrate/* resolve), then
 * the generated code must type-check and its generated tests must pass (spec-5 §12).
 */
const bin = join(import.meta.dir, "../../src/bin.ts");
const root = join(import.meta.dir, "../.tmp", `auth-${process.pid}`);
const SLOW = 120_000;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function hydrate(cwd: string, args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Run {
  const result = Bun.spawnSync(["bun", bin, ...args], {
    cwd,
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DATABASE_URL: "", ...options.env },
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function project(name: string): Promise<string> {
  const cwd = join(root, name);
  await mkdir(join(cwd, "migrations"), { recursive: true });
  await Bun.write(join(cwd, "tsconfig.json"), JSON.stringify({ extends: "../../../../../../tsconfig.json", include: ["src"], exclude: [] }));
  return cwd;
}

async function typecheck(cwd: string): Promise<string> {
  const tsc = Bun.spawn(["bunx", "tsc", "--noEmit", "-p", cwd], { stdout: "pipe", stderr: "pipe" });
  const output = (await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text());
  return (await tsc.exited) === 0 ? "" : output || "tsc failed";
}

function runTests(cwd: string): { code: number; report: string } {
  const run = Bun.spawnSync(["bun", "test", "./src"], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, report: run.stderr.toString() };
}

beforeAll(() => mkdir(root, { recursive: true }));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rmdir(dirname(root)).catch(() => {});
});

describe("presets on a fresh project", () => {
  for (const preset of ["auth", "auth:api", "auth:service"]) {
    test(
      `${preset}: generated code type-checks and its tests pass`,
      async () => {
        const cwd = await project(`preset-${preset.replace(":", "-")}`);
        const added = hydrate(cwd, ["add", preset, "--yes"]);
        expect(added.stderr).toBe("");
        expect(added.code).toBe(0);
        expect(added.stdout).toContain("Done.");

        expect(await typecheck(cwd)).toBe("");
        const { code, report } = runTests(cwd);
        expect(report).toContain(" 0 fail");
        expect(code).toBe(0);
      },
      SLOW,
    );
  }
});

test(
  "every feature on its own (with what it requires) type-checks",
  async () => {
    const features = [
      "auth:core",
      "auth:passwords",
      "auth:sessions",
      "auth:jwt",
      "auth:oidc",
      "auth:api-keys",
      "auth:login",
      "auth:react",
      "auth:ui-login",
      "auth:ui-register",
      "auth:ui-account",
    ];
    const projects = await Promise.all(features.map((feature) => project(`single-${feature.replace(":", "-")}`)));
    features.forEach((feature, i) => expect(hydrate(projects[i]!, ["add", feature, "--yes"]).code).toBe(0));

    const results: string[] = [];
    for (let i = 0; i < projects.length; i += 4) {
      results.push(...(await Promise.all(projects.slice(i, i + 4).map(typecheck))));
    }
    expect(Object.fromEntries(features.map((feature, i) => [feature, results[i]]))).toEqual(
      Object.fromEntries(features.map((feature) => [feature, ""])),
    );
  },
  SLOW * 2,
);

describe("add everything, then remove it step by step", () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await project("round-trip");
    expect(hydrate(cwd, ["add", "auth", "auth:ui-register", "auth:ui-account", "auth:api-keys", "--yes"]).code).toBe(0);
  });

  test("the plan wires pages and the composition root", async () => {
    expect(await Bun.file(join(cwd, "src/web/auth-pages.ts")).text()).toContain("export const authPages = { Login, Register, Account };");
    const rootFile = await Bun.file(join(cwd, "src/auth/index.ts")).text();
    expect(rootFile).toContain("sessionsFeature(authConfig.features?.sessions),");
    expect(rootFile).toContain("apiKeysFeature(authConfig.features?.apiKeys),");
  });

  const steps: [string, string[]][] = [
    ["account, register and api-key features", ["auth:ui-account", "auth:ui-register", "auth:api-keys"]],
    ["the login page and React bindings", ["auth:ui-login", "auth:react"]],
    ["the login routes", ["auth:login"]],
    ["sessions and passwords", ["auth:sessions", "auth:passwords"]],
    ["the core", ["auth:core"]],
  ];
  for (const [label, features] of steps) {
    test(
      `removing ${label} leaves a project that type-checks`,
      async () => {
        const removed = hydrate(cwd, ["remove", ...features, "--yes"]);
        expect(removed.stderr).toBe("");
        expect(removed.code).toBe(0);
        expect(await typecheck(cwd)).toBe("");
      },
      SLOW,
    );
  }

  test("afterwards only your files, the permission list and migration history remain", async () => {
    expect(await readdir(join(cwd, "src/auth"))).toEqual(["config.ts"]);
    expect(await readdir(join(cwd, "src/shared"))).toEqual(["permissions.ts"]);
    expect(await Bun.file(join(cwd, "src/web")).exists()).toBe(false);
    const migrations = await readdir(join(cwd, "migrations"));
    expect(migrations.filter((name) => name.includes("_add_auth_"))).toHaveLength(4);
    expect(migrations.filter((name) => name.includes("_remove_auth_"))).toHaveLength(4);
    expect(JSON.parse(await Bun.file(join(cwd, "hydrate.features.json")).text()).features).toEqual({});
  });
});

describe("auth console commands", () => {
  let cwd: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    cwd = await project("commands");
    env = { DATABASE_URL: `sqlite://${join(cwd, "app.sqlite")}` };
    expect(hydrate(cwd, ["add", "auth", "auth:api-keys", "--yes"]).code).toBe(0);
    expect(hydrate(cwd, ["db:migrate"], { env }).code).toBe(0);
  });

  test("create-user refuses a password argument, and reads it from stdin", async () => {
    const refused = hydrate(cwd, ["auth:create-user", "--email", "root@example.com", "--password", "hunter22"], { env });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Never pass a password as an argument");

    const created = hydrate(cwd, ["auth:create-user", "--email", "Root@Example.com", "--role", "admin", "--password-stdin"], {
      env,
      stdin: "correct horse battery\n",
    });
    expect(created.stderr).toBe("");
    expect(created.stdout).toContain("Created root@example.com (admin)");

    const db = createDatabase({ url: env.DATABASE_URL! });
    const [row] = await db.sql`select hash from account_passwords`;
    await db.close();
    expect(row.hash).toStartWith("$argon2id$");
  });

  test("set-role checks the role and ends the user's sessions", () => {
    expect(hydrate(cwd, ["auth:set-role", "--email", "root@example.com", "--role", "wizard"], { env }).stderr).toContain(
      'Unknown role "wizard". Roles: member, admin',
    );
    expect(hydrate(cwd, ["auth:set-role", "--email", "root@example.com", "--role", "member"], { env }).stdout).toContain(
      "root@example.com is now member; 0 session(s) ended",
    );
    expect(hydrate(cwd, ["auth:revoke-sessions", "--email", "root@example.com"], { env }).stdout).toContain("Ended 0 session(s)");
  });

  test("api-key create prints the key once; list never shows it; revoke works", async () => {
    const created = hydrate(cwd, ["auth:api-key", "create", "--name", "ci", "--permissions", "reports.read"], { env });
    const key = created.stdout.trim().split("\n").at(-1)!;
    const keyId = key.slice("hk_".length, "hk_".length + 12);
    const secret = key.slice("hk_".length + 13);
    expect(key).toMatch(/^hk_[a-z0-9]{12}_/);

    const listed = hydrate(cwd, ["auth:api-key", "list"], { env }).stdout;
    expect(listed).toContain(`${keyId}  ci  service:ci  [reports.read]  never used  active`);
    expect(listed).not.toContain(key);

    const db = createDatabase({ url: env.DATABASE_URL! });
    const [row] = await db.sql`select hash from api_keys`;
    await db.close();
    expect(row.hash).not.toContain(secret);

    expect(hydrate(cwd, ["auth:api-key", "revoke", keyId], { env }).stdout).toContain(`Revoked ${keyId}`);
  });

  test("permissions shows the role matrix", () => {
    expect(hydrate(cwd, ["auth:permissions"], { env }).stdout).toContain("No permissions are declared");
  });

  test("commands of features that are not installed explain how to get them", () => {
    const run = hydrate(cwd, ["auth:unknown-thing"], { env });
    expect(run.stderr).toContain('Unknown command "auth:unknown-thing"');

    const other = hydrate(cwd, ["remove", "auth:api-keys", "--yes"]);
    expect(other.code).toBe(0);
    expect(hydrate(cwd, ["auth:api-key", "list"], { env }).stderr).toContain(
      "hydrate auth:api-key comes with auth:api-keys. Add it with: bun hydrate add auth:api-keys",
    );
  });

  test("doctor is clean once migrations ran; it spots a hand-edited composition root, which sync restores", async () => {
    expect(hydrate(cwd, ["db:migrate"], { env }).code).toBe(0);
    expect(hydrate(cwd, ["doctor"], { env })).toMatchObject({ code: 0, stdout: "No problems found.\n" });

    const rootFile = join(cwd, "src/auth/index.ts");
    await Bun.write(rootFile, `${await Bun.file(rootFile).text()}// edited\n`);
    const drifted = hydrate(cwd, ["doctor"], { env });
    expect(drifted.code).toBe(1);
    expect(drifted.stdout).toContain("src/auth/index.ts is generated but was edited by hand");

    expect(hydrate(cwd, ["sync"]).code).toBe(0);
    expect(hydrate(cwd, ["doctor"], { env }).code).toBe(0);
  });
});
