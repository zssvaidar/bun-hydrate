import type { Logger } from "@bun-hydrate/core";

export type Labels<Name extends string = string> = Partial<Record<Name, string>>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(pairs: [string, string][]): string {
  return pairs.length === 0 ? "" : `{${pairs.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

interface SeriesGuard {
  maxSeries: number;
  logger: Logger | undefined;
}

/** Shared by all metric kinds: label validation, series storage and the cardinality cap. */
abstract class Metric<Value> {
  protected readonly series = new Map<string, { labels: [string, string][]; value: Value }>();
  private warned = false;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    private readonly guard: SeriesGuard,
  ) {
    if (!NAME.test(name)) throw new Error(`Invalid metric name "${name}"`);
    for (const label of labelNames) if (!LABEL.test(label)) throw new Error(`Invalid label name "${label}" for ${name}`);
  }

  abstract readonly type: "counter" | "gauge" | "histogram";
  protected abstract initial(): Value;
  abstract samples(): string[];

  /** The series for these labels, or undefined when the cap is reached (the observation is dropped). */
  protected entry(labels: Labels = {}): { labels: [string, string][]; value: Value } | undefined {
    for (const name of Object.keys(labels)) {
      if (!this.labelNames.includes(name)) throw new Error(`Unknown label "${name}" for ${this.name}`);
    }
    const pairs = this.labelNames.map((name): [string, string] => [name, labels[name] ?? ""]);
    const key = JSON.stringify(pairs.map(([, value]) => value));

    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= this.guard.maxSeries) {
        if (!this.warned) {
          this.warned = true;
          this.guard.logger?.warn("Metric series limit reached; new label combinations are dropped", {
            metric: this.name,
            maxSeries: this.guard.maxSeries,
          });
        }
        return undefined;
      }
      entry = { labels: pairs, value: this.initial() };
      this.series.set(key, entry);
    }
    return entry;
  }

  render(): string {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`, ...this.samples()].join("\n");
  }
}

export class Counter<L extends string = string> extends Metric<number> {
  readonly type = "counter";

  protected initial() {
    return 0;
  }

  inc(labels: Labels<L> = {}, value = 1): void {
    if (value < 0) throw new Error("Counters can only increase");
    const entry = this.entry(labels);
    if (entry) entry.value += value;
  }

  samples() {
    return [...this.series.values()].map(({ labels, value }) => `${this.name}${formatLabels(labels)} ${value}`);
  }
}

export class Gauge<L extends string = string> extends Metric<number> {
  readonly type = "gauge";

  protected initial() {
    return 0;
  }

  set(labels: Labels<L>, value: number): void {
    const entry = this.entry(labels);
    if (entry) entry.value = value;
  }

  inc(labels: Labels<L> = {}, value = 1): void {
    const entry = this.entry(labels);
    if (entry) entry.value += value;
  }

  dec(labels: Labels<L> = {}, value = 1): void {
    this.inc(labels, -value);
  }

  samples() {
    return [...this.series.values()].map(({ labels, value }) => `${this.name}${formatLabels(labels)} ${value}`);
  }
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramValue {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram<L extends string = string> extends Metric<HistogramValue> {
  readonly type = "histogram";

  constructor(name: string, help: string, labelNames: readonly string[], guard: SeriesGuard, readonly buckets = DEFAULT_BUCKETS) {
    super(name, help, labelNames, guard);
  }

  protected initial(): HistogramValue {
    return { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
  }

  observe(labels: Labels<L>, value: number): void {
    const entry = this.entry(labels);
    if (!entry) return;
    this.buckets.forEach((bound, index) => {
      if (value <= bound) entry.value.counts[index]!++;
    });
    entry.value.sum += value;
    entry.value.count++;
  }

  samples() {
    return [...this.series.values()].flatMap(({ labels, value }) => [
      ...this.buckets.map(
        (bound, index) => `${this.name}_bucket${formatLabels([...labels, ["le", String(bound)]])} ${value.counts[index]}`,
      ),
      `${this.name}_bucket${formatLabels([...labels, ["le", "+Inf"]])} ${value.count}`,
      `${this.name}_sum${formatLabels(labels)} ${value.sum}`,
      `${this.name}_count${formatLabels(labels)} ${value.count}`,
    ]);
  }
}

/** A set of metrics rendered together in the Prometheus text format 0.0.4. */
export class Registry {
  private readonly metrics = new Map<string, Metric<unknown>>();

  constructor(private readonly guard: SeriesGuard) {}

  counter<L extends string = never>(name: string, help: string, labelNames: readonly L[] = []): Counter<L> {
    return this.add(new Counter<L>(name, help, labelNames, this.guard));
  }

  gauge<L extends string = never>(name: string, help: string, labelNames: readonly L[] = []): Gauge<L> {
    return this.add(new Gauge<L>(name, help, labelNames, this.guard));
  }

  histogram<L extends string = never>(name: string, help: string, labelNames: readonly L[] = [], buckets?: number[]): Histogram<L> {
    return this.add(new Histogram<L>(name, help, labelNames, this.guard, buckets));
  }

  render(): string {
    return [...this.metrics.values()].map((metric) => metric.render()).join("\n") + "\n";
  }

  private add<M extends Metric<any>>(metric: M): M {
    if (this.metrics.has(metric.name)) throw new Error(`Metric "${metric.name}" is already registered`);
    this.metrics.set(metric.name, metric);
    return metric;
  }
}
