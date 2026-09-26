import type { Context } from "./context";
import type { Middleware } from "./middleware";
import type { HandlerResult } from "./response";
import { ANY_METHOD, splitPath } from "./route-trie";

type ParamNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;

type WildcardName<Path extends string> = Path extends `${string}*` ? "*" : never;

/** `PathParams<"/users/:id/*">` is `{ id: string; "*": string }`. */
export type PathParams<Path extends string> = { [K in ParamNames<Path> | WildcardName<Path>]: string };

export type Handler<Params = Record<string, string>> = (
  ctx: Context<Params>,
) => HandlerResult | Promise<HandlerResult>;

type RouteArgs<Path extends string> = [...middleware: Middleware[], handler: Handler<PathParams<Path>>];

export interface RouteDefinition {
  method: string;
  path: string;
  middleware: readonly Middleware[];
  handler: Handler<any>;
}

interface Mount {
  prefix: string;
  router: Router;
}

export function joinPaths(...paths: string[]): string {
  return "/" + paths.flatMap(splitPath).join("/");
}

/**
 * A group of routes with its own middleware. Routers can be mounted under a prefix with
 * `route()`; their middleware applies only to their own (and nested) routes.
 */
export class Router {
  private readonly middleware: Middleware[] = [];
  private readonly definitions: RouteDefinition[] = [];
  private readonly mounts: Mount[] = [];
  private readonly parents = new Set<Router>();
  /** Bumped on every change here or in a mounted router, so owners know to recompile. */
  protected revision = 0;

  use(...middleware: Middleware[]): this {
    this.middleware.push(...middleware);
    this.changed();
    return this;
  }

  get<Path extends string>(path: Path, ...args: RouteArgs<Path>): this {
    return this.add("GET", path, args);
  }

  post<Path extends string>(path: Path, ...args: RouteArgs<Path>): this {
    return this.add("POST", path, args);
  }

  put<Path extends string>(path: Path, ...args: RouteArgs<Path>): this {
    return this.add("PUT", path, args);
  }

  patch<Path extends string>(path: Path, ...args: RouteArgs<Path>): this {
    return this.add("PATCH", path, args);
  }

  delete<Path extends string>(path: Path, ...args: RouteArgs<Path>): this {
    return this.add("DELETE", path, args);
  }

  options<Path extends string>(path: Path, ...args: RouteArgs<Path>): this {
    return this.add("OPTIONS", path, args);
  }

  head<Path extends string>(path: Path, ...args: RouteArgs<Path>): this {
    return this.add("HEAD", path, args);
  }

  all<Path extends string>(path: Path, ...args: RouteArgs<Path>): this {
    return this.add(ANY_METHOD, path, args);
  }

  route(prefix: string, router: Router): this {
    if (router === this) throw new Error("A router cannot be mounted on itself");
    this.mounts.push({ prefix, router });
    router.parents.add(this);
    this.changed();
    return this;
  }

  /** Every route reachable from this router, with prefixes joined and middleware chains resolved. */
  protected collectRoutes(prefix = "", inherited: readonly Middleware[] = []): RouteDefinition[] {
    const own = this.definitions.map((definition) => ({
      ...definition,
      path: joinPaths(prefix, definition.path),
      middleware: [...inherited, ...definition.middleware],
    }));
    const nested = this.mounts.flatMap(({ prefix: mountPrefix, router }) =>
      router.collectRoutes(joinPaths(prefix, mountPrefix), [...inherited, ...router.middleware]),
    );
    return [...own, ...nested];
  }

  protected get ownMiddleware(): readonly Middleware[] {
    return this.middleware;
  }

  private add(method: string, path: string, args: unknown[]): this {
    const handler = args.at(-1) as Handler<any> | undefined;
    if (typeof handler !== "function") throw new TypeError(`Route ${method} ${path} needs a handler`);
    this.definitions.push({ method, path, middleware: args.slice(0, -1) as Middleware[], handler });
    this.changed();
    return this;
  }

  private changed(): void {
    this.revision++;
    for (const parent of this.parents) parent.changed();
  }
}
