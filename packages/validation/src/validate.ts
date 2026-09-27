import { BadRequestError, ValidationError, type Context, type Handler, type HandlerResult } from "@bun-hydrate/core";
import type { Schema } from "./schema";
import type { StandardSchemaV1 } from "./standard-schema";

export type RequestSource = "params" | "query" | "headers" | "body";
export type ValidationSources = Partial<Record<RequestSource, StandardSchemaV1>>;

export type ValidatedInput<S extends ValidationSources> = {
  [K in keyof S]: S[K] extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S[K]> : never;
};

export interface ValidationDetail {
  location?: RequestSource;
  path: string;
  message: string;
}

/**
 * Wraps a handler so it receives typed, validated input. All sources are checked and every
 * issue is reported at once as a 422 (spec-4 §2.3).
 */
export function validate<const S extends ValidationSources, Params = Record<string, string>>(
  sources: S,
  handler: (ctx: Context<Params>, input: ValidatedInput<S>) => HandlerResult | Promise<HandlerResult>,
): Handler<Params> {
  return async (ctx) => {
    const input: Record<string, unknown> = {};
    const details: ValidationDetail[] = [];

    for (const [location, sourceSchema] of Object.entries(sources) as [RequestSource, StandardSchemaV1][]) {
      const result = await sourceSchema["~standard"].validate(await readSource(ctx, location));
      if (result.issues) {
        details.push(...result.issues.map((issue) => ({ location, path: formatPath(issue.path), message: issue.message })));
      } else {
        input[location] = result.value;
      }
    }

    if (details.length > 0) throw new ValidationError("Invalid request", { details });
    return handler(ctx, input as ValidatedInput<S>);
  };
}

/** Validates any value with a built-in schema, throwing a ValidationError on failure. */
export function parse<Output>(target: Schema<Output>, value: unknown): Output {
  const result = target["~standard"].validate(value) as StandardSchemaV1.Result<Output>;
  if (result.issues) {
    throw new ValidationError("Invalid value", {
      details: result.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
    });
  }
  return result.value;
}

async function readSource(ctx: Context<unknown>, location: RequestSource): Promise<unknown> {
  switch (location) {
    case "params":
      return ctx.params;
    case "query":
      return searchParamsToObject(ctx.query);
    case "headers":
      return Object.fromEntries(ctx.headers);
    case "body":
      return readJsonBody(ctx);
  }
}

/** An empty body becomes `undefined`, so a missing body reads as "Required" rather than malformed JSON. */
async function readJsonBody(ctx: Context<unknown>): Promise<unknown> {
  const text = await ctx.body.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError("Request body is not valid JSON", { code: "INVALID_JSON" });
  }
}

function searchParamsToObject(query: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    result[key] = values.length === 1 ? values[0]! : values;
  }
  return result;
}

function formatPath(path: StandardSchemaV1.Issue["path"]): string {
  return (path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".");
}
