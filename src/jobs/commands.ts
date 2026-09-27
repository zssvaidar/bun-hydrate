import { CommandUsageError, optionalOption, type CommandContext, type CommandHandler } from "@bun-hydrate/cli/commands";
import { App, createLogger, parseDuration } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { JOB_STATES, JobPayloadError, type JobDefinition, type JobFilter, type JobRecord, type Queue } from "@bun-hydrate/queue";
import { installPlatform } from "../platform";
import { workerHandlers } from "./index";
import { AppQueue } from "./queue";

/**
 * `hydrate jobs:*` (spec-6 §14.3). They run the app's own platform setup on the command's
 * database, so they see the same queue (and Redis) as the web and worker processes.
 */
async function withJobs<T>(ctx: CommandContext, use: (queue: Queue, handlers: JobDefinition[]) => Promise<T>): Promise<T> {
  const app = new App({ logger: createLogger({ level: "error" }), health: false });
  const container = new Container().value(Database, ctx.db);
  installPlatform(app, container);
  await app.run({ handleSignals: false });
  try {
    return await use(container.get(AppQueue), workerHandlers(container));
  } finally {
    await app.stop();
  }
}

/** Every job matching `filter`, newest first. */
async function listAll(queue: Queue, filter: JobFilter): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await queue.adapter.list({ ...filter, limit: 500, ...(cursor ? { cursor } : {}) });
    jobs.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return jobs;
}

const age = (since: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
};

/** `hydrate jobs:status`: jobs per queue and state, and pending jobs no code here can run. */
export const statusCommand: CommandHandler = (ctx) =>
  withJobs(ctx, async (queue, handlers) => {
    const counts = await queue.adapter.counts();
    const queues = Object.keys(counts).sort();
    if (queues.length === 0) return ctx.print("No jobs");

    ctx.print(["queue".padEnd(20), ...JOB_STATES.map((state) => state.padStart(10))].join(""));
    for (const name of queues) ctx.print([name.padEnd(20), ...JOB_STATES.map((state) => String(counts[name]![state]).padStart(10))].join(""));

    // Workers only claim jobs they have a handler for (spec-6 D12): these wait for one.
    const known = new Set(handlers.map((handler) => handler.name));
    const waiting = new Map<string, number>();
    for (const job of await listAll(queue, { state: "pending" })) {
      if (!known.has(job.name)) waiting.set(job.name, Math.min(waiting.get(job.name) ?? Infinity, job.createdAt));
    }
    if (waiting.size === 0) return;
    ctx.print("\nPending with no handler in this code (deployed yet?):");
    for (const [name, oldest] of waiting) ctx.print(`  ${name} (oldest ${age(oldest)} ago)`);
  });

/** `hydrate jobs:dead [--queue q] [--job name]`: jobs out of attempts, newest first, with their last error. */
export const deadCommand: CommandHandler = (ctx) =>
  withJobs(ctx, async (queue) => {
    const filter = { state: "dead" as const, queue: optionalOption(ctx, "queue"), name: optionalOption(ctx, "job") };
    const { items } = await queue.adapter.list({ ...filter, limit: 50 });
    if (items.length === 0) return ctx.print("No dead jobs");
    for (const job of items) {
      const error = (job.lastError ?? "").split("\n")[0];
      ctx.print(`${job.id}  ${job.name}  queue=${job.queue}  attempts=${job.attempt}/${job.maxAttempts}  ${error}`);
    }
  });

/** `hydrate jobs:retry <id…> | --all-dead [--job name]`: dead jobs back to pending, attempts reset. */
export const retryCommand: CommandHandler = (ctx) =>
  withJobs(ctx, async (queue) => {
    const ids =
      ctx.options["all-dead"] === true
        ? (await listAll(queue, { state: "dead", name: optionalOption(ctx, "job") })).map((job) => job.id)
        : [...ctx.args];
    if (ids.length === 0) throw new CommandUsageError("Name the jobs to retry: jobs:retry <id…>, or --all-dead [--job <name>]");
    ctx.print(`${await queue.adapter.retry(ids, Date.now())} job(s) back to pending`);
  });

/** `hydrate jobs:purge --completed | --dead [--older-than 7d]`: deletes finished jobs. */
export const purgeCommand: CommandHandler = (ctx) =>
  withJobs(ctx, async (queue) => {
    const state = ctx.options.completed === true ? "completed" : ctx.options.dead === true ? "dead" : undefined;
    if (!state) throw new CommandUsageError("Say which jobs to purge: --completed or --dead [--older-than 7d]");
    const olderThan = optionalOption(ctx, "older-than") ?? "0s";
    if (!/^\d+(ms|s|m|h|d)$/.test(olderThan)) throw new CommandUsageError("--older-than takes a duration such as 30m, 12h or 7d");
    ctx.print(`Purged ${await queue.adapter.purge({ state, finishedBefore: Date.now() - parseDuration(olderThan) })} job(s)`);
  });

/** `hydrate jobs:dispatch <name> [--payload-stdin]`: enqueues a job by hand, e.g. to backfill. The payload is validated. */
export const dispatchCommand: CommandHandler = (ctx) =>
  withJobs(ctx, async (queue, handlers) => {
    const [name] = ctx.args;
    if (!name) throw new CommandUsageError("Usage: jobs:dispatch <name> [--payload-stdin]");
    const job = handlers.find((handler) => handler.name === name);
    if (!job) throw new CommandUsageError(`No job named "${name}". Known: ${handlers.map((handler) => handler.name).join(", ") || "none"}`);

    let payload: unknown = {};
    if (ctx.options["payload-stdin"] === true) {
      try {
        payload = JSON.parse(await ctx.readInput());
      } catch {
        throw new CommandUsageError("The payload on stdin is not valid JSON");
      }
    }
    const { id } = await queue.dispatch(job, payload).catch((error: unknown) => {
      throw error instanceof JobPayloadError ? new CommandUsageError(error.message) : error;
    });
    ctx.print(`Dispatched ${name} ${id}`);
  });

/** Run with `bun hydrate <name>`; the CLI opens the database from DATABASE_URL. */
export const commands: Record<string, CommandHandler> = {
  "jobs:status": statusCommand,
  "jobs:dead": deadCommand,
  "jobs:retry": retryCommand,
  "jobs:purge": purgeCommand,
  "jobs:dispatch": dispatchCommand,
};
