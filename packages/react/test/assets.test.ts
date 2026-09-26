import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { createAssets } from "../src/assets";

const fixtures = `${import.meta.dir}/fixtures`;

function clientFor(middleware: Parameters<App["use"]>[0]) {
  return createTestClient(new App({ logger: createLogger({ level: "silent" }), health: false }).use(middleware));
}

describe("createAssets in development", () => {
  test("bundles the client entry in memory and serves it under /assets", async () => {
    const assets = await createAssets({ clientEntry: `${fixtures}/client-entry.ts`, mode: "development" });

    expect(assets.scripts).toHaveLength(1);
    expect(assets.scripts[0]).toMatch(/^\/assets\/client-entry-[a-z0-9]+\.js$/);

    const res = await clientFor(assets.middleware).get(assets.scripts[0]!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("client-entry-fixture");
  });

  test("reports bundling errors clearly", async () => {
    await expect(createAssets({ clientEntry: `${fixtures}/does-not-exist.ts`, mode: "development" })).rejects.toThrow(
      /Client bundle failed/,
    );
  });
});

describe("createAssets in production", () => {
  const options = {
    clientEntry: "unused-in-production.ts",
    mode: "production" as const,
    publicDir: `${fixtures}/public`,
    manifestPath: `${fixtures}/manifest.json`,
  };

  test("reads script URLs from the build manifest", async () => {
    const assets = await createAssets(options);
    expect(assets.scripts).toEqual(["/assets/client-abc123.js"]);
  });

  test("serves built files with long-lived immutable caching", async () => {
    const assets = await createAssets(options);
    const res = await clientFor(assets.middleware).get("/assets/client-abc123.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toContain("built client");
  });

  test("tells the developer to build when the manifest is missing", async () => {
    await expect(createAssets({ ...options, manifestPath: `${fixtures}/missing.json` })).rejects.toThrow(
      /Run `hydrate build`/,
    );
  });
});
