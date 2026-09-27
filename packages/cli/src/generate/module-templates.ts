import { constantCase, humanize, type ModuleNames } from "./names";

/**
 * Templates for `hydrate generate module`. The output mirrors the reference users module
 * (spec-4 §5) and must stay ordinary code: it type-checks and its test passes as generated.
 */
/** The permissions `generate module --auth` guards the routes with. */
export function modulePermissions(n: ModuleNames): string[] {
  return ["read", "create", "update", "delete"].map((action) => `${n.kebab}.${action}`);
}

export function moduleFiles(n: ModuleNames, { auth = false }: { auth?: boolean } = {}): Record<string, string> {
  const e = n.entity;
  const guard = (action: string) => (auth ? `requirePermission("${n.kebab}.${action}"), ` : "");
  const notFound = `${constantCase(e)}_NOT_FOUND`;
  const label = humanize(e);

  return {
    [`${n.kebab}.schema.ts`]: `import { schema, type Infer } from "@bun-hydrate/validation";

export interface ${e} {
  id: string;
  name: string;
  createdAt: string;
}

const name = schema.string().trim().min(1).max(200);

export const ${e}Params = schema.object({ id: schema.uuid() });

export const List${n.pascal}Query = schema.object({
  limit: schema.coerce.integer().min(1).max(100).default(20),
  cursor: schema.uuid().optional(),
});

export const Create${e}Body = schema.object({ name });

export const Update${e}Body = schema
  .object({ name: name.optional() })
  .refine((changes) => Object.keys(changes).length > 0, "Provide at least one field to update");

export type List${n.pascal}Query = Infer<typeof List${n.pascal}Query>;
export type Create${e} = Infer<typeof Create${e}Body>;
export type Update${e} = Infer<typeof Update${e}Body>;
`,

    [`${n.kebab}.repository.ts`]: `import { Database } from "@bun-hydrate/database";
import type { Page } from "../../shared/pagination";
import type { List${n.pascal}Query, Update${e}, ${e} } from "./${n.kebab}.schema";

interface ${e}Row {
  id: string;
  name: string;
  created_at: string;
}

const to${e} = (row: ${e}Row): ${e} => ({ id: row.id, name: row.name, createdAt: row.created_at });

/** Persistence only. Uses \`db.sql\`, so it joins any transaction the caller has open. */
export class ${n.pascal}Repository {
  static readonly inject = [Database] as const;

  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<${e} | undefined> {
    const [row] = await this.db.sql<${e}Row[]>\`select * from ${n.snake} where id = \${id}\`;
    return row && to${e}(row);
  }

  /** IDs are UUIDv7, so ordering by id is creation order and a stable cursor. */
  async list({ limit, cursor }: List${n.pascal}Query): Promise<Page<${e}>> {
    const rows = cursor
      ? await this.db.sql<${e}Row[]>\`select * from ${n.snake} where id > \${cursor} order by id limit \${limit + 1}\`
      : await this.db.sql<${e}Row[]>\`select * from ${n.snake} order by id limit \${limit + 1}\`;
    const items = rows.slice(0, limit).map(to${e});
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  async insert(record: ${e}): Promise<void> {
    const row: ${e}Row = { id: record.id, name: record.name, created_at: record.createdAt };
    await this.db.sql\`insert into ${n.snake} \${this.db.sql(row)}\`;
  }

  async update(id: string, changes: Update${e}): Promise<void> {
    const columns = Object.keys(changes) as (keyof Update${e})[];
    await this.db.sql\`update ${n.snake} set \${this.db.sql(changes, ...columns)} where id = \${id}\`;
  }

  /** Returns false when there was no such record. */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.sql\`delete from ${n.snake} where id = \${id}\`;
    return result.count > 0;
  }
}
`,

    [`${n.kebab}.service.ts`]: `import { NotFoundError } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Clock } from "../../shared/clock";
import type { Page } from "../../shared/pagination";
import { ${n.pascal}Repository } from "./${n.kebab}.repository";
import type { Create${e}, List${n.pascal}Query, Update${e}, ${e} } from "./${n.kebab}.schema";

/** Business rules. Knows nothing about HTTP; decides transaction boundaries. */
export class ${n.pascal}Service {
  static readonly inject = [${n.pascal}Repository, Database, Clock] as const;

  constructor(
    private readonly records: ${n.pascal}Repository,
    private readonly db: Database,
    private readonly clock: () => Date,
  ) {}

  async get(id: string): Promise<${e}> {
    const record = await this.records.findById(id);
    if (!record) throw new NotFoundError("${label} not found", { code: "${notFound}" });
    return record;
  }

  list(query: List${n.pascal}Query): Promise<Page<${e}>> {
    return this.records.list(query);
  }

  async create(input: Create${e}): Promise<${e}> {
    const record: ${e} = { id: Bun.randomUUIDv7(), ...input, createdAt: this.clock().toISOString() };
    await this.records.insert(record);
    return record;
  }

  update(id: string, changes: Update${e}): Promise<${e}> {
    return this.db.transaction(async () => {
      await this.get(id);
      await this.records.update(id, changes);
      return this.get(id);
    });
  }

  async delete(id: string): Promise<void> {
    if (!(await this.records.delete(id))) throw new NotFoundError("${label} not found", { code: "${notFound}" });
  }
}
`,

    [`${n.kebab}.controller.ts`]: `import { validate } from "@bun-hydrate/validation";
import { ${n.pascal}Service } from "./${n.kebab}.service";
import { Create${e}Body, List${n.pascal}Query, Update${e}Body, ${e}Params } from "./${n.kebab}.schema";

/** HTTP concerns only: validated input in, service call, status and headers out. */
export class ${n.pascal}Controller {
  static readonly inject = [${n.pascal}Service] as const;

  constructor(private readonly service: ${n.pascal}Service) {}

  readonly list = validate({ query: List${n.pascal}Query }, (_ctx, { query }) => this.service.list(query));

  readonly get = validate({ params: ${e}Params }, (_ctx, { params }) => this.service.get(params.id));

  readonly create = validate({ body: Create${e}Body }, async (ctx, { body }) => {
    const record = await this.service.create(body);
    ctx.status(201).header("location", \`/api/v1/${n.kebab}/\${record.id}\`);
    return record;
  });

  readonly update = validate({ params: ${e}Params, body: Update${e}Body }, (_ctx, { params, body }) =>
    this.service.update(params.id, body),
  );

  readonly remove = validate({ params: ${e}Params }, async (_ctx, { params }) => {
    await this.service.delete(params.id);
  });
}
`,

    [`${n.kebab}.routes.ts`]: `${auth ? 'import { requirePermission } from "@bun-hydrate/auth";\n' : ""}import { Router } from "@bun-hydrate/core";
import type { ${n.pascal}Controller } from "./${n.kebab}.controller";
${auth ? `\n/** Each route needs its permission (see src/shared/permissions.ts); roles grant them in src/auth/config.ts. */` : ""}
export function ${n.camel}Routes(controller: ${n.pascal}Controller): Router {
  return new Router()
    .get("/", ${guard("read")}controller.list)
    .post("/", ${guard("create")}controller.create)
    .get("/:id", ${guard("read")}controller.get)
    .patch("/:id", ${guard("update")}controller.update)
    .delete("/:id", ${guard("delete")}controller.remove);
}
`,

    [`${n.kebab}.module.ts`]: `import type { Router } from "@bun-hydrate/core";
import type { Container } from "@bun-hydrate/di";
import { ${n.pascal}Controller } from "./${n.kebab}.controller";
import { ${n.pascal}Repository } from "./${n.kebab}.repository";
import { ${n.pascal}Service } from "./${n.kebab}.service";
import { ${n.camel}Routes } from "./${n.kebab}.routes";

/** Registers the module's classes and returns its routes. Needs Database and Clock in the container. */
export function ${n.camel}Module(container: Container): Router {
  container.bind(${n.pascal}Repository).bind(${n.pascal}Service).bind(${n.pascal}Controller);
  return ${n.camel}Routes(container.get(${n.pascal}Controller));
}
`,

    [`${n.kebab}.test.ts`]: `import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
${auth ? 'import { authenticate, type Strategy } from "@bun-hydrate/auth";\n' : ""}import { App, createLogger } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { createTestClient, type TestClient } from "@bun-hydrate/testing";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { Clock } from "../../shared/clock";
import { ${n.camel}Module } from "./${n.kebab}.module";

const MIGRATIONS = join(import.meta.dir, "../../../migrations");
const NOW = new Date("2026-01-01T00:00:00.000Z");

let db: Database;
let client: TestClient;
${auth ? `let app: App;

/** Signs requests in as a principal holding the permissions in the x-test-permissions header. */
const testPrincipals: Strategy = {
  name: "test",
  async authenticate(ctx) {
    const granted = ctx.headers.get("x-test-permissions");
    if (granted === null) return undefined;
    return { id: "tester", kind: "user", roles: [], permissions: granted.split(",").filter(Boolean), via: "jwt" };
  },
};
const ALL = ${JSON.stringify(modulePermissions(n).join(","))};
` : ""}
beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
  const container = new Container().value(Database, db).value(Clock, () => NOW);
  ${auth ? "app" : "const app"} = new App({ logger: createLogger({ level: "silent" }), health: false })${auth ? "\n    .use(authenticate({ strategies: [testPrincipals] }))\n    " : ""}.route(
    "/${n.kebab}",
    ${n.camel}Module(container),
  );
  client = createTestClient(app${auth ? ', { headers: { "x-test-permissions": ALL } }' : ""});
});

afterEach(() => db.close());

describe("${n.kebab} module", () => {
  test("creates and reads a record", async () => {
    const created = await client.post("/${n.kebab}").json({ name: "First" });
    const record = await created.json();

    expect(created.status).toBe(201);
    expect(record).toEqual({ id: expect.any(String), name: "First", createdAt: NOW.toISOString() });
    expect(await (await client.get(\`/${n.kebab}/\${record.id}\`)).json()).toEqual(record);
  });

  test("rejects invalid input with a 422", async () => {
    expect((await client.post("/${n.kebab}").json({ name: "" })).status).toBe(422);
  });

  test("lists records page by page", async () => {
    for (const name of ["a", "b", "c"]) await client.post("/${n.kebab}").json({ name });

    const first = await (await client.get("/${n.kebab}").query({ limit: 2 })).json();
    const second = await (await client.get("/${n.kebab}").query({ limit: 2, cursor: first.nextCursor })).json();

    expect(first.items).toHaveLength(2);
    expect(second).toEqual({ items: [expect.objectContaining({ name: "c" })], nextCursor: null });
  });

  test("updates and deletes a record", async () => {
    const record = await (await client.post("/${n.kebab}").json({ name: "Before" })).json();

    expect(await (await client.patch(\`/${n.kebab}/\${record.id}\`).json({ name: "After" })).json()).toMatchObject({
      name: "After",
    });
    expect((await client.delete(\`/${n.kebab}/\${record.id}\`)).status).toBe(204);
    expect((await client.get(\`/${n.kebab}/\${record.id}\`)).status).toBe(404);
  });
${auth ? `
  test("each route needs its permission: 401 when signed out, 403 without it", async () => {
    const readOnly = createTestClient(app, { headers: { "x-test-permissions": "${n.kebab}.read" } });

    expect((await createTestClient(app).get("/${n.kebab}")).status).toBe(401);
    expect((await readOnly.get("/${n.kebab}")).status).toBe(200);
    expect((await readOnly.post("/${n.kebab}").json({ name: "Nope" })).status).toBe(403);
  });
` : ""}});
`,
  };
}

export function moduleMigration(n: ModuleNames): string {
  return `-- migrate:up
create table ${n.snake} (
  id varchar(36) primary key,
  name varchar(200) not null,
  created_at varchar(32) not null
);

-- migrate:down
drop table ${n.snake};
`;
}

/** Created once per project and never overwritten, since apps customize them. */
export const SHARED_FILES: Record<string, string> = {
  "clock.ts": `import { token } from "@bun-hydrate/di";

/** Injected so tests can pin "now". */
export const Clock = token<() => Date>("Clock");
`,
  "pagination.ts": `/** Cursor pagination: pass \`nextCursor\` back as \`cursor\` to get the next page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
`,
};
