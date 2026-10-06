import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { createAssets } from "../src/assets";
import { sassPlugin } from "../src/sass";

const fixtures = `${import.meta.dir}/fixtures`;

function clientFor(middleware: Parameters<App["use"]>[0]) {
  const app = new App({ logger: createLogger({ level: "silent" }), health: false }).use(middleware).get("/page", () => "page");
  return createTestClient(app);
}

const tempDirs: string[] = [];
afterAll(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A copy of fixtures/styled the test may edit. */
async function styledCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hydrate-styles-"));
  tempDirs.push(dir);
  await cp(`${fixtures}/styled`, dir, { recursive: true });
  return dir;
}

/** Writes a file with a later modification time than before, however coarse the file system's clock. */
async function rewrite(file: string, contents: string) {
  await Bun.sleep(20);
  await Bun.write(file, contents);
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

  test("bundles imported CSS and Sass into stylesheets for <head>, served from memory", async () => {
    const assets = await createAssets({ clientEntry: `${fixtures}/styled/entry.ts`, mode: "development", plugins: [sassPlugin()] });

    expect(assets.styles).toHaveLength(1);
    expect(assets.styles[0]).toMatch(/^\/assets\/entry-[a-z0-9]+\.css$/);

    const res = await clientFor(assets.middleware).get(assets.styles[0]!);
    const css = await res.text();
    expect(res.headers.get("content-type")).toStartWith("text/css");
    expect(css).toMatch(/\.plain \.nested \{\s*color: #639;?\s*\}/); // CSS nesting, lowered by Bun
    expect(css).toMatch(/\.themed \{\s*color: #0b5fff;?\s*\}/); // a variable from a Sass partial
  });

  test("a .scss import without the Sass plugin fails the bundle and says how to fix it", async () => {
    await expect(createAssets({ clientEntry: `${fixtures}/styled/entry.ts`, mode: "development" })).rejects.toThrow(
      /imports Sass \(theme-[a-z0-9]+\.scss\) but no plugin compiles it\. Run: bun hydrate add styles:sass/,
    );
  });

  test("rebundles when a stylesheet or a Sass partial changes, before the next page is served", async () => {
    const dir = await styledCopy();
    const assets = await createAssets({ clientEntry: join(dir, "entry.ts"), mode: "development", plugins: [sassPlugin()] });
    const client = clientFor(assets.middleware);
    const before = assets.styles[0]!;

    await rewrite(join(dir, "_tokens.scss"), "$accent: #ff5f0b;\n");
    expect(await (await client.get("/page")).text()).toBe("page");
    const afterPartial = assets.styles[0]!;
    expect(afterPartial).not.toBe(before);
    expect(await (await client.get(afterPartial)).text()).toContain("#ff5f0b");

    await rewrite(join(dir, "plain.css"), ".plain { color: teal; }\n");
    await client.get("/page");
    expect(await (await client.get(assets.styles[0]!)).text()).toContain("teal");
  });

  test("a stylesheet that stops compiling shows the error instead of the page, until it is fixed", async () => {
    const dir = await styledCopy();
    const assets = await createAssets({ clientEntry: join(dir, "entry.ts"), mode: "development", plugins: [sassPlugin()] });
    const client = clientFor(assets.middleware);

    await rewrite(join(dir, "theme.scss"), ".themed { color: $missing; }\n");
    const broken = await client.get("/page");
    expect(broken.status).toBe(500);
    expect(await broken.text()).toContain("Undefined variable");

    await rewrite(join(dir, "theme.scss"), ".themed { color: green; }\n");
    expect((await client.get("/page")).status).toBe(200);
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
    expect(assets.styles).toEqual([]);
  });

  test("reads stylesheet URLs from the build manifest", async () => {
    const assets = await createAssets({ ...options, manifestPath: `${fixtures}/manifest-with-styles.json` });
    expect(assets.styles).toEqual(["/assets/client-def456.css"]);
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
