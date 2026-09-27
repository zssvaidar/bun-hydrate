# bun-hydrate Spec 4 — Backend Foundation Detailed Design (v0.2)

**Document:** `spec-4`
**Status:** Accepted for implementation
**Builds on:** `spec-1` §28 (v0.2), `spec-2` (FR-230/231), `spec-3` (kernel)
**Scope:** Validation, dependency injection, database + transactions + migrations, the module pattern (controller/service/repository), CLI generators and `db:*` commands, and testing helpers. Deployment scripts (`Jenkinsfile`, `deploy.sh`) are out of scope and untouched.

---

## 1. New packages

```text
packages/
├── validation/   @bun-hydrate/validation   schema builder, Standard Schema interop, validate() route helper
├── di/           @bun-hydrate/di           container, tokens, lifetimes, scopes, request-scope middleware
├── database/     @bun-hydrate/database     Bun.SQL wrapper, ambient transactions, error mapping, migrator
├── testing/      + @bun-hydrate/testing/database   createTestDatabase()
└── cli/          + generate, db:* commands
```

Each package is optional, so a simple app still uses only `@bun-hydrate/core` (UPL §19, progressive complexity). None of them depends on a third-party runtime library.

---

## 2. Validation (FR-050, FR-051)

### 2.1 Interop first: Standard Schema

The validation layer accepts any schema that implements [Standard Schema v1](https://standardschema.dev), the shared interface implemented by Zod, Valibot and ArkType. Apps can bring the library they already know, and the framework has no hard dependency on any of them (spec-1 §2.4). The interface is types only; it is vendored into `packages/validation/src/standard-schema.ts`, as the spec recommends.

### 2.2 Built-in schema builder

A small builder ships so that the common path needs no dependency. It implements Standard Schema:

```ts
const CreateUser = schema.object({
  name: schema.string().trim().min(2).max(100),
  email: schema.email(),
  age: schema.number().int().min(0).optional(),
  role: schema.enum(["member", "admin"]).default("member"),
});
type CreateUser = Infer<typeof CreateUser>; // { name: string; email: string; age?: number; role: "member" | "admin" }
```

| Builder | Checks |
|---|---|
| `string()` | `min`, `max`, `length`, `regex`, `trim` (transform), `nonEmpty` |
| `email()`, `url()`, `uuid()` | format-checked strings |
| `number()` | finite; `int`, `min`, `max`, `positive` |
| `boolean()`, `literal(v)`, `enum([...])` | |
| `array(item)` | `min`, `max`; issue paths include the index |
| `object(shape)` | unknown keys are **stripped** by default; `.strict()` rejects them |
| modifiers | `.optional()`, `.nullable()`, `.default(v)`, `.refine(fn, message)` |
| `coerce.number()`, `coerce.boolean()`, `coerce.integer()` | parse strings, for query/params |

Messages are written for end users ("Must be at least 2 characters"). Issue paths are arrays that get joined as `items.0.name` in responses.

### 2.3 Route validation with typed input

```ts
router.post(
  "/",
  validate({ body: CreateUser, query: ListQuery }, async (ctx, { body, query }) => { … }),
);
```

`validate(shape, handler)` returns a normal `Handler`, so it composes with the existing router and needs no router changes. The handler's second argument is typed from the schemas.

- Sources: `body` (JSON), `query` (a repeated key becomes an array), `params`, and `headers` (lower-cased names).
- Every source is validated, and **all** issues are reported together as `422 VALIDATION_FAILED`:
  ```json
  { "error": { "code": "VALIDATION_FAILED", "message": "Invalid request", "requestId": "…",
      "details": [{ "location": "body", "path": "email", "message": "Must be a valid email address" }] } }
  ```
- Malformed JSON is still `400 INVALID_JSON` (from `ctx.body.json()`), which is distinct from well-formed but invalid input.

**Deviation from spec-1 FR-051:** spec-1 sketches `validateBody(schema)` as middleware. Middleware can't pass typed data to a handler through a router without threading generics through every API. Wrapping the handler keeps full inference with a plain function. `parse(schema, value)` is also exported for validating anything that isn't a request (jobs, config files).

---

## 3. Dependency injection (FR-040)

Explicit and reflection-free: no decorators and no `reflect-metadata`. Dependencies are declared on the class, and the type checker verifies them against the constructor:

```ts
export class UsersService {
  static readonly inject = [UsersRepository, Clock] as const;
  constructor(private readonly users: UsersRepository, private readonly clock: Clock) {}
}

const Clock = token<() => Date>("Clock");

const container = new Container()
  .value(Database, db)
  .factory(Clock, () => () => new Date())
  .bind(UsersRepository)
  .bind(UsersService);          // compile error if `inject` doesn't match the constructor
```

- **Keys** are classes or `token<T>(name)`s.
- **Registrations:** `bind(Class)`, `factory(key, (resolver) => value)` and `value(key, value)`, each with a lifetime option.
- **Lifetimes:** `singleton` (the default: one per container), `scoped` (one per scope, e.g. per request) and `transient` (new every time).
- **Scopes:** `container.createScope()` resolves scoped registrations. Resolving a scoped key from the root is an error, and so is a singleton depending on a scoped key (a captive dependency).
- **Errors name the whole chain**, for example `Cannot resolve Database (required by UsersService → UsersRepository): not registered`. Cycles are reported as `A → B → A`.
- **Disposal:** `scope.dispose()` / `container.dispose()` call `Symbol.asyncDispose` / `Symbol.dispose` on the instances they created, in reverse creation order. `value()` registrations are not owned, so they are not disposed.
- **Per-request scope:** `app.use(requestScope(container))` creates a scope per request and disposes it after the response. `scopeOf(ctx)` resolves from it.
- **Tests:** `container.override(key, value)` replaces a registration, e.g. with a fake. Registering a key twice without `override` throws, so accidental double registration is caught.

DI stays optional (FR-040): nothing in core requires it.

---

## 4. Database (FR-060, FR-061)

### 4.1 Bun-native driver

`createDatabase(url)` wraps **`Bun.SQL`**, Bun's built-in client for PostgreSQL, MySQL and SQLite (`postgres://`, `mysql://`, `sqlite://path`, `sqlite://:memory:`). There is no driver dependency, and the same tagged-template API works across engines. This follows spec-1's advice to integrate with an established library rather than build an ORM; here the established library is the runtime itself. Query builders (Kysely, Drizzle) can sit on top later as optional adapters.

```ts
const db = createDatabase({ url: config.databaseUrl });
const [user] = await db.sql`select * from users where id = ${id}`;   // always parameterized
await db.sql`insert into users ${db.sql(row)}`;                      // object → columns/values
db.raw; // the underlying Bun.SQL instance (escape hatch, spec-1 §23)
```

### 4.2 Ambient transactions

```ts
await db.transaction(async () => {
  const user = await users.create(input);        // repositories use db.sql as usual…
  await audit.record("user.created", user.id);   // …and automatically join the transaction
});
```

- `db.sql` resolves through `AsyncLocalStorage`. Inside `db.transaction()` it is the transaction; outside, it is the pool. Repositories never take a `tx` parameter, and services decide transaction boundaries without knowing how repositories are implemented.
- A thrown error rolls back; otherwise the transaction commits (FR-061).
- **Nested** `db.transaction()` calls become **savepoints**, so an inner failure caught by the caller rolls back only the inner block.
- The callback also receives the transaction explicitly, for code that prefers passing it.

**SQLite foreign keys.** SQLite ignores foreign keys unless each connection enables them. `createDatabase` turns them on (`PRAGMA foreign_keys = ON`), so constraints behave the same as on Postgres. The foreign-key test caught this.

### 4.3 Error mapping

Driver errors differ per engine: Postgres reports SQLSTATE `23505` in `errno`, while SQLite uses `code: "SQLITE_CONSTRAINT_UNIQUE"`. `isUniqueViolation(error)` and `isForeignKeyViolation(error)` normalize them, so repositories can translate them to `ConflictError` without engine-specific code.

**Tested engines:** SQLite always, and Postgres 16 when `TEST_POSTGRES_URL` is set, including savepoints and two instances migrating concurrently under the advisory lock. MySQL goes through the same Bun.SQL API, but its error codes (1062, 1451/1452) and migrations are **untested**; there is no advisory lock for it yet.

### 4.4 Migrations

Plain SQL files, versioned with the code (UPL §10):

```text
migrations/20260927120000_create_users.sql
-- migrate:up
create table users (…);

-- migrate:down
drop table users;
```

- `Migrator({ db, directory })` provides `create(name)`, `migrate()`, `rollback({ steps })` and `status()`.
- Applied migrations are tracked in the `hydrate_migrations` table (`name`, `batch`, `applied_at`). `migrate()` applies all pending files in name order **as one batch**, each file in its own transaction. `rollback()` undoes the last batch by default, in reverse order.
- A file without a `-- migrate:up` section is rejected. Rolling back a migration without `-- migrate:down` fails with a clear message rather than silently skipping.
- `status()` reports applied, pending, and **missing** migrations (recorded as applied, but the file is gone), which catches branch mix-ups.
- On Postgres, `migrate()`/`rollback()` hold an advisory lock, so two instances starting at once cannot apply the same migration twice.

### 4.5 Health

`db.ping()` runs `select 1`. Apps register it as a readiness check: `app.readinessCheck("database", () => db.ping())`. Pair it with `app.onStart(() => () => db.close())`.

---

## 5. Module pattern (spec-1 §11, UPL §8)

The reference `users` module, and what `hydrate generate module` emits:

```text
src/modules/users/
├── users.schema.ts       request/response schemas and types
├── users.repository.ts   SQL only; maps constraint errors to ConflictError
├── users.service.ts      business rules; throws NotFoundError / ConflictError
├── users.controller.ts   HTTP concerns: input → service call → status/shape
├── users.routes.ts       Router: paths + validate() + controller methods
├── users.module.ts       registers the classes in a container, returns the Router
└── users.test.ts         HTTP tests against an in-memory database
```

`users.module.ts` was added during implementation. It lets a module test build just the module (`new App().route("/users", usersModule(container))`), independent of `app.ts`, and gives `app.ts` a one-line mount.

- Controllers are singletons resolved from the container when the app is built, and the routes file receives the controller instance: `usersRoutes(container.get(UsersController))`. Wiring is visible in `app.ts` with no route-discovery magic, which keeps generated code ordinary code (UPL §24).
- **API conventions (spec-2):** routes are versioned under `/api/v1` (FR-230). Lists use cursor pagination, `?limit=20&cursor=…` → `{ items, nextCursor }` (FR-231).

---

## 6. CLI additions (FR-191, FR-192; spec-2 §2.6 canonical names)

| Command | Behaviour |
|---|---|
| `hydrate generate module <name>` | Writes the seven module files plus a `create_<table>` migration, and `src/shared/{clock,pagination}.ts` if they are missing. Checks every target first and refuses to overwrite, so a conflict never leaves a half-written module. Prints the wiring lines to add to `app.ts`. |
| `hydrate generate middleware <name>` | Writes `src/middleware/<name>.ts` and its test |
| `hydrate db:migration create <name>` | Writes an empty timestamped migration |
| `hydrate db:migrate` | Applies pending migrations |
| `hydrate db:rollback [--steps n]` | Rolls back the last batch, or `n` migrations |
| `hydrate db:status` | Lists applied, pending and missing migrations |
| `hydrate db:seed` | Runs the default export of the seed file with the database |

- The database URL comes from `DATABASE_URL`, which Bun loads from `.env`. Paths come from `hydrate.config.ts` under `database: { migrations: "migrations", seed: "src/database/seed.ts" }`.
- `hydrate build` copies the migrations directory into `dist/migrations`, so the artifact can migrate itself on start when configured to.

Generated code must type-check and its tests must pass unchanged. The generator's own test generates a module into a scratch project, then runs `tsc` and the generated test.

---

## 7. Testing helpers (FR-200)

- `createTestDatabase({ migrations })` from `@bun-hydrate/testing/database` returns an in-memory SQLite database with the migrations applied. It is fast, isolated per test, and needs no server.
- `container.override(key, fake)` replaces dependencies (§3).
- Database-package tests run against SQLite always. When `TEST_POSTGRES_URL` is set, they also run against Postgres, so both engines' error mapping, savepoints and advisory locks are covered.

---

## 8. Reference app changes

- New `users` module (CRUD) under `/api/v1/users`, and `GET /api/time` moves to `/api/v1/time`.
- Config gains:
  - `DATABASE_URL`, defaulting to `sqlite://:memory:` so the app runs with zero setup.
  - `MIGRATE_ON_START`, default `false`. An in-memory database is always migrated on start, because it starts empty by definition.
- `main.ts` wires up the database's readiness check and connection cleanup.
