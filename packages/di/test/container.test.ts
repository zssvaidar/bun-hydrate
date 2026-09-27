import { describe, expect, test } from "bun:test";
import { Container, token, type Key } from "../src/index";

class Database {
  static created = 0;
  readonly engine = "sqlite";
  constructor() {
    Database.created++;
  }
}

class UsersRepository {
  static readonly inject = [Database] as const;
  constructor(readonly db: Database) {}
}

const Clock = token<() => Date>("Clock");

class UsersService {
  static readonly inject = [UsersRepository, Clock] as const;
  constructor(
    readonly users: UsersRepository,
    readonly clock: () => Date,
  ) {}
}

describe("Container", () => {
  test("binds classes and resolves their declared dependencies", () => {
    const now = new Date(0);
    const container = new Container()
      .bind(Database)
      .bind(UsersRepository)
      .bind(UsersService)
      .factory(Clock, () => () => now);

    const service = container.get(UsersService);

    expect(service.users).toBeInstanceOf(UsersRepository);
    expect(service.users.db).toBeInstanceOf(Database);
    expect(service.clock()).toBe(now);
  });

  test("singletons are created once, lazily", () => {
    Database.created = 0;
    const container = new Container().bind(Database);
    expect(Database.created).toBe(0);

    expect(container.get(Database)).toBe(container.get(Database));
    expect(Database.created).toBe(1);
  });

  test("transients are created on every resolution", () => {
    const container = new Container().bind(Database, { lifetime: "transient" });
    expect(container.get(Database)).not.toBe(container.get(Database));
  });

  test("values are returned as given", () => {
    const db = new Database();
    expect(new Container().value(Database, db).get(Database)).toBe(db);
  });

  test("factories receive a resolver for their own dependencies", () => {
    const Greeting = token<string>("Greeting");
    const Name = token<string>("Name");
    const container = new Container().value(Name, "Ada").factory(Greeting, (r) => `Hello, ${r.get(Name)}`);

    expect(container.get(Greeting)).toBe("Hello, Ada");
  });

  test("has() reports registrations", () => {
    const container = new Container().bind(Database);
    expect(container.has(Database)).toBe(true);
    expect(container.has(UsersService)).toBe(false);
  });

  test("missing registrations name the whole dependency chain", () => {
    const container = new Container().bind(UsersRepository).bind(UsersService).factory(Clock, () => () => new Date());

    expect(() => container.get(UsersService)).toThrow(
      "Cannot resolve Database (required by UsersService → UsersRepository): not registered",
    );
  });

  test("circular dependencies are reported instead of overflowing the stack", () => {
    class A {
      static inject: readonly Key<unknown>[] = [];
    }
    class B {
      static readonly inject = [A] as const;
      constructor(readonly a: A) {}
    }
    A.inject = [B];
    const container = new Container().bind(A).bind(B);

    expect(() => container.get(A)).toThrow("Circular dependency: A → B → A");
  });

  test("registering a key twice is an error; override() replaces it deliberately", () => {
    const container = new Container().bind(Database);
    expect(() => container.bind(Database)).toThrow("Database is already registered; use override() to replace it");

    const original = container.get(Database);
    const fake = new Database();
    container.override(Database, fake);

    expect(container.get(Database)).toBe(fake);
    expect(container.get(Database)).not.toBe(original);
  });

  test("constructor parameters are checked against `inject` (checked by tsc)", () => {
    class NeedsDatabase {
      constructor(readonly db: Database) {}
    }
    class WrongInject {
      static readonly inject = [Clock] as const;
      constructor(readonly db: Database) {}
    }
    const container = new Container();
    // @ts-expect-error — constructor needs a Database but declares no `inject`
    container.bind(NeedsDatabase);
    // @ts-expect-error — `inject` provides a Clock where the constructor wants a Database
    container.bind(WrongInject);
    // @ts-expect-error — value must match the token's type
    container.value(Clock, "not a function");

    const resolved: UsersService = new Container().value(UsersService, {} as UsersService).get(UsersService);
    void resolved;
  });
});

describe("scopes", () => {
  class RequestContext {
    static count = 0;
    readonly id = ++RequestContext.count;
  }

  test("scoped registrations are shared within a scope and separate across scopes", () => {
    const container = new Container().bind(RequestContext, { lifetime: "scoped" });
    const first = container.createScope();
    const second = container.createScope();

    expect(first.get(RequestContext)).toBe(first.get(RequestContext));
    expect(first.get(RequestContext)).not.toBe(second.get(RequestContext));
  });

  test("singletons resolved from a scope are shared with the root", () => {
    const container = new Container().bind(Database);
    expect(container.createScope().get(Database)).toBe(container.get(Database));
  });

  test("resolving a scoped key from the root is an error", () => {
    const container = new Container().bind(RequestContext, { lifetime: "scoped" });
    expect(() => container.get(RequestContext)).toThrow(
      "Cannot resolve RequestContext from the root container: it is scoped. Resolve it from a scope (createScope()).",
    );
  });

  test("a singleton may not capture a scoped dependency", () => {
    class Cache {
      static readonly inject = [RequestContext] as const;
      constructor(readonly request: RequestContext) {}
    }
    const container = new Container().bind(RequestContext, { lifetime: "scoped" }).bind(Cache);

    expect(() => container.createScope().get(Cache)).toThrow(
      "Cannot resolve RequestContext (required by Cache): singleton Cache would capture scoped RequestContext",
    );
  });

  test("provide() sets a per-scope value, e.g. the authenticated user", () => {
    const CurrentUser = token<{ id: string }>("CurrentUser");
    class Greeter {
      static readonly inject = [CurrentUser] as const;
      constructor(readonly user: { id: string }) {}
    }
    const container = new Container().bind(Greeter, { lifetime: "scoped" });
    const scope = container.createScope().provide(CurrentUser, { id: "u1" });

    expect(scope.get(Greeter).user).toEqual({ id: "u1" });
  });
});

describe("disposal", () => {
  function tracked(log: string[], name: string, kind: "sync" | "async") {
    return kind === "async"
      ? { [Symbol.asyncDispose]: async () => void log.push(name) }
      : { [Symbol.dispose]: () => void log.push(name) };
  }

  test("container.dispose() disposes created instances in reverse creation order, but not values", async () => {
    const log: string[] = [];
    const First = token<object>("First");
    const Second = token<object>("Second");
    const Given = token<object>("Given");
    const container = new Container()
      .factory(First, () => tracked(log, "first", "async"))
      .factory(Second, () => tracked(log, "second", "sync"))
      .value(Given, tracked(log, "given", "sync"));

    container.get(First);
    container.get(Second);
    container.get(Given);
    await container.dispose();

    expect(log).toEqual(["second", "first"]);
  });

  test("scope.dispose() disposes only what the scope created", async () => {
    const log: string[] = [];
    const Singleton = token<object>("Singleton");
    const PerRequest = token<object>("PerRequest");
    const container = new Container()
      .factory(Singleton, () => tracked(log, "singleton", "sync"))
      .factory(PerRequest, () => tracked(log, "scoped", "sync"), { lifetime: "scoped" });

    const scope = container.createScope();
    scope.get(Singleton);
    scope.get(PerRequest);
    await scope.dispose();

    expect(log).toEqual(["scoped"]);
  });

  test("scopes work with `await using`", async () => {
    const log: string[] = [];
    const PerRequest = token<object>("PerRequest");
    const container = new Container().factory(PerRequest, () => tracked(log, "scoped", "async"), { lifetime: "scoped" });

    {
      await using scope = container.createScope();
      scope.get(PerRequest);
    }

    expect(log).toEqual(["scoped"]);
  });
});
