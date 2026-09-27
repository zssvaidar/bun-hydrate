import type { StandardSchemaV1 } from "./standard-schema";

export interface Issue {
  message: string;
  path: PropertyKey[];
}

/** Returned by `run` when the value is invalid; the reasons are in `issues`. */
const INVALID: unique symbol = Symbol("invalid");
type Invalid = typeof INVALID;

interface Rule<T> {
  test: (value: T) => boolean;
  message: string;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function fail(issues: Issue[], path: PropertyKey[], message: string): Invalid {
  issues.push({ message, path });
  return INVALID;
}

/** Only the first failing rule is reported per value: one clear message beats a list of related ones. */
function applyRules<T>(value: T, rules: readonly Rule<T>[], path: PropertyKey[], issues: Issue[]): T | Invalid {
  const broken = rules.find((rule) => !rule.test(value));
  return broken ? fail(issues, path, broken.message) : value;
}

export abstract class Schema<Output> implements StandardSchemaV1<unknown, Output> {
  readonly "~standard": StandardSchemaV1.Props<unknown, Output> = {
    version: 1,
    vendor: "bun-hydrate",
    validate: (value) => {
      const issues: Issue[] = [];
      const output = this.run(value, [], issues);
      return output === INVALID ? { issues } : { value: output };
    },
  };

  /** @internal Validates `value` at `path`, pushing problems into `issues`. */
  run(value: unknown, path: PropertyKey[], issues: Issue[]): Output | Invalid {
    if (value === undefined) return fail(issues, path, "Required");
    return this.check(value, path, issues);
  }

  protected abstract check(value: unknown, path: PropertyKey[], issues: Issue[]): Output | Invalid;

  optional(): Schema<Output | undefined> {
    return new Wrapped<Output | undefined>((value, path, issues) =>
      value === undefined ? undefined : this.run(value, path, issues),
    );
  }

  nullable(): Schema<Output | null> {
    return new Wrapped<Output | null>((value, path, issues) => (value === null ? null : this.run(value, path, issues)));
  }

  default(fallback: Exclude<Output, undefined>): Schema<Exclude<Output, undefined>> {
    return new Wrapped((value, path, issues) =>
      value === undefined ? fallback : (this.run(value, path, issues) as Exclude<Output, undefined> | Invalid),
    );
  }

  refine(predicate: (value: Output) => boolean, message: string): Schema<Output> {
    return new Wrapped<Output>((value, path, issues) => {
      const output = this.run(value, path, issues);
      return output === INVALID || predicate(output) ? output : fail(issues, path, message);
    });
  }
}

type Runner<Output> = (value: unknown, path: PropertyKey[], issues: Issue[]) => Output | Invalid;

/** A schema defined by a function; used for modifiers, which also decide how `undefined` is treated. */
class Wrapped<Output> extends Schema<Output> {
  constructor(private readonly runner: Runner<Output>) {
    super();
  }

  override run(value: unknown, path: PropertyKey[], issues: Issue[]): Output | Invalid {
    return this.runner(value, path, issues);
  }

  protected check(value: unknown, path: PropertyKey[], issues: Issue[]): Output | Invalid {
    return this.runner(value, path, issues);
  }
}

export class StringSchema extends Schema<string> {
  constructor(
    private readonly rules: readonly Rule<string>[] = [],
    private readonly trimmed = false,
  ) {
    super();
  }

  min(length: number, message = `Must be at least ${plural(length, "character")}`) {
    return this.with({ test: (value) => value.length >= length, message });
  }

  max(length: number, message = `Must be at most ${plural(length, "character")}`) {
    return this.with({ test: (value) => value.length <= length, message });
  }

  length(length: number, message = `Must be exactly ${plural(length, "character")}`) {
    return this.with({ test: (value) => value.length === length, message });
  }

  nonEmpty(message = "Must not be empty") {
    return this.with({ test: (value) => value.length > 0, message });
  }

  regex(pattern: RegExp, message = "Has an invalid format") {
    return this.with({ test: (value) => pattern.test(value), message });
  }

  /** Removes surrounding whitespace before the other rules run. */
  trim() {
    return new StringSchema(this.rules, true);
  }

  private with(rule: Rule<string>) {
    return new StringSchema([...this.rules, rule], this.trimmed);
  }

  protected check(value: unknown, path: PropertyKey[], issues: Issue[]) {
    if (typeof value !== "string") return fail(issues, path, "Expected a string");
    return applyRules(this.trimmed ? value.trim() : value, this.rules, path, issues);
  }
}

export class NumberSchema extends Schema<number> {
  constructor(
    private readonly rules: readonly Rule<number>[] = [],
    private readonly coerce = false,
  ) {
    super();
  }

  int(message = "Must be an integer") {
    return this.with({ test: Number.isInteger, message });
  }

  min(minimum: number, message = `Must be at least ${minimum}`) {
    return this.with({ test: (value) => value >= minimum, message });
  }

  max(maximum: number, message = `Must be at most ${maximum}`) {
    return this.with({ test: (value) => value <= maximum, message });
  }

  positive(message = "Must be positive") {
    return this.with({ test: (value) => value > 0, message });
  }

  private with(rule: Rule<number>) {
    return new NumberSchema([...this.rules, rule], this.coerce);
  }

  protected check(value: unknown, path: PropertyKey[], issues: Issue[]) {
    const number = this.coerce && typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) return fail(issues, path, "Expected a number");
    return applyRules(number, this.rules, path, issues);
  }
}

const TRUE_STRINGS = new Set(["true", "1"]);
const FALSE_STRINGS = new Set(["false", "0"]);

export class BooleanSchema extends Schema<boolean> {
  constructor(private readonly coerce = false) {
    super();
  }

  protected check(value: unknown, path: PropertyKey[], issues: Issue[]) {
    if (typeof value === "boolean") return value;
    if (this.coerce && typeof value === "string") {
      if (TRUE_STRINGS.has(value)) return true;
      if (FALSE_STRINGS.has(value)) return false;
    }
    return fail(issues, path, "Expected a boolean");
  }
}

export class LiteralSchema<const Value extends string | number | boolean> extends Schema<Value> {
  constructor(private readonly expected: Value) {
    super();
  }

  protected check(value: unknown, path: PropertyKey[], issues: Issue[]) {
    return value === this.expected ? this.expected : fail(issues, path, `Expected ${JSON.stringify(this.expected)}`);
  }
}

export class EnumSchema<const Values extends readonly string[]> extends Schema<Values[number]> {
  constructor(readonly values: Values) {
    super();
  }

  protected check(value: unknown, path: PropertyKey[], issues: Issue[]) {
    return this.values.includes(value as string)
      ? (value as Values[number])
      : fail(issues, path, `Expected one of: ${this.values.join(", ")}`);
  }
}

export class ArraySchema<Item> extends Schema<Item[]> {
  constructor(
    private readonly item: Schema<Item>,
    private readonly rules: readonly Rule<Item[]>[] = [],
  ) {
    super();
  }

  min(count: number, message = `Must have at least ${plural(count, "item")}`) {
    return new ArraySchema(this.item, [...this.rules, { test: (value) => value.length >= count, message }]);
  }

  max(count: number, message = `Must have at most ${plural(count, "item")}`) {
    return new ArraySchema(this.item, [...this.rules, { test: (value) => value.length <= count, message }]);
  }

  protected check(value: unknown, path: PropertyKey[], issues: Issue[]) {
    if (!Array.isArray(value)) return fail(issues, path, "Expected an array");

    let valid = true;
    const items = value.map((element, index) => {
      const output = this.item.run(element, [...path, index], issues);
      if (output === INVALID) valid = false;
      return output as Item;
    });
    // The array's own rules are checked even when an item failed, so every problem is reported at once.
    const checked = applyRules(items, this.rules, path, issues);
    return valid ? checked : INVALID;
  }
}

export type Shape = Record<string, Schema<unknown>>;
type OutputOf<S> = S extends Schema<infer Output> ? Output : never;
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends OutputOf<S[K]> ? K : never }[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOutput<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: OutputOf<S[K]> } & { [K in OptionalKeys<S>]?: OutputOf<S[K]> }
>;

export class ObjectSchema<S extends Shape> extends Schema<ObjectOutput<S>> {
  constructor(
    readonly shape: S,
    private readonly rejectUnknown = false,
  ) {
    super();
  }

  /** Reject keys that are not in the shape instead of dropping them. */
  strict() {
    return new ObjectSchema(this.shape, true);
  }

  protected check(value: unknown, path: PropertyKey[], issues: Issue[]) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(issues, path, "Expected an object");
    }
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    let valid = true;

    for (const [key, fieldSchema] of Object.entries(this.shape)) {
      const field = fieldSchema.run(input[key], [...path, key], issues);
      if (field === INVALID) valid = false;
      else if (field !== undefined) output[key] = field;
    }
    if (this.rejectUnknown) {
      for (const key of Object.keys(input)) {
        if (key in this.shape) continue;
        fail(issues, [...path, key], "Unknown field");
        valid = false;
      }
    }
    return valid ? (output as ObjectOutput<S>) : INVALID;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const schema = {
  string: () => new StringSchema(),
  email: (message = "Must be a valid email address") => new StringSchema().regex(EMAIL, message),
  url: (message = "Must be a valid URL") =>
    new StringSchema([{ test: (value) => URL.canParse(value), message }]),
  uuid: (message = "Must be a valid UUID") => new StringSchema().regex(UUID, message),
  number: () => new NumberSchema(),
  boolean: () => new BooleanSchema(),
  literal: <const Value extends string | number | boolean>(value: Value) => new LiteralSchema(value),
  enum: <const Values extends readonly string[]>(values: Values) => new EnumSchema(values),
  array: <Item>(item: Schema<Item>) => new ArraySchema(item),
  object: <S extends Shape>(shape: S) => new ObjectSchema(shape),
  /** Accept strings too, as found in query strings, params and headers. */
  coerce: {
    number: () => new NumberSchema([], true),
    integer: () => new NumberSchema([], true).int(),
    boolean: () => new BooleanSchema(true),
  },
};

export type Infer<T extends StandardSchemaV1> = StandardSchemaV1.InferOutput<T>;
