import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dir, "../src/bin.ts");
let project: string;
let databaseUrl: string;

function hydrate(args: string[], env: Record<string, string> = { DATABASE_URL: databaseUrl }) {
  const result = Bun.spawnSync(["bun", bin, ...args], {
    cwd: project,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "hydrate-db-"));
  databaseUrl = `sqlite://${join(project, "app.sqlite")}`;
});

afterAll(() => rm(project, { recursive: true, force: true }));

describe("hydrate db:*", () => {
  test("db:migration create writes a timestamped migration", async () => {
    const result = hydrate(["db:migration", "create", "create notes"]);

    expect(result.code).toBe(0);
    const [file] = await readdir(join(project, "migrations"));
    expect(file).toMatch(/^\d{14}_create_notes\.sql$/);
    expect(result.stdout).toContain(`Created migrations/${file}`);

    await Bun.write(
      join(project, "migrations", file!),
      "-- migrate:up\ncreate table notes (id integer primary key, body text not null);\n\n-- migrate:down\ndrop table notes;\n",
    );
  });

  test("db:migrate applies pending migrations, then reports nothing to do", () => {
    const first = hydrate(["db:migrate"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/Applied\s+\d{14}_create_notes/);

    expect(hydrate(["db:migrate"]).stdout).toContain("Nothing to migrate");
  });

  test("db:status lists applied migrations with their batch", () => {
    const result = hydrate(["db:status"]);
    expect(result.stdout).toMatch(/applied\s+\d{14}_create_notes\s+\(batch 1\)/);
  });

  test("db:seed runs the seed module with the database", async () => {
    await Bun.write(
      join(project, "src/database/seed.ts"),
      `import type { Database } from "@bun-hydrate/database";
export default async function seed(db: Database) {
  await db.sql\`insert into notes (id, body) values (1, 'seeded')\`;
}
`,
    );
    const seeded = hydrate(["db:seed"]);
    expect(seeded.stderr).toBe("");
    expect(seeded.stdout).toContain("Seeded");
  });

  test("db:rollback undoes the last batch", () => {
    const result = hydrate(["db:rollback"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Rolled back\s+\d{14}_create_notes/);
    expect(hydrate(["db:status"]).stdout).toMatch(/pending\s+\d{14}_create_notes/);
  });

  test("a missing DATABASE_URL is explained", () => {
    const result = hydrate(["db:migrate"], {});

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set. Add it to .env or the environment");
  });

  test("a missing seed file is explained", async () => {
    await rm(join(project, "src/database/seed.ts"));
    const result = hydrate(["db:seed"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No seed file at src/database/seed.ts");
  });
});
