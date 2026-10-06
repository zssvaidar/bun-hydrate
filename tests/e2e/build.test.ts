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
    expect(await readdir(join(releaseDir, "dist/migrations"))).toContain("20260927000000_create_users.sql");
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

  test("is ready: migrations shipped in dist/ were applied to the in-memory database", async () => {
    const res = await fetch(new URL("/ready", server.url));
    expect(res.status).toBe(200);
    // Registering needs the accounts, passwords and sessions tables from the shipped migrations.
    const registered = await fetch(new URL("/api/v1/auth/register", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(server.url).origin },
      body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
    });
    expect(registered.status).toBe(201);
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

  test("ships the app's Sass compiled to one hashed stylesheet, linked from <head> and cached forever", async () => {
    const manifest = await Bun.file(join(releaseDir, "dist/manifest.json")).json();
    expect(manifest.client.styles).toHaveLength(1);
    const [href] = manifest.client.styles;
    expect(href).toMatch(/^\/assets\/client-[a-z0-9]+\.css$/);

    const html = await (await fetch(new URL("/", server.url))).text();
    expect(html.slice(0, html.indexOf("</head>"))).toContain(`<link rel="stylesheet" href="${href}">`);

    const res = await fetch(new URL(href, server.url));
    const css = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/css");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // Variables from src/web/styles/_variables.scss and the control() mixin, compiled and minified.
    expect(css).toContain("button{font:inherit;color:#fff;cursor:pointer;background:#0b5fff");
    expect(css).not.toMatch(/\$[a-z]|@use|@include/);
  });

  test("the Sass compiler stays out of dist/: it runs only while building", async () => {
    // src/main.ts imports sassPlugin() for development; sass-embedded's own code must not follow it.
    for (const file of ["dist/index.js", "dist/worker.js"]) {
      expect(await Bun.file(join(releaseDir, file)).text()).not.toContain("compileStringAsync");
    }
  });

  test("logs every line as JSON in production, including the startup migrations", () => {
    const messages = server.output().map((line) => JSON.parse(line).msg);
    expect(messages).toContain("Migrations applied");
    expect(messages).toContain("Server listening");
  });

  test("stops gracefully on SIGTERM", async () => {
    expect(await server.stop("SIGTERM")).toBe(0);
  });
});
