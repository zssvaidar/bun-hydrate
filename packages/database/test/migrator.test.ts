import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Migrator, parseMigration, type Database } from "../src/index";
import { dropTables, engines } from "./engines";

const CREATE_USERS = `-- migrate:up
create table mig_users (id integer primary key, email varchar(100) not null);

-- migrate:down
drop table mig_users;
`;

const ADD_POSTS = `-- migrate:up
create table mig_posts (id integer primary key);
create table mig_tags (id integer primary key);

-- migrate:down
drop table mig_tags;
drop table mig_posts;
`;

const BROKEN = `-- migrate:up
create table mig_half (id integer primary key);
this is not sql;

-- migrate:down
drop table mig_half;
`;

describe.each(engines)("Migrator on $name", ({ name, open }) => {
  let db: Database;
  let directory: string;
  let migrator: Migrator;

  const write = (file: string, content: string) => Bun.write(join(directory, file), content);
  const tableExists = async (table: string) => {
    try {
      await db.sql.unsafe(`select count(*) from ${table}`);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(async () => {
    db = open();
    await dropTables(db, "mig_users", "mig_posts", "mig_tags", "mig_half", "hydrate_migrations");
    directory = await mkdtemp(join(tmpdir(), "hydrate-migrations-"));
    migrator = new Migrator({ db, directory });
  });

  afterEach(async () => {
    await dropTables(db, "mig_users", "mig_posts", "mig_tags", "mig_half", "hydrate_migrations");
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("applies pending migrations in name order, once", async () => {
    await write("20260102000000_add_posts.sql", ADD_POSTS);
    await write("20260101000000_create_users.sql", CREATE_USERS);

    expect(await migrator.migrate()).toEqual(["20260101000000_create_users", "20260102000000_add_posts"]);
    expect(await migrator.migrate()).toEqual([]);
    expect(await tableExists("mig_users")).toBe(true);
    expect(await tableExists("mig_tags")).toBe(true);
  });

  test("status lists applied (with batch), pending and missing migrations", async () => {
    await write("20260101000000_create_users.sql", CREATE_USERS);
    await migrator.migrate();
    await write("20260102000000_add_posts.sql", ADD_POSTS);
    await rm(join(directory, "20260101000000_create_users.sql"));

    const status = await migrator.status();

    expect(status.applied.map(({ name, batch }) => ({ name, batch }))).toEqual([
      { name: "20260101000000_create_users", batch: 1 },
    ]);
    expect(status.pending).toEqual(["20260102000000_add_posts"]);
    expect(status.missing).toEqual(["20260101000000_create_users"]);
  });

  test("rollback undoes the last batch in reverse order", async () => {
    await write("20260101000000_create_users.sql", CREATE_USERS);
    await migrator.migrate();
    await write("20260102000000_add_posts.sql", ADD_POSTS);
    await write("20260103000000_more.sql", "-- migrate:up\nselect 1;\n-- migrate:down\nselect 1;\n");
    await migrator.migrate();

    expect(await migrator.rollback()).toEqual(["20260103000000_more", "20260102000000_add_posts"]);
    expect(await tableExists("mig_posts")).toBe(false);
    expect(await tableExists("mig_users")).toBe(true);
    expect((await migrator.status()).pending).toEqual(["20260102000000_add_posts", "20260103000000_more"]);
  });

  test("rollback with steps undoes that many migrations across batches", async () => {
    await write("20260101000000_create_users.sql", CREATE_USERS);
    await migrator.migrate();
    await write("20260102000000_add_posts.sql", ADD_POSTS);
    await migrator.migrate();

    expect(await migrator.rollback({ steps: 2 })).toEqual(["20260102000000_add_posts", "20260101000000_create_users"]);
    expect(await tableExists("mig_users")).toBe(false);
  });

  test("a failing migration is rolled back and named; earlier ones in the batch stay applied", async () => {
    await write("20260101000000_create_users.sql", CREATE_USERS);
    await write("20260102000000_broken.sql", BROKEN);

    await expect(migrator.migrate()).rejects.toThrow(/Migration 20260102000000_broken failed/);

    expect(await tableExists("mig_users")).toBe(true);
    expect(await tableExists("mig_half")).toBe(false);
    expect((await migrator.status()).pending).toEqual(["20260102000000_broken"]);
  });

  test("rolling back a migration without a down section fails clearly", async () => {
    await write("20260101000000_one_way.sql", "-- migrate:up\ncreate table mig_users (id integer primary key);\n");
    await migrator.migrate();

    await expect(migrator.rollback()).rejects.toThrow(
      "Migration 20260101000000_one_way has no `-- migrate:down` section and cannot be rolled back",
    );
    expect(await tableExists("mig_users")).toBe(true);
  });

  test("create() writes a timestamped template with a safe name", async () => {
    const created = new Migrator({ db, directory, now: () => new Date("2026-09-27T08:05:03Z") });

    const path = await created.create("Add Email Index!");

    expect(path).toBe(join(directory, "20260927080503_add_email_index.sql"));
    expect(await Bun.file(path).text()).toBe("-- migrate:up\n\n\n-- migrate:down\n\n");
    expect(await readdir(directory)).toEqual(["20260927080503_add_email_index.sql"]);
  });

  test.skipIf(!name.startsWith("postgres"))("concurrent migrate() calls apply each migration once", async () => {
    await write("20260101000000_create_users.sql", CREATE_USERS);
    const other = open();
    try {
      const [first, second] = await Promise.all([migrator.migrate(), new Migrator({ db: other, directory }).migrate()]);
      expect([...first, ...second]).toEqual(["20260101000000_create_users"]);
    } finally {
      await other.close();
    }
  });
});

describe("parseMigration", () => {
  test("splits the up and down sections", () => {
    expect(parseMigration("x", CREATE_USERS)).toEqual({
      up: "create table mig_users (id integer primary key, email varchar(100) not null);",
      down: "drop table mig_users;",
    });
  });

  test("requires an up section", () => {
    expect(() => parseMigration("20260101000000_bad", "create table x (id int);")).toThrow(
      "Migration 20260101000000_bad has no `-- migrate:up` section",
    );
  });
});
