const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** A duration such as "30s", "15m", "1h" or "7d", or a number of milliseconds. */
export type Duration = `${number}${Unit}` | number;

/** Parses a duration to milliseconds; invalid input throws so misconfiguration fails at startup. */
export function parseDuration(input: Duration | string): number {
  let ms = Number.NaN;
  if (typeof input === "number") {
    ms = input;
  } else {
    const match = DURATION.exec(input.trim());
    if (match) ms = Number(match[1]) * UNIT_MS[match[2] as Unit];
  }

  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`Invalid duration "${input}": use a positive number with ms, s, m, h or d (e.g. "15m")`);
  }
  return ms;
}
