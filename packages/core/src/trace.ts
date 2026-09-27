import type { Context } from "./context";
import { REQUEST_ID_HEADER } from "./request-id";

export interface TraceParent {
  traceId: string;
  parentId: string;
  flags: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO = /^0+$/;

/** Parses a W3C `traceparent` header (https://www.w3.org/TR/trace-context/). Invalid input → undefined. */
export function parseTraceparent(header: string | null): TraceParent | undefined {
  const match = header ? TRACEPARENT.exec(header.trim()) : null;
  if (!match) return undefined;
  const [, version, traceId, parentId, flags] = match as unknown as [string, string, string, string, string];
  if (version === "ff" || ALL_ZERO.test(traceId) || ALL_ZERO.test(parentId)) return undefined;
  return { traceId, parentId, flags };
}

export function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

/**
 * Headers to send on outgoing calls, so the next service continues this trace and request ID
 * (spec-5 §1.4). Spans are not exported; this is correlation, not an OpenTelemetry SDK.
 */
export function propagationHeaders(ctx: Context<unknown>): Record<string, string> {
  return {
    traceparent: `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`,
    [REQUEST_ID_HEADER]: ctx.requestId,
  };
}
