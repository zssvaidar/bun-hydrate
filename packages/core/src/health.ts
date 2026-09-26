import type { Context } from "./context";
import type { LifecycleState, ReadinessCheck } from "./lifecycle";
import type { Logger } from "./logger";

export interface RegisteredCheck {
  name: string;
  check: ReadinessCheck;
  timeoutMs: number;
}

type CheckOutcome = "ok" | "fail" | "timeout";

export function healthHandler(startedAt: number) {
  return () => ({ status: "ok", uptime: Math.floor((Date.now() - startedAt) / 1000) });
}

/**
 * Ready means: the app is running and every dependency check passes in time.
 * Failure details go to the log only; the endpoint is usually public.
 */
export function readyHandler(getState: () => LifecycleState, checks: readonly RegisteredCheck[], logger: Logger) {
  return async (ctx: Context<unknown>) => {
    const state = getState();
    const results: Record<string, CheckOutcome> = {};

    if (state === "running") {
      const outcomes = await Promise.all(checks.map((entry) => runCheck(entry, logger)));
      checks.forEach((entry, index) => (results[entry.name] = outcomes[index]!));
    }

    const ready = state === "running" && Object.values(results).every((outcome) => outcome === "ok");
    return ctx.json({ status: ready ? "ready" : "not_ready", state, checks: results }, ready ? 200 : 503);
  };
}

async function runCheck({ name, check, timeoutMs }: RegisteredCheck, logger: Logger): Promise<CheckOutcome> {
  let timer: Timer | undefined;
  const timeout = new Promise<CheckOutcome>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const attempt = (async (): Promise<CheckOutcome> => ((await check()) ? "ok" : "fail"))().catch((error) => {
    logger.warn("Readiness check failed", { check: name, error });
    return "fail" as const;
  });

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
