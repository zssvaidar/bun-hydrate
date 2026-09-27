import { requirementOptions, type FeatureDefinition, type FeaturePreset } from "./define";

/** A plan cannot be made; the message says why and what to do. Nothing has been written. */
export class FeaturePlanError extends Error {
  override name = "FeaturePlanError";
}

/** Every feature and preset the CLI knows about, checked for consistency up front. */
export class FeatureRegistry {
  private readonly features = new Map<string, FeatureDefinition>();
  private readonly presets = new Map<string, FeaturePreset>();

  constructor(features: readonly FeatureDefinition[], presets: readonly FeaturePreset[] = []) {
    for (const feature of features) {
      if (this.features.has(feature.id)) throw new Error(`Feature "${feature.id}" is defined twice`);
      this.features.set(feature.id, feature);
    }
    for (const feature of features) {
      for (const id of [...(feature.requires ?? []).flatMap(requirementOptions), ...(feature.conflicts ?? [])]) {
        if (!this.features.has(id)) throw new Error(`Feature "${feature.id}" requires unknown feature "${id}"`);
      }
    }
    for (const preset of presets) {
      if (this.features.has(preset.id) || this.presets.has(preset.id)) throw new Error(`Preset "${preset.id}" clashes with another id`);
      for (const id of preset.features) this.get(id);
      this.presets.set(preset.id, preset);
    }
  }

  all(): FeatureDefinition[] {
    return [...this.features.values()];
  }

  allPresets(): FeaturePreset[] {
    return [...this.presets.values()];
  }

  has(id: string): boolean {
    return this.features.has(id);
  }

  get(id: string): FeatureDefinition {
    const feature = this.features.get(id);
    if (!feature) throw new FeaturePlanError(`Unknown feature "${id}". Run \`hydrate features\` to see what is available.`);
    return feature;
  }

  /** Replaces preset ids with their features; keeps order and drops duplicates. */
  expand(ids: readonly string[]): string[] {
    const expanded = ids.flatMap((id) => this.presets.get(id)?.features ?? [this.get(id).id]);
    return [...new Set(expanded)];
  }

  /** Dependency order (requirements first), otherwise registration order. Stable for rendering. */
  order(ids: Iterable<string>): string[] {
    const wanted = new Set(ids);
    const ordered: string[] = [];
    const place = (id: string) => {
      if (ordered.includes(id) || !wanted.has(id)) return;
      for (const requirement of this.get(id).requires ?? []) requirementOptions(requirement).forEach(place);
      ordered.push(id);
    };
    for (const id of this.features.keys()) place(id);
    return ordered;
  }
}
