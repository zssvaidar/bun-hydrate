/**
 * The contract of a feature the orchestrator can add and remove (spec-5 §9.1). A feature is data:
 * files it creates, tables it owns, what it needs, and what it contributes to shared files.
 */

/** A feature id, or a list meaning "at least one of these" (the first is added when none is). */
export type FeatureRequirement = string | readonly string[];

export interface EnvRequirement {
  name: string;
  description: string;
  /** Required variables are reported by `doctor` when unset. Default: false. */
  required?: boolean;
}

export interface FeatureMigration {
  /** SQL applied when the feature is added. Use `create … if not exists`, so re-adding works. */
  up: string;
  /** SQL that undoes `up`; also the body of a `--drop-data` removal. */
  down: string;
  /** Tables `down` drops, named in the "data kept" note. */
  tables: readonly string[];
}

export interface FeatureCommand {
  name: string;
  usage: string;
  description: string;
}

/** What renderers see: every contribution to a slot, from installed features in dependency order. */
export interface Slots {
  get<T>(slot: string): T[];
}

/**
 * A file (or a marked block in one) owned by the orchestrator: rendered from the slots on every
 * add, remove and sync. `file` outputs are wholly generated; `block` outputs only rewrite the text
 * between `hydrate:<block>:start` and `hydrate:<block>:end`, leaving the rest to you.
 */
export type FeatureOutput =
  | { kind: "file"; path: string; render(slots: Slots): string }
  | { kind: "block"; path: string; block: string; initial: string; render(slots: Slots): string };

export interface FeatureDefinition {
  id: string;
  description: string;
  requires?: readonly FeatureRequirement[];
  conflicts?: readonly string[];
  /** Created on add and tracked by content hash; yours to edit. Deleted on remove only when unchanged. */
  files?: Readonly<Record<string, string>>;
  /** Created once when missing and never tracked or deleted: settings you own from the start. */
  scaffold?: Readonly<Record<string, string>>;
  migration?: FeatureMigration;
  env?: readonly EnvRequirement[];
  /** Contributions to slots rendered by outputs (this feature's or another's). */
  contributes?: Readonly<Record<string, readonly unknown[]>>;
  outputs?: readonly FeatureOutput[];
  /** Console commands this feature enables (`hydrate <name>`). */
  commands?: readonly FeatureCommand[];
  /** Module that exports `commands`, run by `hydrate <command>`. Relative to the project root. */
  commandsModule?: string;
  /** One-time wiring printed after the feature is added. */
  instructions?: readonly string[];
}

export interface FeaturePreset {
  id: string;
  description: string;
  features: readonly string[];
}

/** Identity helper, so definitions are checked where they are written. */
export function defineFeature(definition: FeatureDefinition): FeatureDefinition {
  return definition;
}

export function definePreset(preset: FeaturePreset): FeaturePreset {
  return preset;
}

export const requirementOptions = (requirement: FeatureRequirement): readonly string[] =>
  typeof requirement === "string" ? [requirement] : requirement;
