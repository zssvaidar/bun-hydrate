import type { Server } from "bun";
import { ipMatcher, resolveClient, type TrustProxy } from "./client-ip";
import { Context } from "./context";
import { HttpError, MethodNotAllowedError, NotFoundError, toHttpError } from "./errors";
import { healthHandler, readyHandler, type RegisteredCheck } from "./health";
import {
  Lifecycle,
  type LifecycleState,
  type ListenOptions,
  type ReadinessCheck,
  type ReadinessCheckOptions,
  type StartHook,
  type StopHook,
  type StopOptions,
} from "./lifecycle";
import { createLogger, type Logger } from "./logger";
import { compose } from "./middleware";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id";
import { appendHeader, toResponse, withHeader, withoutBody } from "./response";
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
  /** Which proxies may report the client address and protocol (spec-5 §1.1). Default: false. */
  trustProxy?: TrustProxy;
}

/** What `fetch` needs from Bun's server: the socket address of the peer. */
export interface PeerSource {
  requestIP(request: Request): { address: string } | null;
}

export type ErrorHandler = (
  error: unknown,
  ctx: Context,
) => Response | undefined | Promise<Response | undefined>;

interface CompiledRoute {
  pattern: string;
  run: (ctx: Context) => Promise<Response>;
}
type Dispatch = MatchResult<CompiledRoute> | { kind: "error"; error: unknown };

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export class App extends Router {
  readonly logger: Logger;
  /** The running Bun server, once `listen()` has bound it. */
  server: Server<undefined> | undefined;

  private readonly exposeErrors: boolean;
  private readonly logRequests: boolean;
  private readonly lifecycle: Lifecycle;
  private readonly readinessChecks: RegisteredCheck[] = [];
  private errorHandler: ErrorHandler | undefined;
  private compiled: { revision: number; table: RouteTrie<CompiledRoute> } | undefined;
  private readonly trustProxy: TrustProxy;
  private readonly isTrustedProxy: ((address: string) => boolean) | undefined;
  private stopping: Promise<void> | undefined;
  private readonly onSignal = () => void this.stop();

  constructor(options: AppOptions = {}) {
    super();
    this.logger = options.logger ?? createLogger();
    this.exposeErrors = options.exposeErrors ?? process.env.NODE_ENV === "development";
    this.logRequests = options.logRequests ?? true;
    this.lifecycle = new Lifecycle(this.logger);
    this.trustProxy = options.trustProxy ?? false;
    this.isTrustedProxy = Array.isArray(this.trustProxy) ? ipMatcher(this.trustProxy) : undefined;

    if (options.health ?? true) {
      this.get("/health", healthHandler(Date.now()));
      this.get("/ready", readyHandler(() => this.state, this.readinessChecks, this.logger));
    }
  }

  get state(): LifecycleState {
    return this.lifecycle.state;
  }

  onError(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  onStart(hook: StartHook): this {
    this.lifecycle.onStart(hook);
    return this;
  }

  onStop(hook: StopHook): this {
    this.lifecycle.onStop(hook);
    return this;
  }

  /** A dependency that must be healthy for `/ready` to report ready. */
  readinessCheck(name: string, check: ReadinessCheck, options: ReadinessCheckOptions = {}): this {
    this.readinessChecks.push({ name, check, timeoutMs: options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS });
    return this;
  }

  /** Runs start hooks, then binds the server. Rejects (after cleaning up) if any step fails. */
  async listen(options: ListenOptions = {}): Promise<Server<undefined>> {
    if (this.state !== "created") throw new Error(`App is already ${this.state}; listen() can only be called once`);

    await this.lifecycle.start();
    try {
      this.server = Bun.serve({
        port: options.port ?? 3000,
        hostname: options.hostname ?? "0.0.0.0",
        fetch: this.fetch,
      });
    } catch (error) {
      await this.lifecycle.runShutdownHooks();
      this.lifecycle.state = "stopped";
      throw error;
    }

    this.lifecycle.state = "running";
    if (options.handleSignals ?? true) {
      for (const signal of SHUTDOWN_SIGNALS) process.on(signal, this.onSignal);
    }
    this.logger.info("Server listening", { url: this.server.url.href });
    return this.server;
  }

  /** Graceful shutdown (spec-3 §7). Safe to call more than once; every call returns the same promise. */
  stop(options: StopOptions = {}): Promise<void> {
    this.stopping ??= this.shutdown(options.timeoutMs ?? 10_000);
    return this.stopping;
  }

  private async shutdown(timeoutMs: number): Promise<void> {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, this.onSignal);
    if (this.state === "created" || this.state === "stopped") {
      this.lifecycle.state = "stopped";
      return;
    }

    this.lifecycle.state = "stopping";
    this.logger.info("Shutting down");

    if (this.server) {
      let timer: Timer | undefined;
      const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
      const finishedInTime = await Promise.race([this.server.stop().then(() => true), timedOut]);
      // A pending timer would keep the process alive after shutdown.
      clearTimeout(timer);
      if (!finishedInTime) {
        this.logger.warn("Shutdown timeout reached; closing remaining connections", { timeoutMs });
        // Not awaited: it only settles once every handler returns, and a hung handler never will.
        void this.server.stop(true);
      }
    }

    await this.lifecycle.runShutdownHooks();
    this.lifecycle.state = "stopped";
    this.logger.info("Stopped");
  }

  /**
   * The web-standard entry point: `Bun.serve({ fetch: app.fetch })`, and what the test client calls.
   * `server` supplies the socket address; in-process callers may omit it or pass a stand-in.
   */
  readonly fetch = async (request: Request, server?: PeerSource): Promise<Response> => {
    const startedAt = performance.now();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const dispatch = this.match(request);
    const client = resolveClient(request, server?.requestIP(request)?.address, this.trustProxy, this.isTrustedProxy);
    const ctx = new Context(request, {
      params: dispatch.kind === "found" ? dispatch.params : {},
      route: dispatch.kind === "found" ? dispatch.value.pattern : undefined,
      requestId,
      log: this.logger.child({ requestId }),
      ...client,
    });

    let response = await compose(this.ownMiddleware, () => this.run(dispatch, ctx), this.handleError)(ctx);

    for (const cookie of ctx.cookies.changes()) response = appendHeader(response, "set-cookie", cookie);
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
        return dispatch.value.run(ctx);
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

  private routeTable(): RouteTrie<CompiledRoute> {
    if (this.compiled?.revision !== this.revision) {
      const table = new RouteTrie<CompiledRoute>();
      for (const route of this.collectRoutes()) {
        const runHandler = async (ctx: Context) => toResponse(await route.handler(ctx), ctx);
        table.add(route.method, route.path, {
          pattern: route.path,
          run: compose(route.middleware, runHandler, this.handleError),
        });
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
      route: ctx.route,
      status: response.status,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
    if (response.status >= 500) ctx.log.warn("request completed", fields);
    else ctx.log.info("request completed", fields);
  }
}
