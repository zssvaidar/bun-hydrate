import { Context } from "./context";
import { HttpError, MethodNotAllowedError, NotFoundError, toHttpError } from "./errors";
import { createLogger, type Logger } from "./logger";
import { compose } from "./middleware";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id";
import { toResponse, withHeader, withoutBody } from "./response";
import { RouteTrie, type MatchResult } from "./route-trie";
import { Router } from "./router";

export interface AppOptions {
  logger?: Logger;
  /** Include original messages and stack traces of 5xx errors in responses. Default: NODE_ENV is "development". */
  exposeErrors?: boolean;
  /** Log one line per request. Default: true. */
  logRequests?: boolean;
  /** Register /health and /ready. Default: true. */
  health?: boolean;
}

export type ErrorHandler = (
  error: unknown,
  ctx: Context,
) => Response | undefined | Promise<Response | undefined>;

type RouteRunner = (ctx: Context) => Promise<Response>;
type Dispatch = MatchResult<RouteRunner> | { kind: "error"; error: unknown };

export class App extends Router {
  readonly logger: Logger;
  private readonly exposeErrors: boolean;
  private readonly logRequests: boolean;
  private errorHandler: ErrorHandler | undefined;
  private compiled: { revision: number; table: RouteTrie<RouteRunner> } | undefined;

  constructor(options: AppOptions = {}) {
    super();
    this.logger = options.logger ?? createLogger();
    this.exposeErrors = options.exposeErrors ?? process.env.NODE_ENV === "development";
    this.logRequests = options.logRequests ?? true;
  }

  onError(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  /** The web-standard entry point: `Bun.serve({ fetch: app.fetch })`, and what the test client calls. */
  readonly fetch = async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const dispatch = this.match(request);
    const ctx = new Context(request, {
      params: dispatch.kind === "found" ? dispatch.params : {},
      requestId,
      log: this.logger.child({ requestId }),
    });

    let response = await compose(this.ownMiddleware, () => this.run(dispatch, ctx), this.handleError)(ctx);

    if (request.method === "HEAD") response = withoutBody(response);
    response = withHeader(response, REQUEST_ID_HEADER, requestId);
    if (this.logRequests) this.logRequest(ctx, response, startedAt);
    return response;
  };

  private match(request: Request): Dispatch {
    try {
      return this.routeTable().match(request.method, new URL(request.url).pathname);
    } catch (error) {
      return { kind: "error", error };
    }
  }

  private async run(dispatch: Dispatch, ctx: Context): Promise<Response> {
    switch (dispatch.kind) {
      case "found":
        return dispatch.value(ctx);
      case "method-not-allowed":
        if (ctx.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: { allow: dispatch.allowed.join(", ") } });
        }
        throw new MethodNotAllowedError(dispatch.allowed);
      case "not-found":
        throw new NotFoundError();
      case "error":
        throw dispatch.error;
    }
  }

  private routeTable(): RouteTrie<RouteRunner> {
    if (this.compiled?.revision !== this.revision) {
      const table = new RouteTrie<RouteRunner>();
      for (const route of this.collectRoutes()) {
        const runHandler = async (ctx: Context) => toResponse(await route.handler(ctx), ctx);
        table.add(route.method, route.path, compose(route.middleware, runHandler, this.handleError));
      }
      this.compiled = { revision: this.revision, table };
    }
    return this.compiled.table;
  }

  private readonly handleError = async (error: unknown, ctx: Context): Promise<Response> => {
    if (this.errorHandler) {
      try {
        const custom = await this.errorHandler(error, ctx);
        if (custom) return custom;
      } catch (handlerError) {
        ctx.log.error("onError handler threw", { error: handlerError });
      }
    }

    const httpError = toHttpError(error);
    if (httpError.status >= 500) {
      ctx.log.error("Request failed", { method: ctx.method, path: ctx.path, error });
    }
    return this.errorResponse(httpError, error, ctx.requestId);
  };

  private errorResponse(httpError: HttpError, original: unknown, requestId: string): Response {
    const debug = this.exposeErrors && !httpError.expose;
    const source = original instanceof Error ? original : httpError;

    const body = {
      error: {
        code: httpError.code,
        message: httpError.expose ? httpError.message : debug ? source.message : "Internal Server Error",
        requestId,
        ...(httpError.details === undefined ? {} : { details: httpError.details }),
        ...(debug ? { stack: source.stack } : {}),
      },
    };

    const headers = new Headers(httpError.headers);
    headers.set("content-type", "application/json;charset=utf-8");
    return new Response(JSON.stringify(body), { status: httpError.status, headers });
  }

  private logRequest(ctx: Context, response: Response, startedAt: number): void {
    const fields = {
      method: ctx.method,
      path: ctx.path,
      status: response.status,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
    if (response.status >= 500) ctx.log.warn("request completed", fields);
    else ctx.log.info("request completed", fields);
  }
}
