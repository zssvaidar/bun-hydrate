// A worker process for test/process.test.ts: one "slow" job that runs JOB_MS unless aborted.
import { createLogger } from "@bun-hydrate/core";
import { createDatabase } from "@bun-hydrate/database";
import { schema } from "@bun-hydrate/validation";
import { DatabaseQueueAdapter, createQueue, createWorker, defineJob } from "../../src";

const db = createDatabase({ url: process.env.DATABASE_URL! });
const queue = createQueue({ adapter: new DatabaseQueueAdapter({ db }) });

const slow = defineJob({
  name: "slow",
  payload: schema.object({}),
  handle: async (_payload, { job }) => {
    console.log(`started attempt ${job.attempt}`);
    await Bun.sleep(Number(process.env.JOB_MS));
    console.log(`finished attempt ${job.attempt}`);
  },
});

const worker = createWorker({
  queue,
  handlers: [slow],
  logger: createLogger({ level: "silent" }),
  poll: { min: 20, max: 50 },
  lease: "1s",
  maintenanceInterval: 200,
  shutdownTimeout: 300,
});
await worker.start();
console.log("ready");
