import type { Context, Middleware, Router } from "@bun-hydrate/core";
import type { Container } from "@bun-hydrate/di";
import { authenticate, type Strategy } from "./authenticate";
import type { Policy } from "./permissions";
import type { Principal } from "./principal";
import type { PackagedFeatureOptions } from "./features";
import { authSnapshot, type AuthSnapshot } from "./snapshot";

export interface AuthConfig<User = Record<string, unknown>> {
  policy: Policy;
  /** Picks what the browser may see about the signed-in principal. Default: `{ id }`. */
  user?: (principal: Principal) => User;
  /** Settings for the packaged features, passed by the generated composition root. */
  features?: PackagedFeatureOptions;
}

/** A requirement is a feature id, or a list meaning "at least one of these". */
export type FeatureRequirement = string | readonly string[];

/**
 * One capability's runtime contribution (spec-5 §9.4). The same id is used by the CLI feature
 * that generated the code, so a hand-edited composition root is checked against the same graph.
 */
export interface AuthFeature {
  id: string;
  requires?: readonly FeatureRequirement[];
  /** Registers services and stores. Runs for every feature before anything else is resolved. */
  register?(container: Container): void;
  /** Tried in feature order by authenticate(); the first to recognise a credential wins. */
  strategies?(container: Container): Strategy[];
  /** App-wide middleware that runs after authentication, e.g. csrf(). */
  middleware?(container: Container): Middleware[];
  routes?(container: Container): { path: string; router: Router }[];
}

/** Identity helper so feature objects are checked against AuthFeature where they are written. */
export function defineAuthFeature(feature: AuthFeature): AuthFeature {
  return feature;
}

export interface CreateAuthOptions<User> {
  config: AuthConfig<User>;
  features: readonly AuthFeature[];
}

export interface Auth<User> {
  /** In dependency order. */
  readonly features: readonly AuthFeature[];
  readonly policy: Policy;
  has(id: string): boolean;
  /** Registers every feature's services, without an app: for console commands and workers. */
  register(container: Container): void;
  /** Wires every feature into the app: services, authenticate(), middleware, then routes. */
  install(app: Router, container: Container): void;
  /** For the React payload: `shared: (ctx) => ({ auth: auth.snapshot(ctx) })`. */
  snapshot(ctx: Context<any>): AuthSnapshot<User>;
}

export function createAuth<User = { id: string }>({ config, features }: CreateAuthOptions<User>): Auth<User> {
  const ordered = orderFeatures(features);
  const ids = new Set(ordered.map((feature) => feature.id));
  const user = config.user ?? ((principal: Principal) => ({ id: principal.id }) as User);
  const register = (container: Container) => {
    for (const feature of ordered) feature.register?.(container);
  };

  return {
    features: ordered,
    policy: config.policy,
    has: (id) => ids.has(id),
    register,
    // No `this`: the generated root exports `installAuth = auth.install` as a plain function.
    install(app, container) {
      register(container);
      const strategies = ordered.flatMap((feature) => feature.strategies?.(container) ?? []);
      app.use(authenticate({ strategies, policy: config.policy }));
      for (const feature of ordered) app.use(...(feature.middleware?.(container) ?? []));
      for (const feature of ordered) {
        for (const { path, router } of feature.routes?.(container) ?? []) app.route(path, router);
      }
    },
    snapshot: (ctx) => authSnapshot(ctx, { user }),
  };
}

/**
 * Validates requirements and returns the features in dependency order. A feature keeps its
 * place in the given list unless something it requires comes later.
 */
function orderFeatures(features: readonly AuthFeature[]): AuthFeature[] {
  const byId = new Map<string, AuthFeature>();
  for (const feature of features) {
    if (byId.has(feature.id)) throw new Error(`Auth feature "${feature.id}" is listed twice`);
    byId.set(feature.id, feature);
  }

  for (const feature of features) {
    for (const requirement of feature.requires ?? []) {
      const options = typeof requirement === "string" ? [requirement] : requirement;
      if (options.some((id) => byId.has(id))) continue;
      const wanted = options.length === 1 ? `"${options[0]}"` : `one of ${options.map((id) => `"${id}"`).join(", ")}`;
      throw new Error(`Auth feature "${feature.id}" requires ${wanted}, which is not in createAuth({ features })`);
    }
  }

  const ordered: AuthFeature[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (feature: AuthFeature) => {
    if (placed.has(feature.id)) return;
    if (visiting.has(feature.id)) throw new Error(`Auth features have a dependency cycle through "${feature.id}"`);
    visiting.add(feature.id);
    for (const requirement of feature.requires ?? []) {
      for (const id of typeof requirement === "string" ? [requirement] : requirement) {
        const dependency = byId.get(id);
        if (dependency) place(dependency);
      }
    }
    visiting.delete(feature.id);
    placed.add(feature.id);
    ordered.push(feature);
  };
  for (const feature of features) place(feature);
  return ordered;
}
