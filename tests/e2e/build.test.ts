import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunningServer } from "@bun-hydrate/testing";
import { buildArtifact, startArtifact } from "./helpers";

describe("built artifact (hydrate build → bun dist/index.js)", () => {
  let releaseDir: string;
  let server: RunningServer;

  beforeAll(async () => {
    releaseDir = await buildArtifact();
    server = await startArtifact();
  }, 60_000);

  afterAll(async () => {
    if (server?.process.exitCode === null) await server.stop();
  });

  test("dist/ contains the server bundle, hashed client assets and the manifest", async () => {
    const manifest = await Bun.file(join(releaseDir, "dist/manifest.json")).json();
    const assets = await readdir(join(releaseDir, "dist/public/assets"));

    expect(manifest.server).toBe("index.js");
    expect(manifest.client.entry).toMatch(/^\/assets\/client-[a-z0-9]+\.js$/);
    expect(assets).toContain(manifest.client.entry.replace("/assets/", ""));
    expect(await Bun.file(join(releaseDir, "node_modules")).exists()).toBe(false);
  });

  // Browsers run the client bundle, so check it with V8's parser (Bun's loader rejects React's
  // labelled blocks even in valid bundles). Guards against minifier output browsers reject.
  test.skipIf(!Bun.which("node"))("every client chunk parses as a JavaScript module in V8", async () => {
    const assetsDir = join(releaseDir, "dist/public/assets");
    const chunks = (await readdir(assetsDir)).filter((file) => file.endsWith(".js"));

    for (const chunk of chunks) {
      const asModule = join(assetsDir, chunk.replace(/\.js$/, ".check.mjs"));
      await Bun.write(asModule, Bun.file(join(assetsDir, chunk)));
      const check = Bun.spawnSync(["node", "--check", asModule], { stderr: "pipe" });
      await rm(asModule);

      expect({ chunk, stderr: check.stderr.toString() }).toEqual({ chunk, stderr: "" });
    }
  });

  test("answers /health the way deploy.sh checks it", async () => {
    const res = await fetch(new URL("/health", server.url));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  test("is ready", async () => {
    expect((await fetch(new URL("/ready", server.url))).status).toBe(200);
  });

  test("server-renders pages and references the built client bundle", async () => {
    const manifest = await Bun.file(join(releaseDir, "dist/manifest.json")).json();
    const html = await (await fetch(new URL("/page/9", server.url))).text();

    expect(html).toContain("Page <!-- -->9");
    expect(html).toContain(`<script type="module" src="${manifest.client.entry}"></script>`);
  });

  test("serves hashed client assets with immutable caching", async () => {
    const manifest = await Bun.file(join(releaseDir, "dist/manifest.json")).json();
    const res = await fetch(new URL(manifest.client.entry, server.url));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("logs as JSON in production", () => {
    const record = JSON.parse(server.output()[0]!);
    expect(record).toMatchObject({ level: "info", msg: "Server listening" });
  });

  test("stops gracefully on SIGTERM", async () => {
    expect(await server.stop("SIGTERM")).toBe(0);
  });
});
