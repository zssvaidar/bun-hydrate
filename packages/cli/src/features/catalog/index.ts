import type { FeatureDefinition, FeaturePreset } from "../define";
import { FeatureRegistry } from "../registry";
import { authFeatures, authPresets } from "./auth";
import { distributedFeatures } from "./distributed";
import { platformFeatures } from "./platform";
import { stylesFeatures } from "./styles";

/** Built-in features plus any the app lists in hydrate.config.ts (e.g. from third-party packages). */
export function createRegistry(
  extra: { features?: readonly FeatureDefinition[]; presets?: readonly FeaturePreset[] } = {},
): FeatureRegistry {
  return new FeatureRegistry([...authFeatures, ...platformFeatures, ...distributedFeatures, ...stylesFeatures, ...(extra.features ?? [])], [
    ...authPresets,
    ...(extra.presets ?? []),
  ]);
}
