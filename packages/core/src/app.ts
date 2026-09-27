import type { Server, ServerWebSocket } from "bun";
import { ipMatcher, resolveClient, type TrustProxy } from "./client-ip";
import { Context } from "./context";
import { ForbiddenError, HttpError, MethodNotAllowedError, NotFoundError, toHttpError } from "./errors";
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
import { Router, type PathParams } from "./router";
import {
  ROUTE_HANDLERS,
  WEBSOCKET_DEFAULTS,
  handlersOf,
  type AnyHandlers,
  type UpgradeCapable,
  type WebSocketHandlers,
  type WebSocketOptions,
} from "./websocket";
import { securityHeaders, type SecurityHeadersOptions } from "./security-headers";
import type { PubSub, PubSubMessage } from "./pubsub";
import { enforceBodyLimit, parseSize, type Size } from "./upload";
import { childTrace, parseTraceparent, runWithTrace } from "./trace";

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
  /** Baseline security headers (spec-5 §2.1): on by default; pass overrides, or false to turn off. */
  securityHeaders?: SecurityHeadersOptions | false;
  /** WebSocket limits and allowed origins (spec-5 §1.5). */
  websocket?: WebSocketOptions;
  /** Carries app.publish() to every instance (spec-6 §9). Default: this process only. */
  pubsub?: PubSub;
  /** Largest request body accepted (spec-6 §8); bodyLimit() lowers it per route. Default: "10mb". */
  maxBodySize?: Size;
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
  server: Server<object> | undefined;

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
  private readonly websocketOptions: WebSocketOptions;
  private pubsub: PubSub | undefined;
  private readonly maxBodyBytes: number;
  private unsubscribePubSub: (() => Promise<void>) | undefined;
  private readonly drainHooks: StopHook[] = [];
  private readonly sockets = new Set<ServerWebSocket<object>>();
  /** Per request: the server able to upgrade it (only set by handle(), never by fetch()). */
  private readonly upgraders = new WeakMap<Context<unknown>, UpgradeCapable>();
  private readonly upgraded = new WeakSet<Context<unknown>>();
  private inFlight = 0;
  private readonly idleWaiters: (() => void)[] = [];

  constructor(options: AppOptions = {}) {
    super();
    this.logger = options.logger ?? createLogger();
    this.exposeErrors = options.exposeErrors ?? process.env.NODE_ENV === "development";
    this.logRequests = options.logRequests ?? true;
    this.lifecycle = new Lifecycle(this.logger);
    this.trustProxy = options.trustProxy ?? false;
    this.websocketOptions = options.websocket ?? {};
    this.pubsub = options.pubsub;
    this.maxBodyBytes = parseSize(options.maxBodySize ?? "10mb");
    this.isTrustedProxy = Array.isArray(this.trustProxy) ? ipMatcher(this.trustProxy) : undefined;

    // First, so every route is covered; Bun also refuses larger bodies before any code runs.
    this.use((ctx, next) => {
      enforceBodyLimit(ctx, this.maxBodyBytes);
      return next();
    });
    if (options.securityHeaders !== false) this.use(securityHeaders(options.securityHeaders ?? {}));

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

  /** Sets the fan-out adapter after construction (e.g. from a generated installPlatform); before listen(). */
  usePubSub(pubsub: PubSub): this {
    if (this.state !== "created") throw new Error("usePubSub() must be called before listen()");
    this.pubsub = pubsub;
    return this;
  }

  /**
   * Starts the lifecycle without binding a port: for worker processes that serve nothing
   * (spec-6 §10). Start hooks run, signals stop it gracefully, stop() runs the cleanups.
   */
  async run(options: { handleSignals?: boolean } = {}): Promise<void> {
    if (this.state !== "created") throw new Error(`App is already ${this.state}; run() can only be called once`);
    await this.lifecycle.start();
    this.lifecycle.state = "running";
    if (options.handleSignals ?? true) {
      for (const signal of SHUTDOWN_SIGNALS) process.on(signal, this.onSignal);
    }
  }

  /**
   * Runs during shutdown after in-flight requests have drained, before the pub/sub unsubscribes
   * and stop hooks close connections (spec-6 §11): e.g. `events.idle()`, flushing buffers.
   */
  onDrain(hook: StopHook): this {
    this.drainHooks.push(hook);
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
  async listen(options: ListenOptions = {}): Promise<Server<object>> {
    if (this.state !== "created") throw new Error(`App is already ${this.state}; listen() can only be called once`);

    await this.lifecycle.start();
    try {
      this.server = Bun.serve<object>({
        port: options.port ?? 3000,
        hostname: options.hostname ?? "0.0.0.0",
        fetch: (request, server) => this.handle(request, server as unknown as UpgradeCapable),
        websocket: this.websocketHandler(),
        maxRequestBodySize: this.maxBodyBytes,
      });
    } catch (error) {
      await this.lifecycle.runShutdownHooks();
      this.lifecycle.state = "stopped";
      throw error;
    }

    if (this.pubsub) {
      const server = this.server;
      this.unsubscribePubSub = await this.pubsub.subscribe((topic, message) => void server.publish(topic, message));
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

    // Long-lived sockets would hold the drain open until the timeout; close them first (FR-243).
    // 1012 "Service Restart": Bun rewrites 1001 to 1000, and 1012 also tells clients to reconnect.
    for (const socket of this.sockets) socket.close(1012, "Server restarting");

    if (this.server) {
      let timer: Timer | undefined;
      const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
      // Bun's stop() promise never settles once a WebSocket has connected, so our own count of
      // in-flight requests and open sockets also ends the drain.
      const drained = Promise.race([this.server.stop().then(() => true), this.untilIdle().then(() => true)]);
      const finishedInTime = await Promise.race([drained, timedOut]);
      // A pending timer would keep the process alive after shutdown.
      clearTimeout(timer);
      if (!finishedInTime) {
        this.logger.warn("Shutdown timeout reached; closing remaining connections", { timeoutMs });
        // Not awaited: it only settles once every handler returns, and a hung handler never will.
        void this.server.stop(true);
      }
    }

    // Phases 3–5 (spec-6 §11): drain hooks, stop receiving messages, then close connections.
    for (const hook of this.drainHooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.error("A drain hook failed during shutdown", { error });
      }
    }
    await this.unsubscribePubSub?.().catch((error) => this.logger.error("Unsubscribing from pub/sub failed", { error }));
    await this.lifecycle.runShutdownHooks();
    this.lifecycle.state = "stopped";
    this.logger.info("Stopped");
  }

  /**
   * The web-standard entry point, and what the test client calls. `server` supplies the socket
   * address; in-process callers may omit it or pass a stand-in. It never upgrades WebSockets
   * (those routes answer 426) — `listen()` uses handle() for that.
   */
  readonly fetch = async (request: Request, server?: PeerSource): Promise<Response> =>
    (await this.dispatch(request, server, undefined))!;

  /**
   * Like fetch(), but with a server able to upgrade WebSockets. Resolves to undefined after a
   * successful upgrade, which is what Bun.serve expects.
   */
  readonly handle = (request: Request, server: UpgradeCapable): Promise<Response | undefined> =>
    this.dispatch(request, server, server);

  /** Registers a WebSocket route (spec-5 §1.5). The upgrade request runs the full middleware stack. */
  websocket<Path extends string, Data extends object = {}>(
    path: Path,
    handlers: WebSocketHandlers<Data, PathParams<Path>>,
  ): this {
    return this.get(path, async (ctx) => {
      if (this.state !== "running" && this.upgraders.has(ctx)) {
        throw new HttpError(503, "Server is shutting down", { code: "SHUTTING_DOWN" });
      }
      if (!this.isAllowedOrigin(ctx)) throw new ForbiddenError("Origin not allowed", { code: "ORIGIN_REJECTED" });

      const server = this.upgraders.get(ctx);
      if (!server || ctx.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new HttpError(426, "This route only accepts WebSocket connections", {
          code: "UPGRADE_REQUIRED",
          headers: { upgrade: "websocket" },
        });
      }

      const data: object = (await handlers.upgrade?.(ctx)) ?? {};
      Object.defineProperty(data, ROUTE_HANDLERS, { value: handlers, enumerable: false });
      if (!server.upgrade(ctx.request, { data, headers: { [REQUEST_ID_HEADER]: ctx.requestId } })) {
        throw new HttpError(400, "WebSocket upgrade failed", { code: "UPGRADE_FAILED" });
      }
      this.upgraded.add(ctx);
      return new Response(null, { status: 200 });
    });
  }

  /**
   * Publishes to a topic's WebSocket subscribers: on every instance with a `pubsub` adapter
   * (spec-6 §9), otherwise in this process. At most once: messages are not stored.
   */
  async publish(topic: string, message: PubSubMessage): Promise<void> {
    if (this.pubsub) await this.pubsub.publish(topic, message);
    else this.server?.publish(topic, message);
  }

  private async dispatch(
    request: Request,
    server: PeerSource | undefined,
    upgrader: UpgradeCapable | undefined,
  ): Promise<Response | undefined> {
    this.inFlight++;
    try {
      return await this.process(request, server, upgrader);
    } finally {
      this.inFlight--;
      this.notifyIfIdle();
    }
  }

  private untilIdle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.notifyIfIdle();
    });
  }

  private notifyIfIdle(): void {
    if (this.inFlight > 0 || this.sockets.size > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async process(
    request: Request,
    server: PeerSource | undefined,
    upgrader: UpgradeCapable | undefined,
  ): Promise<Response | undefined> {
    const startedAt = performance.now();
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const dispatch = this.match(request);
    const client = resolveClient(request, server?.requestIP(request)?.address, this.trustProxy, this.isTrustedProxy);
    const trace = childTrace(parseTraceparent(request.headers.get("traceparent")));
    const ctx = new Context(request, {
      params: dispatch.kind === "found" ? dispatch.params : {},
      route: dispatch.kind === "found" ? dispatch.value.pattern : undefined,
      requestId,
      log: this.logger.child({ requestId, traceId: trace.traceId }),
      trace,
      ...client,
    });
    if (upgrader) this.upgraders.set(ctx, upgrader);

    let response = await runWithTrace(trace, () =>
      compose(this.ownMiddleware, () => this.runRoute(dispatch, ctx), this.handleError)(ctx),
    );
    if (this.upgraded.has(ctx)) {
      if (this.logRequests) this.logRequest(ctx, new Response(null, { status: 200 }), startedAt, 101);
      return undefined;
    }

    for (const cookie of ctx.cookies.changes()) response = appendHeader(response, "set-cookie", cookie);
    if (request.method === "HEAD") response = withoutBody(response);
    response = withHeader(response, REQUEST_ID_HEADER, requestId);
    if (this.logRequests) this.logRequest(ctx, response, startedAt);
    return response;
  }

  private match(request: Request): Dispatch {
    try {
      return this.routeTable().match(request.method, new URL(request.url).pathname);
    } catch (error) {
      return { kind: "error", error };
    }
  }

  private async runRoute(dispatch: Dispatch, ctx: Context): Promise<Response> {
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

  private isAllowedOrigin(ctx: Context<unknown>): boolean {
    const origin = ctx.headers.get("origin");
    if (origin === null) return true; // not a browser: cross-site hijacking needs one
    const ownOrigin = `${ctx.protocol}://${ctx.headers.get("host") ?? ctx.url.host}`;
    return origin === ownOrigin || (this.websocketOptions.allowedOrigins ?? []).includes(origin);
  }

  private websocketHandler() {
    const options = { ...WEBSOCKET_DEFAULTS, ...this.websocketOptions };
    const guard = (ws: ServerWebSocket<object>, event: string, run: (handlers: AnyHandlers) => unknown) => {
      const handlers = handlersOf(ws);
      if (!handlers) return;
      Promise.resolve()
        .then(() => run(handlers))
        .catch((error) => {
          this.logger.error("WebSocket handler failed", { event, error });
          ws.close(1011, "Internal error");
        });
    };

    return {
      maxPayloadLength: options.maxPayloadLength,
      idleTimeout: options.idleTimeout,
      backpressureLimit: options.backpressureLimit,
      open: (ws: ServerWebSocket<object>) => {
        this.sockets.add(ws);
        guard(ws, "open", (handlers) => handlers.open?.(ws));
      },
      message: (ws: ServerWebSocket<object>, message: string | Buffer) =>
        guard(ws, "message", (handlers) => handlers.message?.(ws, message)),
      close: (ws: ServerWebSocket<object>, code: number, reason: string) => {
        this.sockets.delete(ws);
        this.notifyIfIdle();
        guard(ws, "close", (handlers) => handlers.close?.(ws, code, reason));
      },
      drain: (ws: ServerWebSocket<object>) => guard(ws, "drain", (handlers) => handlers.drain?.(ws)),
    };
  }

  private logRequest(ctx: Context, response: Response, startedAt: number, statusOverride?: number): void {
    const fields = {
      method: ctx.method,
      path: ctx.path,
      route: ctx.route,
      status: statusOverride ?? response.status,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
    if (response.status >= 500) ctx.log.warn("request completed", fields);
    else ctx.log.info("request completed", fields);
  }
}
