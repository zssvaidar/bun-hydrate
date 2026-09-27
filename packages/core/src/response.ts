import type { Context } from "./context";

// `void` lets handlers that only have side effects (and return nothing) type-check.
export type HandlerResult = Response | string | object | null | undefined | void;

/** Turns whatever a handler returned into a Response (spec-3 §2.2). */
export function toResponse(result: HandlerResult, ctx: Context<unknown>): Response {
  if (result instanceof Response) return result;
  if (result === null || result === undefined) return ctx.empty();
  if (typeof result === "string") return ctx.text(result);
  return ctx.json(result);
}

/**
 * Sets a header even on responses with immutable headers (e.g. `Response.redirect()`),
 * copying the response only when it has to.
 */
export function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
}

/** Like withHeader, but appends (for headers that repeat, such as Set-Cookie). */
export function appendHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.append(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.append(name, value);
    return copy;
  }
}

export function withoutBody(response: Response): Response {
  if (response.body === null) return response;
  void response.body.cancel();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}
