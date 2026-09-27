import type { BunFile } from "bun";
import { Cookies } from "./cookies";
import { BadRequestError, NotFoundError } from "./errors";
import { randomHex } from "./trace";
import { checkUploads, readLimited, type UploadRules, type UploadedFile, type UploadsRules } from "./upload";
import type { Logger } from "./logger";

/**
 * Per-request state shared between middleware and handlers. Apps add typed keys with
 * declaration merging:
 *
 *   declare module "@bun-hydrate/core" { interface ContextState { user?: User } }
 */
export interface ContextState {
  [key: string]: unknown;
}

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

const JSON_TYPE = "application/json;charset=utf-8";
const TEXT_TYPE = "text/plain;charset=utf-8";
const HTML_TYPE = "text/html;charset=utf-8";

/** Request body readers. Kept apart from the `ctx.json()` response builder to avoid one name with two meanings. */
export class RequestBody {
  private form: Promise<FormData> | undefined;

  /** `limit` reports the current body size limit in bytes (maxBodySize, lowered by bodyLimit()). */
  constructor(
    private readonly request: Request,
    private readonly limit: () => number | undefined = () => undefined,
  ) {}

  async json<T = unknown>(): Promise<T> {
    const text = await this.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BadRequestError("Request body is not valid JSON", { code: "INVALID_JSON" });
    }
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  /** Parsed once per request, so several ctx.upload() calls share it. */
  formData(): Promise<FormData> {
    this.form ??= (async () => {
      const bytes = await this.bytes();
      try {
        return await new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": this.request.headers.get("content-type") ?? "" } }).formData();
      } catch {
        throw new BadRequestError("Request body is not valid form data", { code: "INVALID_FORM_DATA" });
      }
    })();
    return this.form;
  }

  bytes(): Promise<Uint8Array> {
    const limit = this.limit();
    return limit === undefined ? this.request.bytes() : readLimited(this.request, limit);
  }
}

export interface ContextInit<Params> {
  params: Params;
  requestId: string;
  log: Logger;
  ip?: string;
  protocol?: "http" | "https";
  route?: string;
  trace?: { traceId: string; spanId: string; flags: string };
}

export class Context<Params = Record<string, string>> {
  readonly request: Request;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly params: Params;
  readonly requestId: string;
  readonly log: Logger;
  readonly state: ContextState = {};
  readonly body: RequestBody;
  /** Client address, resolved through trusted proxies only (spec-5 §1.1). */
  readonly ip: string;
  readonly protocol: "http" | "https";
  /** The matched route pattern, e.g. "/users/:id"; undefined when nothing matched. */
  readonly route: string | undefined;
  readonly cookies: Cookies;
  /** W3C trace context (spec-5 §1.4): continued from `traceparent`, or started here. */
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;

  private bodyLimitBytes: number | undefined;
  private pendingStatus: number | undefined;
  private readonly pendingHeaders = new Headers();

  constructor(request: Request, init: ContextInit<Params>) {
    this.request = request;
    this.method = request.method;
    this.url = new URL(request.url);
    this.path = this.url.pathname;
    this.query = this.url.searchParams;
    this.headers = request.headers;
    this.params = init.params;
    this.requestId = init.requestId;
    this.log = init.log;
    this.body = new RequestBody(request, () => this.bodyLimitBytes);
    this.ip = init.ip ?? "127.0.0.1";
    this.protocol = init.protocol ?? (this.url.protocol === "https:" ? "https" : "http");
    this.route = init.route;
    this.cookies = new Cookies(request.headers.get("cookie"), this.protocol === "https");
    this.traceId = init.trace?.traceId ?? randomHex(16);
    this.spanId = init.trace?.spanId ?? randomHex(8);
    this.traceFlags = init.trace?.flags ?? "01";
  }

  /** Sets the status used by the response builders and by plain return values. */
  /** Lowers the body size limit for this request (bodyLimit() and the app's maxBodySize use it). */
  limitBody(bytes: number): void {
    this.bodyLimitBytes = this.bodyLimitBytes === undefined ? bytes : Math.min(this.bodyLimitBytes, bytes);
  }

  /** One uploaded file from a multipart form, checked by content and size (spec-6 §8). A 422 otherwise. */
  async upload(field: string, rules: UploadRules): Promise<UploadedFile> {
    const [file] = await checkUploads(field, (await this.body.formData()).getAll(field), { ...rules, maxFiles: 1, required: true });
    return file!;
  }

  /** Every file sent in `field`, each checked like upload(). */
  async uploads(field: string, rules: UploadsRules): Promise<UploadedFile[]> {
    return checkUploads(field, (await this.body.formData()).getAll(field), rules);
  }

  status(code: number): this {
    this.pendingStatus = code;
    return this;
  }

  header(name: string, value: string): this {
    this.pendingHeaders.set(name, value);
    return this;
  }

  json(data: unknown, status?: number): Response {
    return this.respond(JSON.stringify(data) ?? "null", { status, contentType: JSON_TYPE });
  }

  text(text: string, status?: number): Response {
    return this.respond(text, { status, contentType: TEXT_TYPE });
  }

  html(html: string | ReadableStream, status?: number): Response {
    return this.respond(html, { status, contentType: HTML_TYPE });
  }

  empty(status?: number): Response {
    return this.respond(null, { status, fallbackStatus: 204 });
  }

  redirect(location: string, status: RedirectStatus = 302): Response {
    return this.respond(null, { status, headers: { location } });
  }

  async file(file: string | BunFile): Promise<Response> {
    const bunFile = typeof file === "string" ? Bun.file(file) : file;
    if (!(await bunFile.exists())) throw new NotFoundError();
    return this.respond(bunFile, {});
  }

  /** Explicit status argument > ctx.status() > the builder's fallback. */
  private respond(
    body: BodyInit | null,
    options: { status?: number; fallbackStatus?: number; contentType?: string; headers?: Record<string, string> },
  ): Response {
    const headers = new Headers(this.pendingHeaders);
    if (options.contentType && !headers.has("content-type")) headers.set("content-type", options.contentType);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);

    const status = options.status ?? this.pendingStatus ?? options.fallbackStatus ?? 200;
    return new Response(body, { status, headers });
  }
}
