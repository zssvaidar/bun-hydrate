import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The v0.4 features on scratch projects (spec-6 §14): jobs, events, storage, Redis and fan-out.
 * Generated code must type-check, its generated tests must pass, and the worker and jobs:*
 * commands must work against a real (SQLite) database.
 */
const bin = join(import.meta.dir, "../../src/bin.ts");
const root = join(import.meta.dir, "../.tmp", `distributed-${process.pid}`);
const SLOW = 180_000;
const REDIS_URL = process.env.TEST_REDIS_URL;

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

const read = (cwd: string, path: string) => Bun.file(join(cwd, path)).text();
const exists = (cwd: string, path: string) => Bun.file(join(cwd, path)).exists();

beforeAll(() => mkdir(root, { recursive: true }));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rmdir(dirname(root)).catch(() => {});
});

describe("jobs:database, events and storage:local", () => {
  let cwd: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    cwd = await project("database");
    env = { DATABASE_URL: `sqlite://${join(cwd, "app.sqlite")}` };
  });

  test(
    "adding them wires the platform, scaffolds the worker, and the code type-checks and passes its tests",
    async () => {
      const added = hydrate(cwd, ["add", "jobs:database", "events", "storage:local", "--yes"]);
      expect(added.stderr).toBe("");
      expect(added.code).toBe(0);
      expect(added.stdout).toContain("New command: hydrate jobs:status");
      expect(added.stdout).toContain("bun hydrate db:migrate");

      const platform = await read(cwd, "src/platform/index.ts");
      expect(platform).toContain("  installJobs(container);\n  installEvents(app, container);\n  installStorage(app, container);\n}");
      expect(await read(cwd, "src/worker.ts")).toContain("startWorkerIn(app");
      expect(await read(cwd, "src/jobs/index.ts")).toContain("export const allJobs: JobDefinition[] = [];");
      expect(await read(cwd, "src/events/index.ts")).toContain("export const allListeners: ListenerDefinition[] = [];");

      expect(await typecheck(cwd)).toBe("");
      const { code, report } = runTests(cwd);
      expect(report).toContain(" 0 fail");
      expect(code).toBe(0);
    },
    SLOW,
  );

  test(
    "generate job, event and listener: the registries regenerate and everything still compiles",
    async () => {
      const job = hydrate(cwd, ["generate", "job", "send-welcome-email"]);
      expect(job.stderr).toBe("");
      expect(job.stdout).toContain("src/jobs/send-welcome-email.job.ts");
      expect(await read(cwd, "src/jobs/index.ts")).toContain("export const allJobs: JobDefinition[] = [sendWelcomeEmailJob];");

      expect(hydrate(cwd, ["generate", "event", "account.registered"]).code).toBe(0);
      expect(await read(cwd, "src/events/account-registered.event.ts")).toContain('defineEvent("account.registered"');

      const listener = hydrate(cwd, ["generate", "listener", "account.registered", "welcome", "--durable"]);
      expect(listener.stderr).toBe("");
      expect(await read(cwd, "src/events/listeners/welcome.listener.ts")).toContain('{ durable: true, name: "welcome" }');
      expect(await read(cwd, "src/events/index.ts")).toContain("export const allListeners: ListenerDefinition[] = [welcomeListener];");

      const manifest = await Bun.file(join(cwd, "hydrate.features.json")).json();
      expect(manifest.extra["job:send-welcome-email"]).toBeDefined();
      expect(manifest.extra["listener:welcome"]).toBeDefined();

      expect(await typecheck(cwd)).toBe("");
      expect(runTests(cwd).report).toContain(" 0 fail");
    },
    SLOW,
  );

  test("generators explain what they need", async () => {
    const other = await project("bare");
    expect(hydrate(other, ["generate", "job", "x"]).stderr).toContain("bun hydrate add jobs:database");
    expect(hydrate(cwd, ["generate", "listener", "order.shipped", "notify"]).stderr).toContain(
      "No event file src/events/order-shipped.event.ts. Create it with: bun hydrate generate event order.shipped",
    );
  });

  test(
    "jobs:* commands and the worker process run the app's jobs against the database",
    async () => {
      expect(hydrate(cwd, ["db:migrate"], { env }).code).toBe(0);

      const dispatched = hydrate(cwd, ["jobs:dispatch", "send-welcome-email", "--payload-stdin"], { env, stdin: '{"id":"u1"}' });
      expect(dispatched.stderr).toBe("");
      expect(dispatched.stdout).toMatch(/Dispatched send-welcome-email [0-9a-f-]{36}/);
      expect(hydrate(cwd, ["jobs:dispatch", "send-welcome-email", "--payload-stdin"], { env, stdin: "{}" }).stderr).toContain("Invalid payload");
      expect(hydrate(cwd, ["jobs:dispatch", "nope"], { env }).stderr).toContain('No job named "nope"');

      expect(hydrate(cwd, ["jobs:status"], { env }).stdout).toMatch(/default\s+1\s+0\s+0\s+0/);

      const worker = Bun.spawn(["bun", "src/worker.ts"], { cwd, env: { ...process.env, ...env, LOG_LEVEL: "info" }, stdout: "pipe", stderr: "pipe" });
      let status = "";
      for (let i = 0; i < 100; i++) {
        status = hydrate(cwd, ["jobs:status"], { env }).stdout;
        if (status.includes("No jobs")) break; // completed jobs without a key are deleted (spec-6 D11)
        await Bun.sleep(100);
      }
      worker.kill("SIGTERM");
      expect(await worker.exited).toBe(0);
      expect(status).toContain("No jobs");
      const logs = await new Response(worker.stdout).text();
      expect(logs).toMatch(/Job completed jobId=\S+ job=send-welcome-email attempt=1 traceId=/);
      expect(logs).toContain("Worker stopped");
    },
    SLOW,
  );

  test("jobs:status, jobs:dead, jobs:retry and jobs:purge", async () => {
    const { createDatabase } = await import("@bun-hydrate/database");
    const db = createDatabase({ url: env.DATABASE_URL! });
    await db.sql`insert into hydrate_jobs (id, queue, name, payload, state, priority, attempt, max_attempts, run_at, last_error, created_at, finished_at)
      values ('0190a0a0-0000-7000-8000-000000000001', 'default', 'send-welcome-email', '{"id":"u2"}', 'dead', 0, 3, 3, 0, 'Error: smtp down', 0, 1)`;
    await db.sql`insert into hydrate_jobs (id, queue, name, payload, state, priority, attempt, max_attempts, run_at, created_at)
      values ('0190a0a0-0000-7000-8000-000000000002', 'mail', 'retired-job', '{}', 'pending', 0, 0, 3, 0, ${Date.now() - 90_000})`;
    await db.close();

    // Workers never claim jobs they have no handler for (spec-6 D12): status shows them waiting.
    const status = hydrate(cwd, ["jobs:status"], { env }).stdout;
    expect(status).toMatch(/mail\s+1\s+0\s+0\s+0/);
    expect(status).toContain("retired-job (oldest 90s ago)");

    const dead = hydrate(cwd, ["jobs:dead"], { env });
    expect(dead.stdout).toContain("0190a0a0-0000-7000-8000-000000000001");
    expect(dead.stdout).toContain("Error: smtp down");

    expect(hydrate(cwd, ["jobs:retry", "--all-dead"], { env }).stdout).toContain("1 job(s) back to pending");
    expect(hydrate(cwd, ["jobs:status"], { env }).stdout).toMatch(/default\s+1\s+0\s+0\s+0/);
    expect(hydrate(cwd, ["jobs:purge"], { env }).stderr).toContain("--completed or --dead");
    expect(hydrate(cwd, ["jobs:purge", "--dead", "--older-than", "7d"], { env }).stdout).toContain("Purged 0 job(s)");
  });

  test(
    "removing them takes the generated files away and leaves the project compiling",
    async () => {
      const removed = hydrate(cwd, ["remove", "events", "jobs:database", "storage:local", "--yes", "--force"]);
      expect(removed.stderr).toBe("");
      expect(removed.stdout).toContain("Tables kept with their data: hydrate_jobs");
      expect(await exists(cwd, "src/platform/index.ts")).toBe(false);
      expect(await exists(cwd, "src/jobs/index.ts")).toBe(false);
      expect(await exists(cwd, "src/jobs/queue.ts")).toBe(false);
      // Yours: the worker entry, generated jobs, events and listeners stay.
      expect(await exists(cwd, "src/worker.ts")).toBe(true);
      expect(await exists(cwd, "src/jobs/send-welcome-email.job.ts")).toBe(true);
    },
    SLOW,
  );
});

test("events needs a queue: adding it alone adds jobs:database", async () => {
  const cwd = await project("events-only");
  const added = hydrate(cwd, ["add", "events", "--yes"]);
  expect(added.code).toBe(0);
  expect(added.stdout).toContain("jobs:database");
  expect(Object.keys((await Bun.file(join(cwd, "hydrate.features.json")).json()).features).sort()).toEqual(["events", "jobs:database"]);
});

test(
  "storage:s3 type-checks and its test passes against the fake S3",
  async () => {
    const cwd = await project("s3");
    expect(hydrate(cwd, ["add", "storage:s3", "--yes"]).code).toBe(0);
    expect(hydrate(cwd, ["add", "storage:local"]).stderr).toContain("storage:local cannot be installed together with storage:s3");
    expect(await typecheck(cwd)).toBe("");
    expect(runTests(cwd).report).toContain(" 0 fail");
  },
  SLOW,
);

describe.if(Boolean(REDIS_URL))("with Redis (TEST_REDIS_URL)", () => {
  test(
    "redis, jobs:redis, realtime:redis and cache:redis share one connection; tests pass; jobs:status works",
    async () => {
      const cwd = await project("redis");
      const added = hydrate(cwd, ["add", "jobs:redis", "realtime:redis", "cache:redis", "--yes"]);
      expect(added.stderr).toBe("");
      expect(await read(cwd, "src/platform/index.ts")).toContain(
        "  installRedis(app, container);\n  installRealtime(app, container);\n  installCache(app, container);\n  installJobs(container);\n}",
      );
      expect(await typecheck(cwd)).toBe("");
      const { report } = runTests(cwd);
      expect(report).toContain(" 0 fail");

      const env = { DATABASE_URL: `sqlite://${join(cwd, "app.sqlite")}`, REDIS_URL: REDIS_URL!, REDIS_PREFIX: `cli-test-${process.pid}:` };
      expect(hydrate(cwd, ["db:migrate"], { env }).code).toBe(0);
      const status = hydrate(cwd, ["jobs:status"], { env });
      expect(status.stderr).toBe("");
      expect(status.stdout).toContain("No jobs");
    },
    SLOW,
  );
});
