import type { SQL } from "bun";

export interface QueryEvent {
  /** select | insert | update | delete | other — low-cardinality, safe as a metric label. */
  operation: string;
  durationMs: number;
  failed: boolean;
}

export type QueryObserver = (event: QueryEvent) => void;

const OPERATIONS = new Set(["select", "insert", "update", "delete"]);

export function operationOf(text: string): string {
  const keyword = text.trimStart().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return OPERATIONS.has(keyword) ? keyword : "other";
}

function isTemplateCall(args: unknown[]): args is [TemplateStringsArray, ...unknown[]] {
  return Array.isArray(args[0]) && "raw" in (args[0] as object);
}

/**
 * Bun queries are lazy: they run when `.then()` is first called. Wrapping `then` therefore times
 * exactly the execution, and `.values()`, `.catch()` and friends keep working (spec-5 D4).
 */
function timed<Q extends PromiseLike<unknown>>(query: Q, operation: string, observe: QueryObserver): Q {
  const originalThen = query.then;
  let startedAt: number | undefined;
  let reported = false;
  const report = (failed: boolean) => {
    if (reported) return;
    reported = true;
    observe({ operation, durationMs: performance.now() - (startedAt ?? performance.now()), failed });
  };

  Object.defineProperty(query, "then", {
    configurable: true,
    writable: true,
    value(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      startedAt ??= performance.now();
      return originalThen.call(
        query,
        (value) => {
          report(false);
          return onFulfilled ? onFulfilled(value) : value;
        },
        (error) => {
          report(true);
          if (onRejected) return onRejected(error);
          throw error;
        },
      );
    },
  });
  return query;
}

/** A view of `sql` whose queries report to `observe`; everything else passes through unchanged. */
export function instrumentSql(sql: SQL, observe: QueryObserver): SQL {
  return new Proxy(sql, {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      // sql`…` is a query; sql(object) and sql(identifier) are helpers and are left alone.
      return isTemplateCall(args) ? timed(result as PromiseLike<unknown>, operationOf(args[0][0] ?? ""), observe) : result;
    },
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "unsafe" && typeof value === "function") {
        return (text: string, ...rest: unknown[]) => timed(value.call(target, text, ...rest), operationOf(text), observe);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
