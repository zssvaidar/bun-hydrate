export { spawnServer, type RunningServer, type SpawnServerOptions } from "./spawn";
export { connectWebSocket, type TestWebSocket, type ConnectOptions } from "./websocket";

/** What the app's fetch receives as its second argument: a stand-in for Bun's server. */
interface PeerSource {
  requestIP(request: Request): { address: string } | null;
}
type FetchHandler = (request: Request, server?: PeerSource) => Response | undefined | Promise<Response | undefined>;
export type TestTarget = FetchHandler | { fetch: FetchHandler };

export interface TestClientOptions {
  /** Origin used to build request URLs. Default: http://localhost */
  baseUrl?: string;
  /** Headers sent with every request. */
  headers?: HeadersInit;
  /** Keep cookies from Set-Cookie and send them on later requests, like a browser. */
  cookies?: boolean;
}

/** A minimal browser-like cookie jar: honours Max-Age/Expires deletion, ignores paths and domains. */
export class CookieJar {
  private readonly values = new Map<string, string>();

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  clear(): void {
    this.values.clear();
  }

  /** @internal */
  header(): string | undefined {
    return this.values.size === 0 ? undefined : [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** @internal */
  store(setCookie: string[]): void {
    for (const cookie of setCookie) {
      const [pair = "", ...attributes] = cookie.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const maxAge = attributes.find((a) => /^max-age=/i.test(a))?.split("=")[1];
      const expires = attributes.find((a) => /^expires=/i.test(a))?.slice("expires=".length);
      const expired =
        (maxAge !== undefined && Number(maxAge) <= 0) || (expires !== undefined && Date.parse(expires) <= Date.now());
      if (expired || value === "") this.values.delete(name);
      else this.values.set(name, value);
    }
  }
}

type QueryValue = string | number | boolean;

/**
 * A request being built. Awaiting it sends it through the app's fetch handler in process —
 * no socket, no port — and resolves to a standard Response.
 */
export class TestRequest implements PromiseLike<Response> {
  private readonly headers: Headers;
  private readonly url: URL;
  private body: BodyInit | undefined;
  private sent: Promise<Response> | undefined;
  private clientIp: string | undefined;

  constructor(
    private readonly handler: FetchHandler,
    private readonly method: string,
    url: URL,
    defaultHeaders: HeadersInit | undefined,
    private readonly jar: CookieJar | undefined,
  ) {
    this.url = url;
    this.headers = new Headers(defaultHeaders);
  }

  /** The client address the app sees (as if from the socket). */
  ip(address: string): this {
    this.clientIp = address;
    return this;
  }

  bearer(token: string): this {
    return this.header("authorization", `Bearer ${token}`);
  }

  header(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  query(params: Record<string, QueryValue>): this {
    for (const [key, value] of Object.entries(params)) this.url.searchParams.set(key, String(value));
    return this;
  }

  json(data: unknown): this {
    this.headers.set("content-type", "application/json");
    this.body = JSON.stringify(data);
    return this;
  }

  text(text: string): this {
    if (!this.headers.has("content-type")) this.headers.set("content-type", "text/plain;charset=utf-8");
    this.body = text;
    return this;
  }

  /** Sends multipart form data; the boundary content type is set by the Request itself. */
  form(form: FormData): this {
    this.body = form;
    return this;
  }

  send(): Promise<Response> {
    this.sent ??= Promise.resolve().then(async () => {
      const jarCookies = this.jar?.header();
      if (jarCookies && !this.headers.has("cookie")) this.headers.set("cookie", jarCookies);

      const peer = this.clientIp ? { requestIP: () => ({ address: this.clientIp! }) } : undefined;
      const response = await this.handler(
        new Request(this.url, { method: this.method, headers: this.headers, body: this.body }),
        peer,
      );
      if (!response) throw new Error("The app returned no response (WebSocket upgrades need a real server)");
      this.jar?.store(response.headers.getSetCookie());
      return response;
    });
    return this.sent;
  }

  then<Fulfilled = Response, Rejected = never>(
    onFulfilled?: ((response: Response) => Fulfilled | PromiseLike<Fulfilled>) | null,
    onRejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ): Promise<Fulfilled | Rejected> {
    return this.send().then(onFulfilled, onRejected);
  }
}

export interface TestClient {
  get(path: string): TestRequest;
  post(path: string): TestRequest;
  put(path: string): TestRequest;
  patch(path: string): TestRequest;
  delete(path: string): TestRequest;
  head(path: string): TestRequest;
  options(path: string): TestRequest;
  request(method: string, path: string): TestRequest;
  /** Present when created with `{ cookies: true }`. */
  cookies: CookieJar;
}

export function createTestClient(target: TestTarget, options: TestClientOptions = {}): TestClient {
  const handler: FetchHandler = typeof target === "function" ? target : (request, peer) => target.fetch(request, peer);
  const baseUrl = options.baseUrl ?? "http://localhost";
  const jar = new CookieJar();
  const request = (method: string, path: string) =>
    new TestRequest(handler, method, new URL(path, baseUrl), options.headers, options.cookies ? jar : undefined);

  return {
    get: (path) => request("GET", path),
    post: (path) => request("POST", path),
    put: (path) => request("PUT", path),
    patch: (path) => request("PATCH", path),
    delete: (path) => request("DELETE", path),
    head: (path) => request("HEAD", path),
    options: (path) => request("OPTIONS", path),
    request,
    cookies: jar,
  };
}
