import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const bin = join(import.meta.dir, "../src/bin.ts");
// Inside the repo so the generated code resolves the workspace's @bun-hydrate/* packages.
const scratch = join(import.meta.dir, ".tmp", `generate-${process.pid}`);

function hydrate(...args: string[]) {
  const result = Bun.spawnSync(["bun", bin, ...args], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

beforeAll(async () => {
  await mkdir(scratch, { recursive: true });
  await Bun.write(
    join(scratch, "tsconfig.json"),
    JSON.stringify({ extends: "../../../../../tsconfig.json", include: ["src"], exclude: [] }),
  );
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await rmdir(dirname(scratch)).catch(() => {}); // only succeeds once no other run is using it
});

describe("hydrate generate module", () => {
  let output: ReturnType<typeof hydrate>;

  beforeAll(() => {
    output = hydrate("generate", "module", "order-items");
  });

  test("writes the module files, shared helpers and a migration", async () => {
    expect(output.code).toBe(0);
    expect((await readdir(join(scratch, "src/modules/order-items"))).sort()).toEqual([
      "order-items.controller.ts",
      "order-items.module.ts",
      "order-items.repository.ts",
      "order-items.routes.ts",
      "order-items.schema.ts",
      "order-items.service.ts",
      "order-items.test.ts",
    ]);
    expect((await readdir(join(scratch, "src/shared"))).sort()).toEqual(["clock.ts", "pagination.ts"]);
    expect(await readdir(join(scratch, "migrations"))).toEqual([expect.stringMatching(/^\d{14}_create_order_items\.sql$/)]);
  });

  test("tells the developer how to wire it up", () => {
    expect(output.stdout).toContain('import { orderItemsModule } from "./modules/order-items/order-items.module";');
    expect(output.stdout).toContain('.route("/api/v1/order-items", orderItemsModule(container))');
    expect(output.stdout).toContain("bun hydrate db:migrate");
  });

  test("the generated code type-checks", () => {
    const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", scratch], { stdout: "pipe", stderr: "pipe" });
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
    expect(tsc.exitCode).toBe(0);
  }, 60_000);

  test("the generated tests pass unchanged", () => {
    const run = Bun.spawnSync(["bun", "test", "./src/modules/order-items"], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
    const report = run.stderr.toString();

    expect(report).toContain(" 0 fail");
    expect(report).toMatch(/ [1-9]\d* pass/);
    expect(run.exitCode).toBe(0);
  });

  test("refuses to overwrite an existing module", () => {
    const again = hydrate("generate", "module", "order-items");

    expect(again.code).toBe(1);
    expect(again.stderr).toContain("src/modules/order-items/order-items.schema.ts already exists");
  });

  test("keeps existing shared helpers", async () => {
    await Bun.write(join(scratch, "src/shared/clock.ts"), "// customized\n" + (await Bun.file(join(scratch, "src/shared/clock.ts")).text()));
    expect(hydrate("generate", "module", "invoices").code).toBe(0);
    expect(await Bun.file(join(scratch, "src/shared/clock.ts")).text()).toStartWith("// customized");
  });
});

describe("hydrate generate middleware", () => {
  test("writes a middleware and a passing test", async () => {
    const result = hydrate("generate", "middleware", "request-timer");

    expect(result.code).toBe(0);
    expect(await readdir(join(scratch, "src/middleware"))).toEqual(["request-timer.test.ts", "request-timer.ts"]);
    expect(await Bun.file(join(scratch, "src/middleware/request-timer.ts")).text()).toContain(
      "export function requestTimer(): Middleware",
    );

    const run = Bun.spawnSync(["bun", "test", "./src/middleware"], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
  });
});

describe("hydrate generate errors", () => {
  test("unknown generators and missing names are explained", () => {
    expect(hydrate("generate", "widget", "x").stderr).toContain('Unknown generator "widget". Available: module, middleware');
    expect(hydrate("generate", "module").stderr).toContain("Usage: hydrate generate module <name>");
  });
});

describe("hydrate generate module --auth", () => {
  const project = join(import.meta.dir, ".tmp", `generate-auth-${process.pid}`);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["bun", bin, ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };

  beforeAll(async () => {
    await mkdir(project, { recursive: true });
    await Bun.write(join(project, "tsconfig.json"), JSON.stringify({ extends: "../../../../../tsconfig.json", include: ["src"], exclude: [] }));
  });
  afterAll(() => rm(project, { recursive: true, force: true }));

  test("needs auth:core, and says how to add it", () => {
    const result = run("generate", "module", "invoices", "--auth");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--auth needs auth:core. Add it first: bun hydrate add auth:core");
  });

  test("guards every route with a permission and registers the permissions between the markers", async () => {
    expect(run("add", "auth:core", "--yes").code).toBe(0);
    const permissionsFile = join(project, "src/shared/permissions.ts");
    await Bun.write(permissionsFile, (await Bun.file(permissionsFile).text()).replace("] as const;", '  "reports.export",\n] as const;'));

    const result = run("generate", "module", "invoices", "--auth");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("invoices.read, invoices.create, invoices.update, invoices.delete");

    const routes = await Bun.file(join(project, "src/modules/invoices/invoices.routes.ts")).text();
    expect(routes).toContain('.get("/", requirePermission("invoices.read"), controller.list)');
    expect(routes).toContain('.delete("/:id", requirePermission("invoices.delete"), controller.remove)');

    const permissions = await Bun.file(permissionsFile).text();
    expect(permissions).toContain('  "invoices.read",\n  "invoices.create",\n  "invoices.update",\n  "invoices.delete",\n  // hydrate:permissions:end');
    expect(permissions).toContain('"reports.export",'); // outside the markers: untouched
  });

  test("the generated module type-checks and its tests (200 vs 403) pass", () => {
    const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", project], { stdout: "pipe", stderr: "pipe" });
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");

    const tests = Bun.spawnSync(["bun", "test", "./src/modules/invoices"], { cwd: project, stdout: "pipe", stderr: "pipe" });
    const report = tests.stderr.toString();
    expect(report).toContain(" 0 fail");
    expect(report).toContain(" 5 pass"); // the four CRUD tests plus the permission test
    expect(tests.exitCode).toBe(0);
  }, 60_000);
});
