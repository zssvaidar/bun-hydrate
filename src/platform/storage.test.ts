import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, createLogger } from "@bun-hydrate/core";
import { Container } from "@bun-hydrate/di";
import { AppStorage, installStorage } from "./storage";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storage-test-"));
  process.env.STORAGE_ROOT = root;
});

afterEach(() => rm(root, { recursive: true, force: true }));

test("stores files and serves them only through signed /files URLs", async () => {
  const app = new App({ logger: createLogger({ level: "silent" }), health: false });
  const container = new Container();
  installStorage(app, container);
  const storage = container.get(AppStorage);

  await storage.put("notes/hello.txt", "hello", { contentType: "text/plain" });
  const url = await storage.signedUrl("notes/hello.txt", { expiresIn: "5m" });

  const served = await app.fetch(new Request(`http://localhost${url}`));
  expect(await served.text()).toBe("hello");
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await app.fetch(new Request("http://localhost/files/notes/hello.txt"))).status).toBe(403);
});
