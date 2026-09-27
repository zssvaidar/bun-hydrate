import { relative } from "node:path";
import { Migrator, createDatabase, createMigrationFile, type Database } from "@bun-hydrate/database";
import type { HydrateConfig } from "./config";

export const DB_COMMANDS = ["db:migrate", "db:rollback", "db:status", "db:seed", "db:migration"] as const;

export interface DbCommandOptions {
  cwd: string;
  config: HydrateConfig;
  args: string[];
  steps?: number;
  log?: (message: string) => void;
}

export async function runDbCommand(command: string, options: DbCommandOptions): Promise<void> {
  const { cwd, config, args, log = console.log } = options;
  const shown = (path: string) => relative(cwd, path);

  // Creating a migration file needs no connection, so it works before DATABASE_URL is set up.
  if (command === "db:migration") {
    const [action, name] = args;
    if (action !== "create" || !name) throw new Error("Usage: hydrate db:migration create <name>");
    log(`Created ${shown(await createMigrationFile(config.database.migrations, name))}`);
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Add it to .env or the environment, e.g. sqlite://data/app.sqlite");

  const db = createDatabase({ url });
  const migrator = new Migrator({ db, directory: config.database.migrations });
  try {
    switch (command) {
      case "db:migrate": {
        const applied = await migrator.migrate();
        log(applied.length === 0 ? "Nothing to migrate" : applied.map((name) => `Applied      ${name}`).join("\n"));
        return;
      }
      case "db:rollback": {
        const rolledBack = await migrator.rollback({ steps: options.steps });
        log(rolledBack.length === 0 ? "Nothing to roll back" : rolledBack.map((name) => `Rolled back  ${name}`).join("\n"));
        return;
      }
      case "db:status": {
        const status = await migrator.status();
        const lines = [
          ...status.applied.map((m) => `  applied  ${m.name}  (batch ${m.batch})`),
          ...status.pending.map((name) => `  pending  ${name}`),
          ...status.missing.map((name) => `  missing  ${name}  (file not found)`),
        ];
        log(lines.length === 0 ? `No migrations in ${shown(config.database.migrations)}` : lines.join("\n"));
        return;
      }
      case "db:seed": {
        const seedFile = Bun.file(config.database.seed);
        if (!(await seedFile.exists())) {
          throw new Error(
            `No seed file at ${shown(config.database.seed)}. Create it with a default export: (db: Database) => Promise<void>`,
          );
        }
        const { default: seed } = (await import(config.database.seed)) as { default: (db: Database) => Promise<void> };
        await db.transaction(() => seed(db));
        log(`Seeded using ${shown(config.database.seed)}`);
        return;
      }
    }
  } finally {
    await db.close();
  }
}
