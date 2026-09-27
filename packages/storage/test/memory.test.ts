import { storageContract } from "@bun-hydrate/testing/storage";
import { MemoryStorage } from "../src";

storageContract("memory", () => ({ storage: new MemoryStorage() }));
