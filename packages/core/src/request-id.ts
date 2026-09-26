export const REQUEST_ID_HEADER = "x-request-id";

// Restrictive on purpose: the ID is written into logs and response headers verbatim.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reuses an upstream request ID when it is safe to, so one ID follows a request across services. */
export function resolveRequestId(incoming: string | null): string {
  return incoming !== null && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
}
