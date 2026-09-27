import { join } from "node:path";
import { App, ConfigError, createLogger, defineConfig, env } from "@bun-hydrate/core";
import { Migrator, createDatabase } from "@bun-hydrate/database";
import { startWorkerIn } from "@bun-hydrate/queue";
import { auth } from "./auth";
import { loadConfig } from "./config";
import { createContainer } from "./container";
import { workerHandlers } from "./jobs";
import { cleanupExpiredSessionsJob } from "./jobs/cleanup-expired-sessions.job";
import { AppQueue } from "./jobs/queue";
import { installPlatform } from "./platform";

/**
 * The worker process (spec-6 §4): `bun hydrate worker` in development, `bun dist/worker.js` in
 * production. It runs the jobs in src/jobs and the durable event listeners; it serves no pages.
 */
function loadWorkerConfig() {
  try {
    return {
      ...loadConfig(),
      ...defineConfig({
        concurrency: env.integer("WORKER_CONCURRENCY").default(10),
        // Comma-separated queues this worker serves. Default: every queue its jobs use.
        queues: env.string("WORKER_QUEUES").optional(),
        // Serves /health, /ready and /metrics for orchestrators. Default: no port.
        workerPort: env.port("WORKER_PORT").optional(),
      }),
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

const config = loadWorkerConfig();
const db = createDatabase({ url: config.databaseUrl });
const container = createContainer({ config, db });
// Stop hooks run in reverse: the database, registered first, closes last.
const app = new App({ logger: createLogger({ level: config.logLevel, format: config.logFormat }) })
  .readinessCheck("database", () => db.ping())
  .onStop(() => db.close());

// The web process migrates (MIGRATE_ON_START or `hydrate db:migrate`); a worker never runs on an older schema.
app.onStart(async () => {
  const migrations = join(import.meta.dir, process.env.NODE_ENV === "production" ? "migrations" : "../migrations");
  const { pending } = await new Migrator({ db, directory: migrations }).status();
  if (pending.length > 0) throw new Error(`Pending migrations: ${pending.join(", ")}. Run bun hydrate db:migrate first.`);
});

installPlatform(app, container);
// Services only: the worker needs SessionManager for the cleanup job, not the auth routes.
auth.register(container);

const worker = startWorkerIn(app, {
  queue: container.get(AppQueue),
  handlers: workerHandlers(container),
  container,
  concurrency: config.concurrency,
  logger: app.logger,
  ...(config.queues ? { queues: config.queues.split(",").map((queue) => queue.trim()) } : {}),
});

// One run per slot, however many workers there are.
worker.schedule(cleanupExpiredSessionsJob, "17 * * * *");

if (config.workerPort === undefined) await app.run();
else await app.listen({ port: config.workerPort, hostname: config.host });
