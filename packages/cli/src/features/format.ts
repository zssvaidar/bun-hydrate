import type { Plan, Step } from "./plan";

const COLUMN = 35;

function row(symbol: string, label: string, note?: string): string {
  if (!note) return `  ${symbol} ${label}`;
  return `  ${symbol} ${label.padEnd(COLUMN)}${label.length >= COLUMN ? " " : ""}(${note})`;
}

const SYMBOLS: Record<Step["op"], string> = { create: "+", update: "~", delete: "-", keep: "=" };

/** The plan as shown before `Apply? [Y/n]` and by `--dry-run`. */
export function formatPlan(plan: Plan): string {
  const title = plan.action === "sync" ? "Plan: sync" : `Plan: ${plan.action} ${plan.requested.join(" ")}`;
  if (plan.action !== "sync" && plan.features.length === 0) {
    return `${title}\n  Nothing to do: already installed.`;
  }
  if (plan.steps.length === 0 && plan.features.length === 0) {
    return `${title}\n  Nothing to do: generated files are up to date.`;
  }

  const lines = [title];
  const featureSymbol = plan.action === "add" ? "+" : "-";
  for (const feature of plan.features) lines.push(row(featureSymbol, feature.id, feature.reason));
  if (plan.features.length > 0) lines.push("");
  for (const step of plan.steps) {
    const symbol = step.op === "keep" && step.warn ? "!" : SYMBOLS[step.op];
    lines.push(row(symbol, step.path, step.note));
  }
  if (plan.notes.length > 0) lines.push("", "Then:", ...plan.notes.map((note) => `  - ${note}`));
  return lines.join("\n");
}
