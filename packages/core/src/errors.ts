export interface HttpErrorOptions {
  code?: string;
  details?: unknown;
  cause?: unknown;
  headers?: HeadersInit;
}

const DEFAULT_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "VALIDATION_FAILED",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

function defaultCode(status: number): string {
  return DEFAULT_CODES[status] ?? (status >= 500 ? "INTERNAL_SERVER_ERROR" : "HTTP_ERROR");
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: HeadersInit;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = options.code ?? defaultCode(status);
    this.details = options.details;
    this.headers = options.headers;
  }

  /** Client errors describe the client's mistake, so their message is safe to return. */
  get expose(): boolean {
    return this.status < 500;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad Request", options?: HttpErrorOptions) {
    super(400, message, options);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized", options?: HttpErrorOptions) {
    super(401, message, options);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden", options?: HttpErrorOptions) {
    super(403, message, options);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not Found", options?: HttpErrorOptions) {
    super(404, message, options);
  }
}

export class MethodNotAllowedError extends HttpError {
  constructor(allowed: readonly string[], options?: Omit<HttpErrorOptions, "headers">) {
    super(405, "Method Not Allowed", { ...options, headers: { allow: allowed.join(", ") } });
  }
}

export class ConflictError extends HttpError {
  constructor(message = "Conflict", options?: HttpErrorOptions) {
    super(409, message, options);
  }
}

export class ValidationError extends HttpError {
  constructor(message = "Validation failed", options?: HttpErrorOptions) {
    super(422, message, options);
  }
}

export class TooManyRequestsError extends HttpError {
  /** `retryAfter` is in seconds and becomes the Retry-After header. */
  constructor(message = "Too Many Requests", options: HttpErrorOptions & { retryAfter?: number } = {}) {
    const { retryAfter, ...rest } = options;
    const headers = new Headers(rest.headers);
    if (retryAfter !== undefined) headers.set("retry-after", String(Math.max(0, Math.ceil(retryAfter))));
    super(429, message, { ...rest, headers });
  }
}

export class InternalServerError extends HttpError {
  constructor(message = "Internal Server Error", options?: HttpErrorOptions) {
    super(500, message, options);
  }
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new InternalServerError(undefined, { cause: error });
}
