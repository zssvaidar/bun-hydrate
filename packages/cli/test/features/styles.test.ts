import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** styles:sass on a scratch project: scaffolded stylesheets, a generated plugin list, the wiring. */
const bin = join(import.meta.dir, "../../src/bin.ts");
const cwd = join(import.meta.dir, "../.tmp", `styles-${process.pid}`);

function hydrate(...args: string[]) {
  const result = Bun.spawnSync(["bun", bin, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, DATABASE_URL: "" } });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

beforeAll(async () => {
  await mkdir(cwd, { recursive: true });
  await Bun.write(join(cwd, "tsconfig.json"), JSON.stringify({ extends: "../../../../../tsconfig.json", include: ["src"], exclude: [] }));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rmdir(dirname(cwd)).catch(() => {});
});

describe("styles:sass", () => {
  test("scaffolds a stylesheet and its tokens, generates the plugin list, and explains the wiring", async () => {
    const added = hydrate("add", "styles:sass", "--yes");
    expect(added.stderr).toBe("");
    expect(added.stdout).toContain("bun add -d sass-embedded");
    expect(added.stdout).toContain("set clientPlugins in defineHydrateConfig()");
    expect(added.stdout).toContain("pass plugins: clientPlugins to createAssets()");
    expect(added.stdout).toContain('import "./styles/app.scss";');

    expect(await Bun.file(join(cwd, "src/web/client.plugins.ts")).text()).toContain(
      'import { sassPlugin } from "@bun-hydrate/react/sass";\n\n' +
        "/** The client bundle's Bun plugins, the same in `hydrate dev` and `hydrate build`. */\n" +
        "export const clientPlugins: ClientPlugin[] = [sassPlugin()];",
    );
    expect(await Bun.file(join(cwd, "src/web/styles/app.scss")).text()).toContain('@use "variables" as *;');
    expect(await Bun.file(join(cwd, "src/web/styles/_variables.scss")).exists()).toBe(true);

    const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", cwd], { stdout: "pipe", stderr: "pipe" });
    expect(tsc.stdout.toString()).toBe("");
  }, 60_000);

  test("the scaffolded stylesheet compiles", async () => {
    const sass = await import("sass-embedded");
    const { css } = await sass.compileAsync(join(cwd, "src/web/styles/app.scss"));
    expect(css).toContain("max-width: 48rem;");
  });

  test("removing it deletes the generated plugin list and keeps your stylesheets", async () => {
    expect(hydrate("remove", "styles:sass", "--yes").code).toBe(0);
    expect(await Bun.file(join(cwd, "src/web/client.plugins.ts")).exists()).toBe(false);
    expect(await Bun.file(join(cwd, "src/web/styles/app.scss")).exists()).toBe(true);
  });
});
