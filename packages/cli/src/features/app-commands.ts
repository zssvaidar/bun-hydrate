import { join } from "node:path";
import { createDatabase } from "@bun-hydrate/database";
import { CommandUsageError, type CommandContext, type CommandHandler } from "../commands-api";
import { readManifest } from "./manifest";
import type { FeatureRegistry } from "./registry";

export interface AppCommandOptions {
  cwd: string;
  registry: FeatureRegistry;
  log?: (line: string) => void;
  /** Default: Bun.stdin. */
  stdin?: { text(): Promise<string> };
}

/**
 * Runs a console command provided by an installed feature, e.g. `hydrate auth:create-user`
 * (spec-5 §9.6). Returns false when no feature provides `name`, so the caller can report an
 * unknown command.
 */
export async function runAppCommand(name: string, argv: readonly string[], options: AppCommandOptions): Promise<boolean> {
  const { cwd, registry, log = console.log } = options;
  const feature = registry.all().find((candidate) => candidate.commands?.some((command) => command.name === name));
  if (!feature) return false;

  const manifest = await readManifest(cwd);
  if (!manifest.features[feature.id]) {
    throw new CommandUsageError(`hydrate ${name} comes with ${feature.id}. Add it with: bun hydrate add ${feature.id}`);
  }
  if (!feature.commandsModule) throw new Error(`${feature.id} declares commands but no commandsModule`);

  const { args, options: parsed } = parseCommandArgs(argv);
  for (const secret of ["password", "secret", "token"]) {
    if (secret in parsed) {
      throw new CommandUsageError(
        `Never pass a ${secret} as an argument: it ends up in shell history and the process list. ` +
          "Type it at the prompt, or pipe it with --password-stdin.",
      );
    }
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new CommandUsageError("DATABASE_URL is not set. Add it to .env or the environment.");

  const module = (await import(join(cwd, feature.commandsModule))) as { commands?: Record<string, CommandHandler> };
  const handler = module.commands?.[name];
  if (!handler) throw new Error(`${feature.commandsModule} does not export a "${name}" command; run \`bun hydrate sync\``);

  const db = createDatabase({ url });
  const ctx: CommandContext = {
    args,
    options: parsed,
    db,
    print: log,
    readSecret: (prompt) => readSecret(prompt, parsed, options.stdin ?? Bun.stdin),
  };
  try {
    await handler(ctx);
  } finally {
    await db.close();
  }
  return true;
}

/** `--name value` and `--name=value` are strings; a `--flag` followed by another option or nothing is true. */
export function parseCommandArgs(argv: readonly string[]): { args: string[]; options: Record<string, string | true> } {
  const args: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (inline !== undefined) options[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) options[key] = argv[++i]!;
    else options[key] = true;
  }
  return { args, options };
}

async function readSecret(
  prompt: string,
  options: Record<string, string | true>,
  stdin: { text(): Promise<string> },
): Promise<string> {
  if (options["password-stdin"] === true) return (await stdin.text()).replace(/\r?\n$/, "");
  if (!process.stdin.isTTY) {
    throw new CommandUsageError("No terminal to prompt on. Pipe the secret in and add --password-stdin.");
  }
  return hiddenPrompt(prompt);
}

/** Reads a line from the terminal without echoing it. */
function hiddenPrompt(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          return resolve(value);
        }
        if (char === "\u0003") {
          finish();
          return reject(new CommandUsageError("Cancelled"));
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}
