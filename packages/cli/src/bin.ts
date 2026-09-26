#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { build } from "./build";
import { loadHydrateConfig } from "./config";

const HELP = `hydrate — bun-hydrate command line

Usage: hydrate <command> [options]

Commands:
  dev      Run the server with reload on change (NODE_ENV=development)
  build    Bundle server and client into a self-contained output directory
  start    Run the built server (NODE_ENV=production)

Options:
  --out-dir <dir>   Override outDir from hydrate.config.ts
  -h, --help        Show this help

This CLI does not collect or send usage data.
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "out-dir": { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  const [command] = positionals;

  if (values.help || command === undefined || command === "help") {
    console.log(HELP);
    return 0;
  }

  const cwd = process.cwd();
  const config = await loadHydrateConfig(cwd);
  if (values["out-dir"]) config.outDir = resolve(cwd, values["out-dir"]);

  switch (command) {
    case "dev":
      return run(["bun", "--watch", config.server], "development");
    case "build":
      await build(config);
      return 0;
    case "start":
      return run(["bun", join(config.outDir, "index.js")], "production");
    default:
      console.error(`Unknown command "${command}". Run \`hydrate --help\` to see the available commands.`);
      return 1;
  }
}

/** Runs the app as a child process and forwards shutdown signals so graceful stop still works. */
async function run(cmd: string[], nodeEnv: string): Promise<number> {
  const child = Bun.spawn(cmd, { env: { ...process.env, NODE_ENV: nodeEnv }, stdio: ["inherit", "inherit", "inherit"] });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  return child.exited;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
