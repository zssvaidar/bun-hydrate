import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, parseMigration, type Database } from "@bun-hydrate/database";
import { DatabaseQueueAdapter, JOBS_MIGRATION, createQueue, defineJob } from "../src";
import { schema } from "@bun-hydrate/validation";

/** Real processes and signals (spec-6 §11): what a deploy or a crash does to a job in flight. */
const FIXTURE = join(import.meta.dir, "fixtures/worker-process.ts");
const slow = defineJob({ name: "slow", payload: schema.object({}), handle: () => {} });

let dir: string;
let url: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hydrate-worker-process-"));
  url = `sqlite://${join(dir, "jobs.sqlite")}`;
  db = createDatabase({ url });
  await db.sql.unsafe(parseMigration("jobs", JOBS_MIGRATION).up);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

function startWorker(jobMs: number) {
  const child = Bun.spawn(["bun", FIXTURE], { env: { ...process.env, DATABASE_URL: url, JOB_MS: String(jobMs) }, stdout: "pipe" });
  const lines: string[] = [];
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) lines.push(...chunk.value.split("\n").filter(Boolean));
  })();
  const printed = async (line: string) => {
    for (let i = 0; i < 200 && !lines.includes(line); i++) await Bun.sleep(25);
    return lines.includes(line);
  };
  return { child, lines, printed };
}

async function dispatchSlow() {
  const queue = createQueue({ adapter: new DatabaseQueueAdapter({ db }) });
  return (await queue.dispatch(slow, {})).id;
}

const job = async (id: string) => (await new DatabaseQueueAdapter({ db }).get(id))!;

test("SIGTERM mid-job: the worker exits 0 and the job is pending again, its attempt not counted", async () => {
  const id = await dispatchSlow();
  const worker = startWorker(60_000);
  expect(await worker.printed("started attempt 1")).toBe(true);

  worker.child.kill("SIGTERM");
  expect(await worker.child.exited).toBe(0);
  expect(await job(id)).toMatchObject({ state: "pending", attempt: 0 });
}, 15_000);

test("SIGKILL mid-job: after the lease runs out another worker completes it, on attempt 2", async () => {
  const id = await dispatchSlow();
  const crashed = startWorker(60_000);
  expect(await crashed.printed("started attempt 1")).toBe(true);
  crashed.child.kill("SIGKILL");
  await crashed.child.exited;

  const next = startWorker(10);
  expect(await next.printed("finished attempt 2")).toBe(true);
  next.child.kill("SIGTERM");
  expect(await next.child.exited).toBe(0);
  expect(await new DatabaseQueueAdapter({ db }).get(id)).toBeUndefined(); // completed without a key: deleted
}, 15_000);
