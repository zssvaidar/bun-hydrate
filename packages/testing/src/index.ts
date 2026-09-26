export { spawnServer, type RunningServer, type SpawnServerOptions } from "./spawn";

type FetchHandler =(request: Request) => Response | Promise<Response>;
export type TestTarget = FetchHandler | { fetch: FetchHandler };

export interface TestClientOptions {
  /** Origin used to build request URLs. Default: http://localhost */
  baseUrl?: string;
  /** Headers sent with every request. */
  headers?: HeadersInit;
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

  constructor(
    private readonly handler: FetchHandler,
    private readonly method: string,
    url: URL,
    defaultHeaders: HeadersInit | undefined,
  ) {
    this.url = url;
    this.headers = new Headers(defaultHeaders);
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
    this.sent ??= Promise.resolve().then(() =>
      this.handler(new Request(this.url, { method: this.method, headers: this.headers, body: this.body })),
    );
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
}

export function createTestClient(target: TestTarget, options: TestClientOptions = {}): TestClient {
  const handler: FetchHandler = typeof target === "function" ? target : (request) => target.fetch(request);
  const baseUrl = options.baseUrl ?? "http://localhost";
  const request = (method: string, path: string) =>
    new TestRequest(handler, method, new URL(path, baseUrl), options.headers);

  return {
    get: (path) => request("GET", path),
    post: (path) => request("POST", path),
    put: (path) => request("PUT", path),
    patch: (path) => request("PATCH", path),
    delete: (path) => request("DELETE", path),
    head: (path) => request("HEAD", path),
    options: (path) => request("OPTIONS", path),
    request,
  };
}
