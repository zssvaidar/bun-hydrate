import { requirementOptions, type FeatureRequirement } from "./define";
import { FeaturePlanError, type FeatureRegistry } from "./registry";

export interface Resolved {
  id: string;
  /** Pulled in by the resolver rather than asked for. */
  auto: boolean;
  reason?: string;
}

const satisfied = (requirement: FeatureRequirement, present: ReadonlySet<string>) =>
  requirementOptions(requirement).some((id) => present.has(id));

/**
 * What adding `requested` means: missing requirements are added first (the first option of an
 * unmet any-of), and conflicts stop the plan before anything is written.
 */
export function resolveAdd(
  registry: FeatureRegistry,
  installed: ReadonlySet<string>,
  requested: readonly string[],
): { added: Resolved[]; alreadyInstalled: string[] } {
  const wanted = registry.expand(requested);
  const planned = new Map<string, Resolved>();
  const present = () => new Set([...installed, ...planned.keys()]);

  const include = (id: string, requiredBy?: string) => {
    if (installed.has(id) || planned.has(id)) return;
    for (const requirement of registry.get(id).requires ?? []) {
      if (!satisfied(requirement, present())) include(requirementOptions(requirement)[0]!, id);
    }
    planned.set(id, requiredBy ? { id, auto: true, reason: `required by ${requiredBy}` } : { id, auto: false });
  };
  for (const id of wanted) include(id);

  for (const { id } of planned.values()) {
    for (const other of registry.get(id).conflicts ?? []) {
      if (installed.has(other)) throw new FeaturePlanError(`${id} cannot be installed together with ${other} (installed)`);
      if (planned.has(other)) throw new FeaturePlanError(`${id} cannot be installed together with ${other} (in this plan)`);
    }
  }
  for (const id of installed) {
    for (const other of registry.get(id).conflicts ?? []) {
      if (planned.has(other)) throw new FeaturePlanError(`${other} cannot be installed together with ${id} (installed)`);
    }
  }

  const order = registry.order(planned.keys());
  return {
    added: order.map((id) => planned.get(id)!),
    alreadyInstalled: wanted.filter((id) => installed.has(id)),
  };
}

/**
 * What removing `requested` means. Features left with an unmet requirement block the removal,
 * or with `cascade` are removed too. The result is in removal order: dependents first.
 */
export function resolveRemove(
  registry: FeatureRegistry,
  installed: ReadonlySet<string>,
  requested: readonly string[],
  { cascade }: { cascade: boolean },
): { removed: Resolved[] } {
  const direct = new Set<string>();
  for (const id of requested) {
    const members = registry.expand([id]);
    const present = members.filter((member) => installed.has(member));
    if (present.length === 0) throw new FeaturePlanError(`${id} is not installed`);
    present.forEach((member) => direct.add(member));
  }

  const removing = new Map<string, Resolved>([...direct].map((id) => [id, { id, auto: false }]));
  for (let changed = true; changed; ) {
    changed = false;
    const remaining = new Set([...installed].filter((id) => !removing.has(id)));
    const broken = [...remaining].filter((id) =>
      (registry.get(id).requires ?? []).some((requirement) => !satisfied(requirement, remaining)),
    );
    if (broken.length === 0) break;
    if (!cascade) {
      const names = registry.order(broken).join(", ");
      const verb = broken.length === 1 ? "depends" : "depend";
      throw new FeaturePlanError(
        `Cannot remove ${[...direct].join(", ")}: ${names} ${verb} on it. Remove them first, or use --cascade.`,
      );
    }
    for (const id of broken) removing.set(id, { id, auto: true, reason: `depends on ${[...direct].join(", ")}` });
    changed = true;
  }

  return { removed: registry.order(removing.keys()).reverse().map((id) => removing.get(id)!) };
}
