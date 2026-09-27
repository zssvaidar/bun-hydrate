import { parseMigration } from "@bun-hydrate/database";
import { JOBS_MIGRATION } from "@bun-hydrate/queue";
import { defineFeature, type FeatureCommand, type FeatureOutput, type Slots } from "../define";
import bus from "./distributed-templates/bus.ts.tmpl" with { type: "text" };
import busTest from "./distributed-templates/bus.test.ts.tmpl" with { type: "text" };
import jobsCommands from "./distributed-templates/jobs.commands.ts.tmpl" with { type: "text" };
import queueDatabase from "./distributed-templates/queue-database.ts.tmpl" with { type: "text" };
import queueDatabaseTest from "./distributed-templates/queue-database.test.ts.tmpl" with { type: "text" };
import queueRedis from "./distributed-templates/queue-redis.ts.tmpl" with { type: "text" };
import queueRedisTest from "./distributed-templates/queue-redis.test.ts.tmpl" with { type: "text" };
import realtime from "./distributed-templates/realtime.ts.tmpl" with { type: "text" };
import realtimeTest from "./distributed-templates/realtime.test.ts.tmpl" with { type: "text" };
import redis from "./distributed-templates/redis.ts.tmpl" with { type: "text" };
import redisTest from "./distributed-templates/redis.test.ts.tmpl" with { type: "text" };
import storageLocal from "./distributed-templates/storage-local.ts.tmpl" with { type: "text" };
import storageLocalTest from "./distributed-templates/storage-local.test.ts.tmpl" with { type: "text" };
import storageS3 from "./distributed-templates/storage-s3.ts.tmpl" with { type: "text" };
import storageS3Test from "./distributed-templates/storage-s3.test.ts.tmpl" with { type: "text" };
import worker from "./distributed-templates/worker.ts.tmpl" with { type: "text" };
import { WIRING, platformRoot, type PlatformInstall } from "./platform";
import { generatedHeader, renderImports, type NamedImport } from "./render";

/** Redis, jobs, events, storage and fan-out (spec-6 §14.1), wired through installPlatform(). */

/** Slot `jobs.sources`: more job definitions for the worker, e.g. the durable event listeners. */
interface JobSource {
  imports: readonly NamedImport[];
  /** An expression of `container` giving JobDefinition[]. */
  expression: string;
}

/** `hydrate generate job` contributes to `jobs.all` and `generate listener` to `events.listeners`. */
const jobsIndex: FeatureOutput = {
  kind: "file",
  path: "src/jobs/index.ts",
  render(slots: Slots) {
    const jobs = slots.get<NamedImport>("jobs.all");
    const sources = slots.get<JobSource>("jobs.sources");
    return [
      generatedHeader("Jobs live in the *.job.ts files next to it; `hydrate generate job <name>` adds one."),
      'import type { Container } from "@bun-hydrate/di";',
      'import type { JobDefinition } from "@bun-hydrate/queue";',
      ...renderImports([...sources.flatMap((source) => source.imports), ...jobs]),
      "",
      "/** Every job defined in this app, e.g. for tests and `hydrate jobs:dispatch`. */",
      `export const allJobs: JobDefinition[] = [${jobs.map((job) => job.name).join(", ")}];`,
      "",
      "/** What the worker runs: the jobs above, plus the jobs behind durable event listeners. */",
      "export function workerHandlers(container: Container): JobDefinition[] {",
      `  return [${["...allJobs", ...sources.map((source) => `...${source.expression}`)].join(", ")}];`,
      "}",
      "",
    ].join("\n");
  },
};

const eventsIndex: FeatureOutput = {
  kind: "file",
  path: "src/events/index.ts",
  render(slots: Slots) {
    const listeners = slots.get<NamedImport>("events.listeners");
    return [
      generatedHeader("Listeners live in src/events/listeners/; `hydrate generate listener <event> <name>` adds one."),
      'import type { ListenerDefinition } from "@bun-hydrate/events";',
      ...renderImports(listeners),
      "",
      "/** Every listener, registered on AppEvents by installEvents(). */",
      `export const allListeners: ListenerDefinition[] = [${listeners.map((listener) => listener.name).join(", ")}];`,
      "",
    ].join("\n");
  },
};

const install = (from: string, name: string, call: string, order: number): { "platform.install": PlatformInstall[] } => ({
  "platform.install": [{ from, name, call, order }],
});

const JOBS_COMMANDS_MODULE = "src/jobs/commands.ts";

const JOBS_COMMANDS: FeatureCommand[] = [
  { name: "jobs:status", usage: "", description: "Jobs per queue and state, and pending jobs no code here can run" },
  { name: "jobs:dead", usage: "[--queue <queue>] [--job <name>]", description: "Dead jobs with their last error, newest first" },
  { name: "jobs:retry", usage: "<id…> | --all-dead [--job <name>]", description: "Dead jobs back to pending with fresh attempts" },
  { name: "jobs:purge", usage: "--completed | --dead [--older-than 7d]", description: "Delete finished jobs" },
  { name: "jobs:dispatch", usage: "<name> [--payload-stdin]", description: "Enqueue a job by hand (the payload is validated)" },
];

const WORKER_ENV = [
  { name: "WORKER_CONCURRENCY", description: "Jobs in flight at once per worker process (default 10)" },
  { name: "WORKER_QUEUES", description: "Comma-separated queues a worker serves (default: all its jobs use)" },
  { name: "WORKER_PORT", description: "Port for the worker's /health, /ready and /metrics (default: none)" },
];

const JOBS_INSTRUCTIONS = [
  WIRING,
  "Run jobs with a separate process: bun hydrate worker (in production: bun dist/worker.js, built by hydrate build)",
];

const { up: jobsUp, down: jobsDown = "drop table if exists hydrate_jobs;" } = parseMigration("hydrate_jobs", JOBS_MIGRATION);

/** Shared by both queue adapters: they differ only in src/jobs/queue.ts. */
function jobsFeature(adapter: "database" | "redis") {
  const other = adapter === "database" ? "jobs:redis" : "jobs:database";
  return defineFeature({
    id: `jobs:${adapter}`,
    description:
      adapter === "database"
        ? "Background jobs in the database (committed with your transaction), a worker process and jobs:* commands"
        : "Background jobs in Redis, a worker process and jobs:* commands",
    ...(adapter === "redis" ? { requires: ["redis"] } : {}),
    conflicts: [other],
    files: {
      "src/jobs/queue.ts": adapter === "database" ? queueDatabase : queueRedis,
      "src/jobs/queue.test.ts": adapter === "database" ? queueDatabaseTest : queueRedisTest,
      [JOBS_COMMANDS_MODULE]: jobsCommands,
    },
    scaffold: { "src/worker.ts": worker },
    ...(adapter === "database" ? { migration: { up: jobsUp, down: jobsDown, tables: ["hydrate_jobs"] } } : {}),
    env: WORKER_ENV,
    contributes: install("../jobs/queue", "installJobs", "installJobs(container)", 50),
    outputs: [platformRoot, jobsIndex],
    commands: JOBS_COMMANDS,
    commandsModule: JOBS_COMMANDS_MODULE,
    instructions: JOBS_INSTRUCTIONS,
  });
}

export const distributedFeatures = [
  defineFeature({
    id: "redis",
    description: "One shared Redis connection (AppRedis) for the cache, jobs and fan-out",
    files: { "src/platform/redis.ts": redis, "src/platform/redis.test.ts": redisTest },
    env: [
      { name: "REDIS_URL", description: "redis://… (or rediss://…) for the app's Redis", required: true },
      { name: "REDIS_PREFIX", description: 'Prefix for every key and channel (default "app:")' },
    ],
    contributes: install("./redis", "installRedis", "installRedis(app, container)", 5),
    outputs: [platformRoot],
    instructions: [WIRING],
  }),
  jobsFeature("database"),
  jobsFeature("redis"),
  defineFeature({
    id: "events",
    description: "Typed events: listeners after commit in process, or durable as jobs on any worker",
    requires: [["jobs:database", "jobs:redis"]],
    files: { "src/events/bus.ts": bus, "src/events/bus.test.ts": busTest },
    contributes: {
      ...install("../events/bus", "installEvents", "installEvents(app, container)", 55),
      "jobs.sources": [{ imports: [{ from: "../events/bus", name: "AppEvents" }], expression: "container.get(AppEvents).jobs()" }],
    },
    outputs: [platformRoot, eventsIndex],
    instructions: [WIRING, "Add events with: bun hydrate generate event <name>, then listener <event> <name> [--durable]"],
  }),
  defineFeature({
    id: "storage:local",
    description: "File storage on this server's disk (AppStorage), served through signed /files URLs",
    conflicts: ["storage:s3"],
    files: { "src/platform/storage.ts": storageLocal, "src/platform/storage.test.ts": storageLocalTest },
    env: [
      { name: "STORAGE_ROOT", description: "Directory for stored files (default data/storage)" },
      { name: "STORAGE_SIGNING_KEY", description: "At least 32 random characters that sign /files URLs (required in production)" },
    ],
    contributes: install("./storage", "installStorage", "installStorage(app, container)", 60),
    outputs: [platformRoot],
    instructions: [WIRING, "Keep stored files out of git: add data/storage/ (or your STORAGE_ROOT) to .gitignore"],
  }),
  defineFeature({
    id: "storage:s3",
    description: "File storage in S3 or an S3-compatible store (AppStorage), with presigned URLs",
    conflicts: ["storage:local"],
    files: { "src/platform/storage.ts": storageS3, "src/platform/storage.test.ts": storageS3Test },
    env: [
      { name: "S3_BUCKET", description: "The bucket stored files go to", required: true },
      { name: "S3_REGION", description: "The bucket's region (default: AWS_REGION)" },
      { name: "S3_ENDPOINT", description: "For S3-compatible stores such as MinIO or R2 (default: AWS)" },
      { name: "S3_ACCESS_KEY_ID", description: "Access key (default: AWS_ACCESS_KEY_ID)" },
      { name: "S3_SECRET_ACCESS_KEY", description: "Secret key (default: AWS_SECRET_ACCESS_KEY)" },
    ],
    contributes: install("./storage", "installStorage", "installStorage(container)", 60),
    outputs: [platformRoot],
    instructions: [WIRING],
  }),
  defineFeature({
    id: "realtime:redis",
    description: "WebSocket fan-out across instances: app.publish() goes through Redis",
    requires: ["redis"],
    files: { "src/platform/realtime.ts": realtime, "src/platform/realtime.test.ts": realtimeTest },
    contributes: install("./realtime", "installRealtime", "installRealtime(app, container)", 6),
    outputs: [platformRoot],
    instructions: [WIRING],
  }),
];
