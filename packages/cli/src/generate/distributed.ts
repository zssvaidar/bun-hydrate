import { join } from "node:path";
import { applyPlan } from "../features/apply";
import { createRegistry } from "../features/catalog";
import { readManifest, type Manifest } from "../features/manifest";
import { planSync } from "../features/plan";
import type { GenerateOptions } from "./index";
import { moduleNames } from "./names";

/**
 * `generate job`, `event` and `listener` (spec-6 §14.2). Jobs and listeners are recorded in
 * hydrate.features.json, so the generated registries (src/jobs/index.ts, src/events/index.ts)
 * list them without anyone editing a registry by hand.
 */

const JOB_NAME = /^[a-z][a-z0-9-]*$/;
const EVENT_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export async function generateJob(name: string, options: GenerateOptions): Promise<void> {
  const { cwd, log = console.log } = options;
  if (!JOB_NAME.test(name)) throw new Error(`Job names are kebab-case, e.g. send-welcome-email (got "${name}")`);
  const manifest = await requireFeature(cwd, ["jobs:database", "jobs:redis"], "jobs:database");
  const n = moduleNames(name);
  const exported = `${n.camel}Job`;

  await writeNew(cwd, {
    [`src/jobs/${n.kebab}.job.ts`]: jobTemplate(name, exported),
    [`src/jobs/${n.kebab}.job.test.ts`]: jobTestTemplate(n.kebab, exported),
  });
  manifest.extra[`job:${name}`] = { "jobs.all": [{ from: `./${n.kebab}.job`, name: exported }] };
  await syncOutputs(manifest, options);
  log(`Created src/jobs/${n.kebab}.job.ts and its test; added ${exported} to src/jobs/index.ts`);
  log(`\nDispatch it with: container.get(AppQueue).dispatch(${exported}, { … }). A worker runs it: bun hydrate worker`);
}

export async function generateEvent(name: string, options: GenerateOptions): Promise<void> {
  const { cwd, log = console.log } = options;
  if (!EVENT_NAME.test(name)) throw new Error(`Event names are dotted and past tense, e.g. order.shipped (got "${name}")`);
  await requireFeature(cwd, ["events"], "events");
  const n = moduleNames(name);

  await writeNew(cwd, { [eventPath(name)]: eventTemplate(name, n.pascal) });
  log(`Created ${eventPath(name)}`);
  log(`\nEmit it with: container.get(AppEvents).emit(${n.pascal}, { … }). Listen with: bun hydrate generate listener ${name} <name>`);
}

export async function generateListener(event: string, name: string, options: GenerateOptions & { durable?: boolean }): Promise<void> {
  const { cwd, log = console.log, durable = false } = options;
  if (!JOB_NAME.test(name)) throw new Error(`Listener names are kebab-case, e.g. send-welcome (got "${name}")`);
  const manifest = await requireFeature(cwd, ["events"], "events");
  if (!(await Bun.file(join(cwd, eventPath(event))).exists())) {
    throw new Error(`No event file ${eventPath(event)}. Create it with: bun hydrate generate event ${event}`);
  }
  const n = moduleNames(name);
  const exported = `${n.camel}Listener`;
  const path = `src/events/listeners/${n.kebab}.listener.ts`;

  await writeNew(cwd, { [path]: listenerTemplate(event, name, exported, durable) });
  manifest.extra[`listener:${name}`] = { "events.listeners": [{ from: `./listeners/${n.kebab}.listener`, name: exported }] };
  await syncOutputs(manifest, options);
  log(`Created ${path}; added ${exported} to src/events/index.ts`);
  if (durable) log("\nIt runs as a job on the worker (bun hydrate worker), retried until it succeeds.");
}

function eventPath(event: string): string {
  return `src/events/${moduleNames(event).kebab}.event.ts`;
}

async function requireFeature(cwd: string, any: readonly string[], suggestion: string): Promise<Manifest> {
  const manifest = await readManifest(cwd);
  if (!any.some((id) => manifest.features[id])) throw new Error(`This needs ${any.join(" or ")}. Add it first: bun hydrate add ${suggestion}`);
  return manifest;
}

async function writeNew(cwd: string, files: Record<string, string>): Promise<void> {
  for (const path of Object.keys(files)) {
    if (await Bun.file(join(cwd, path)).exists()) throw new Error(`${path} already exists; nothing was generated`);
  }
  for (const [path, content] of Object.entries(files)) await Bun.write(join(cwd, path), content);
}

async function syncOutputs(manifest: Manifest, { cwd, config }: GenerateOptions): Promise<void> {
  const project = { cwd, migrations: config.database.migrations };
  await applyPlan(project, await planSync(project, createRegistry(config), manifest));
}

function jobTemplate(name: string, exported: string): string {
  return `import { defineJob } from "@bun-hydrate/queue";
import { schema } from "@bun-hydrate/validation";

/**
 * Dispatch with \`container.get(AppQueue).dispatch(${exported}, { id })\`; a worker runs it.
 * The payload is stored as JSON and validated again when the job runs.
 */
export const ${exported} = defineJob({
  // Stored with every job: renaming it strands jobs already queued.
  name: "${name}",
  payload: schema.object({ id: schema.string() }),
  // queue: "default", priority: 0, retry: { attempts: 3, backoff: "exponential" }, timeout: "5m",
  // inject: [SomeService], then use \`services\` below.
  async handle(payload, { log, job }) {
    // Pass job.signal to fetch() and queries: it aborts on timeout and on shutdown.
    log.info("${name}", { id: payload.id, attempt: job.attempt });
  },
});
`;
}

function jobTestTemplate(kebab: string, exported: string): string {
  return `import { expect, test } from "bun:test";
import { createTestQueue } from "@bun-hydrate/testing/queue";
import { ${exported} } from "./${kebab}.job";

test("runs to completion", async () => {
  const queue = createTestQueue();
  await queue.dispatch(${exported}, { id: "1" });
  expect(await queue.dispatched(${exported})).toEqual([{ id: "1" }]);

  await queue.runAll({ handlers: [${exported}] });
  expect(await queue.dispatched(${exported})).toEqual([]);
});
`;
}

function eventTemplate(name: string, exported: string): string {
  return `import { defineEvent } from "@bun-hydrate/events";
import { schema } from "@bun-hydrate/validation";

/** Emitted with \`container.get(AppEvents).emit(${exported}, { id })\`; the payload is validated. */
export const ${exported} = defineEvent("${name}", schema.object({ id: schema.string() }));
`;
}

function listenerTemplate(event: string, name: string, exported: string, durable: boolean): string {
  const eventExport = moduleNames(event).pascal;
  const what = durable
    ? "Durable: a job on the worker, at least once, retried until it succeeds. Keep the name stable."
    : "In process: after the emitting transaction commits, at most once. Errors are logged, never thrown to the emitter.";
  return `import { defineListener } from "@bun-hydrate/events";
import { ${eventExport} } from "../${moduleNames(event).kebab}.event";

/** Runs on each ${event}. ${what} */
export const ${exported} = defineListener(
  ${eventExport},
  async (payload, { log }) => {
    log.info("${event} → ${name}", { id: payload.id });
  },
  { ${durable ? "durable: true, " : ""}name: "${name}" },
);
`;
}
