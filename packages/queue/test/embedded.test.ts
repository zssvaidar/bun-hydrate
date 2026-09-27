import { expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestQueue } from "@bun-hydrate/testing/queue";
import { schema } from "@bun-hydrate/validation";
import { MemoryQueueAdapter, createQueue, defineJob, startWorkerIn } from "../src";

const ran: string[] = [];
const note = defineJob({ name: "note", payload: schema.object({ text: schema.string() }), handle: ({ text }) => void ran.push(text) });

test("an embedded worker starts and stops with the app (spec-6 D4)", async () => {
  const queue = createQueue({ adapter: new MemoryQueueAdapter() });
  const app = new App({ logger: createLogger({ level: "silent" }), health: false });
  const worker = startWorkerIn(app, { queue, handlers: [note], logger: createLogger({ level: "silent" }), poll: { min: 5, max: 10 } });

  await queue.dispatch(note, { text: "from the web process" });
  await app.listen({ port: 0 });
  for (let i = 0; i < 100 && ran.length === 0; i++) await Bun.sleep(10);
  await app.stop();

  expect(ran).toEqual(["from the web process"]);
  expect(worker.active).toBe(0);
});

test("createTestQueue records dispatches and runs due jobs to completion", async () => {
  const queue = createTestQueue();
  await queue.dispatch(note, { text: "one" });
  await queue.dispatch(note, { text: "later" }, { delay: "1h" });

  expect(await queue.dispatched(note)).toEqual([{ text: "one" }, { text: "later" }]);
  ran.length = 0;
  await queue.runAll({ handlers: [note] });
  expect(ran).toEqual(["one"]); // the delayed job is not due yet
  expect(await queue.dispatched(note)).toEqual([{ text: "later" }]);
});
