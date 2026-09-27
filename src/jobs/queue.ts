import { Database } from "@bun-hydrate/database";
import { token, type Container } from "@bun-hydrate/di";
import { DatabaseQueueAdapter, createQueue, type Queue } from "@bun-hydrate/queue";

/** Dispatch jobs with `container.get(AppQueue).dispatch(job, payload)`; a worker runs them. */
export const AppQueue = token<Queue>("AppQueue");

/**
 * Jobs wait in the app's database (hydrate_jobs), so a job dispatched inside db.transaction()
 * is committed or rolled back with the rest of the work: no job for data that was never saved.
 */
export function installJobs(container: Container): void {
  const db = container.get(Database);
  container.value(AppQueue, createQueue({ adapter: new DatabaseQueueAdapter({ db }), db }));
}
