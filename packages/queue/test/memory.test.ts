import { queueContract } from "@bun-hydrate/testing/queue";
import { MemoryQueueAdapter } from "../src";

queueContract("memory", () => ({ adapter: new MemoryQueueAdapter() }));
