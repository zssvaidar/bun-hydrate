#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { loadHydrateConfig } from "./config";
import { DB_COMMANDS, runDbCommand } from "./db";
import { runAppCommand } from "./features/app-commands";
import { createRegistry } from "./features/catalog";
import { FEATURE_COMMANDS, runFeatureCommand } from "./features/cli";
import { generate } from "./generate";

const HELP = `hydrate — bun-hydrate command line

Usage: hydrate <command> [options]

Commands:
  dev                              Run the server with reload on change (NODE_ENV=development)
  build                            Bundle server and client into a self-contained output directory
  start                            Run the built server (NODE_ENV=production)
  generate module <name> [--auth]  Module with schema, repository, service, controller, routes, test + migration
  generate middleware <name>       Middleware and its test
  db:migration create <name>       Write an empty timestamped migration
  db:migrate                       Apply pending migrations
  db:rollback [--steps <n>]        Undo the last batch (or the last n migrations)
  db:status                        List applied, pending and missing migrations
  db:seed                          Run the seed file against the database

Features (auth, cache, rate limiting, metrics, CORS):
  features                         List features and presets, and what is installed
  add <feature|preset>...          Show the plan, then add (--dry-run: plan only, --yes: no prompt)
  remove <feature>...              Remove (--cascade, --force: delete edited files, --drop-data)
  doctor                           Check installed features against files, env and database
  sync                             Regenerate the files hydrate owns (never yours)
  <feature command>                e.g. auth:create-user, from installed features (see \`features\`)

Options:
  --out-dir <dir>   Override outDir from hydrate.config.ts
  --steps <n>       Number of migrations for db:rollback
  -h, --help        Show this help

Database commands read DATABASE_URL from the environment or .env.
This CLI does not collect or send usage data.
`;

const BUILT_IN = new Set<string>(["dev", "build", "start", "generate", "help", ...DB_COMMANDS, ...FEATURE_COMMANDS]);

async function main(argv: string[]): Promise<number> {
  const cwd = process.cwd();

  // Feature commands (auth:create-user --email …) come first and define their own options.
  const [first, ...rest] = argv;
  if (first !== undefined && !first.startsWith("-") && !BUILT_IN.has(first)) {
    const config = await loadHydrateConfig(cwd);
    if (await runAppCommand(first, rest, { cwd, registry: createRegistry(config) })) return 0;
    console.error(`Unknown command "${first}". Run \`hydrate --help\` to see the available commands.`);
    return 1;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "out-dir": { type: "string" },
      steps: { type: "string" },
      help: { type: "boolean", short: "h" },
      auth: { type: "boolean" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      cascade: { type: "boolean" },
      force: { type: "boolean" },
      "drop-data": { type: "boolean" },
    },
    allowPositionals: true,
  });
  const [command, ...args] = positionals;

  if (values.help || command === undefined || command === "help") {
    console.log(HELP);
    return 0;
  }

  const config = await loadHydrateConfig(cwd);
  if (values["out-dir"]) config.outDir = resolve(cwd, values["out-dir"]);

  if ((DB_COMMANDS as readonly string[]).includes(command)) {
    await runDbCommand(command, { cwd, config, args, steps: parseSteps(values.steps) });
    return 0;
  }
  if ((FEATURE_COMMANDS as readonly string[]).includes(command)) {
    const flags = {
      dryRun: values["dry-run"],
      yes: values.yes,
      cascade: values.cascade,
      force: values.force,
      dropData: values["drop-data"],
    };
    return runFeatureCommand(command, args, { cwd, config, registry: createRegistry(config), flags });
  }

  switch (command) {
    case "dev":
      return run(["bun", "--watch", config.server], "development");
    case "build": {
      // Loaded on demand: bundling pulls in React, which no other command needs.
      const { build } = await import("./build");
      await build(config);
      return 0;
    }
    case "start":
      return run(["bun", join(config.outDir, "index.js")], "production");
    case "generate":
      await generate(args[0] ?? "", args[1], { cwd, config, auth: values.auth });
      return 0;
    default:
      console.error(`Unknown command "${command}". Run \`hydrate --help\` to see the available commands.`);
      return 1;
  }
}

function parseSteps(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const steps = Number(value);
  if (!Number.isInteger(steps) || steps < 1) throw new Error(`--steps must be a positive integer, got "${value}"`);
  return steps;
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
