import { readFileSync } from "node:fs";

export type EnvSource = Record<string, string | undefined>;

type ParseResult<T> = { ok: true; value: T } | { ok: false; expected: string };
type Parser<T> = (raw: string) => ParseResult<T>;

/** A single environment variable declaration. Required unless `.default()` or `.optional()` is used. */
export class EnvVar<T> {
  constructor(
    readonly key: string,
    private readonly parse: Parser<T>,
    private readonly fallback: { kind: "required" } | { kind: "default"; value: T } | { kind: "optional" } = {
      kind: "required",
    },
  ) {}

  default(value: T): EnvVar<T> {
    return new EnvVar(this.key, this.parse, { kind: "default", value });
  }

  optional(): EnvVar<T | undefined> {
    return new EnvVar<T | undefined>(this.key, this.parse, { kind: "optional" });
  }

  /** @internal */
  resolve(raw: string | undefined): ParseResult<T> | { ok: false; missing: true } {
    if (raw === undefined || raw === "") {
      if (this.fallback.kind === "default") return { ok: true, value: this.fallback.value };
      if (this.fallback.kind === "optional") return { ok: true, value: undefined as T };
      return { ok: false, missing: true };
    }
    return this.parse(raw);
  }
}

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (expected: string): ParseResult<never> => ({ ok: false, expected });

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

export const env = {
  string: (key: string) => new EnvVar(key, (raw) => ok(raw)),

  number: (key: string) =>
    new EnvVar(key, (raw) => {
      const value = Number(raw);
      return Number.isFinite(value) ? ok(value) : fail("a number");
    }),

  integer: (key: string) =>
    new EnvVar(key, (raw) => {
      const value = Number(raw);
      return Number.isInteger(value) ? ok(value) : fail("an integer");
    }),

  port: (key: string) =>
    new EnvVar(key, (raw) => {
      const value = Number(raw);
      return Number.isInteger(value) && value >= 0 && value <= 65535 ? ok(value) : fail("a port number (0-65535)");
    }),

  boolean: (key: string) =>
    new EnvVar(key, (raw) => {
      const normalized = raw.trim().toLowerCase();
      if (TRUE_VALUES.has(normalized)) return ok(true);
      if (FALSE_VALUES.has(normalized)) return ok(false);
      return fail("a boolean (true/false/1/0/yes/no)");
    }),

  enum: <const Values extends readonly string[]>(key: string, values: Values) =>
    new EnvVar<Values[number]>(key, (raw) =>
      values.includes(raw) ? ok(raw as Values[number]) : fail(`one of ${values.join(", ")}`),
    ),

  url: (key: string) =>
    new EnvVar(key, (raw) => (URL.canParse(raw) ? ok(raw) : fail("a URL"))),
};

export interface ConfigIssue {
  key: string;
  problem: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.key}: ${issue.problem}`);
    super(["Invalid configuration:", ...lines, "Set these in .env or the process environment."].join("\n"));
    this.name = "ConfigError";
  }
}

type ConfigShape = Record<string, EnvVar<unknown>>;
export type InferConfig<Shape extends ConfigShape> = {
  readonly [K in keyof Shape]: Shape[K] extends EnvVar<infer T> ? T : never;
};

/**
 * Reads and validates every declared variable, throwing one ConfigError that lists all problems,
 * so a misconfigured deploy fails at startup rather than on the first request that needs a value.
 */
export function defineConfig<Shape extends ConfigShape>(
  shape: Shape,
  source: EnvSource = process.env,
): InferConfig<Shape> {
  const config: Record<string, unknown> = {};
  const issues: ConfigIssue[] = [];

  for (const [name, variable] of Object.entries(shape)) {
    const raw = readRaw(variable.key, source);
    if ("problem" in raw) {
      issues.push({ key: variable.key, problem: raw.problem });
      continue;
    }

    const result = variable.resolve(raw.value);
    if (result.ok) {
      config[name] = result.value;
    } else if ("missing" in result) {
      issues.push({ key: variable.key, problem: `required but not set${caseMismatchHint(variable.key, source)}` });
    } else {
      // Values read from secret files are never echoed back into logs or errors.
      const received = raw.fromFile ? `read from ${variable.key}_FILE` : `received ${JSON.stringify(raw.value)}`;
      issues.push({ key: variable.key, problem: `expected ${result.expected}, ${received}` });
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return Object.freeze(config) as InferConfig<Shape>;
}

/**
 * `NAME` directly, or the contents of the file named by `NAME_FILE` — how Docker and Kubernetes
 * mount secrets (spec-5 §1.6). Setting both is ambiguous, so it is an error.
 */
function readRaw(
  key: string,
  source: EnvSource,
): { value: string | undefined; fromFile: boolean } | { problem: string } {
  const direct = source[key];
  const filePath = source[`${key}_FILE`];
  if (!filePath) return { value: direct, fromFile: false };
  if (direct) return { problem: `set either ${key} or ${key}_FILE, not both` };

  try {
    return { value: readFileSync(filePath, "utf8").replace(/\r?\n$/, ""), fromFile: true };
  } catch {
    return { problem: `cannot read ${key}_FILE "${filePath}"` };
  }
}

function caseMismatchHint(key: string, source: EnvSource): string {
  const lower = key.toLowerCase();
  const found = Object.keys(source).find((candidate) => candidate !== key && candidate.toLowerCase() === lower);
  return found ? ` (found "${found}" — environment variable names are case-sensitive)` : "";
}
