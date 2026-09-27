/** A typed key for things that are not classes: functions, config objects, interfaces. */
export class Token<T> {
  declare readonly type: T;
  constructor(readonly name: string) {}
}

export function token<T>(name: string): Token<T> {
  return new Token<T>(name);
}

type Constructor<T> = abstract new (...args: never[]) => T;
export type Key<T> = Token<T> | Constructor<T>;

type Resolved<Deps extends readonly Key<unknown>[]> = {
  -readonly [I in keyof Deps]: Deps[I] extends Key<infer T> ? T : never;
};

/** A class whose constructor parameters are exactly what its `static inject` list resolves to. */
export type Injectable<T, Deps extends readonly Key<unknown>[]> = {
  new (...args: Resolved<Deps>): T;
  readonly inject?: Deps;
};

export type Lifetime = "singleton" | "scoped" | "transient";

export interface Resolver {
  get<T>(key: Key<T>): T;
}

export interface RegistrationOptions {
  /** Default: singleton. */
  lifetime?: Lifetime;
}

interface Registration {
  lifetime: Lifetime;
  create: (resolver: Resolver) => unknown;
  /** Values are handed in, not created, so the container does not dispose them. */
  owned: boolean;
}

interface ChainLink {
  key: Key<unknown>;
  lifetime: Lifetime;
}

const nameOf = (key: Key<unknown>) => key.name;

class ResolutionError extends Error {
  constructor(key: Key<unknown>, chain: readonly ChainLink[], reason: string) {
    const requiredBy = chain.length > 0 ? ` (required by ${chain.map((link) => nameOf(link.key)).join(" → ")})` : "";
    super(`Cannot resolve ${nameOf(key)}${requiredBy}: ${reason}`);
    this.name = "ResolutionError";
  }
}

/**
 * Holds instances for one lifetime boundary: the container's root (singletons) or a scope
 * (scoped instances, e.g. per request). Tracks what it created so it can dispose it.
 */
export class Scope implements Resolver, AsyncDisposable {
  private readonly instances = new Map<Key<unknown>, unknown>();
  private readonly created: unknown[] = [];

  /** @internal Use `container.createScope()`. */
  constructor(
    private readonly registrations: ReadonlyMap<Key<unknown>, Registration>,
    private readonly root: Scope | undefined,
  ) {}

  get<T>(key: Key<T>): T {
    return this.resolve(key, []) as T;
  }

  /** Sets a value for this scope only, such as the authenticated user of a request. */
  provide<T>(key: Key<T>, value: T): this {
    this.instances.set(key, value);
    return this;
  }

  async dispose(): Promise<void> {
    const instances = this.created.splice(0).reverse();
    this.instances.clear();
    for (const instance of instances) await disposeInstance(instance);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  /** @internal Drops a cached instance so an override takes effect. */
  forget(key: Key<unknown>): void {
    this.instances.delete(key);
  }

  private resolve(key: Key<unknown>, chain: readonly ChainLink[]): unknown {
    if (this.instances.has(key)) return this.instances.get(key);

    if (chain.some((link) => link.key === key)) {
      throw new Error(`Circular dependency: ${[...chain.map((link) => nameOf(link.key)), nameOf(key)].join(" → ")}`);
    }
    const registration = this.registrations.get(key);
    if (!registration) throw new ResolutionError(key, chain, "not registered");

    switch (registration.lifetime) {
      case "singleton":
        return this.root ? this.root.resolve(key, chain) : this.instantiate(key, registration, chain, true);
      case "scoped": {
        const captor = chain.find((link) => link.lifetime === "singleton");
        if (captor) {
          throw new ResolutionError(key, chain, `singleton ${nameOf(captor.key)} would capture scoped ${nameOf(key)}`);
        }
        if (!this.root) {
          throw new Error(
            `Cannot resolve ${nameOf(key)} from the root container: it is scoped. Resolve it from a scope (createScope()).`,
          );
        }
        return this.instantiate(key, registration, chain, true);
      }
      case "transient":
        return this.instantiate(key, registration, chain, false);
    }
  }

  private instantiate(key: Key<unknown>, registration: Registration, chain: readonly ChainLink[], cache: boolean) {
    const nextChain = [...chain, { key, lifetime: registration.lifetime }];
    const resolver: Resolver = { get: <T>(dependency: Key<T>) => this.resolve(dependency, nextChain) as T };
    const instance = registration.create(resolver);

    if (cache) this.instances.set(key, instance);
    if (registration.owned) this.created.push(instance);
    return instance;
  }
}

async function disposeInstance(instance: unknown): Promise<void> {
  if (typeof instance !== "object" || instance === null) return;
  const { [Symbol.asyncDispose]: disposeAsync, [Symbol.dispose]: disposeSync } = instance as Partial<
    AsyncDisposable & Disposable
  >;
  if (typeof disposeAsync === "function") await disposeAsync.call(instance);
  else if (typeof disposeSync === "function") disposeSync.call(instance);
}

/**
 * Explicit, reflection-free dependency injection (spec-4 §3). Classes declare what they need
 * with `static inject = [...] as const`, and the compiler checks it against the constructor.
 */
export class Container implements Resolver, AsyncDisposable {
  private readonly registrations = new Map<Key<unknown>, Registration>();
  private readonly rootScope = new Scope(this.registrations, undefined);

  bind<T, const Deps extends readonly Key<unknown>[] = []>(
    cls: Injectable<T, Deps>,
    options: RegistrationOptions = {},
  ): this {
    const dependencies = cls.inject ?? [];
    return this.register(cls, {
      lifetime: options.lifetime ?? "singleton",
      create: (resolver) => new cls(...(dependencies.map((dependency) => resolver.get(dependency)) as Resolved<Deps>)),
      owned: true,
    });
  }

  factory<T>(key: Key<T>, create: (resolver: Resolver) => T, options: RegistrationOptions = {}): this {
    return this.register(key, { lifetime: options.lifetime ?? "singleton", create, owned: true });
  }

  value<T>(key: Key<T>, value: T): this {
    return this.register(key, { lifetime: "singleton", create: () => value, owned: false });
  }

  /** Replaces a registration with a value — typically a fake in tests. */
  override<T>(key: Key<T>, value: T): this {
    this.registrations.delete(key);
    this.rootScope.forget(key);
    return this.value(key, value);
  }

  has(key: Key<unknown>): boolean {
    return this.registrations.has(key);
  }

  get<T>(key: Key<T>): T {
    return this.rootScope.get(key);
  }

  createScope(): Scope {
    return new Scope(this.registrations, this.rootScope);
  }

  /** Disposes every singleton the container created, in reverse creation order. */
  dispose(): Promise<void> {
    return this.rootScope.dispose();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  private register(key: Key<unknown>, registration: Registration): this {
    if (this.registrations.has(key)) {
      throw new Error(`${nameOf(key)} is already registered; use override() to replace it`);
    }
    this.registrations.set(key, registration);
    return this;
  }
}
