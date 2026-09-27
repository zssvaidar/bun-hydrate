import type { FeatureDefinition, FeaturePreset } from "../define";
import { FeatureRegistry } from "../registry";
import { authFeatures, authPresets } from "./auth";
import { platformFeatures } from "./platform";

/** Built-in features plus any the app lists in hydrate.config.ts (e.g. from third-party packages). */
export function createRegistry(
  extra: { features?: readonly FeatureDefinition[]; presets?: readonly FeaturePreset[] } = {},
): FeatureRegistry {
  return new FeatureRegistry([...authFeatures, ...platformFeatures, ...(extra.features ?? [])], [
    ...authPresets,
    ...(extra.presets ?? []),
  ]);
}
