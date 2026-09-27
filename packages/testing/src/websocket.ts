export interface ConnectOptions {
  headers?: Record<string, string>;
  /** How long to wait for the connection. Default: 5s. */
  timeoutMs?: number;
}

export interface TestWebSocket {
  send(data: string | ArrayBufferLike | Uint8Array): void;
  /** The next message, in arrival order (text frames as strings). */
  next(options?: { timeoutMs?: number }): Promise<string | ArrayBuffer>;
  /** Resolves when the connection closes. */
  closed: Promise<{ code: number; reason: string }>;
  close(code?: number, reason?: string): Promise<{ code: number; reason: string }>;
  raw: WebSocket;
}

/** A WebSocket client for tests against a real server: messages are queued, so nothing is missed. */
export function connectWebSocket(url: string, options: ConnectOptions = {}): Promise<TestWebSocket> {
  // Bun's WebSocket accepts request headers (e.g. Origin, Cookie) as a second-argument option.
  const socket = new WebSocket(url, { headers: options.headers } as unknown as string[]);
  const queue: (string | ArrayBuffer)[] = [];
  const waiting: ((message: string | ArrayBuffer) => void)[] = [];

  socket.addEventListener("message", (event) => {
    const message = event.data as string | ArrayBuffer;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
  });

  const client: TestWebSocket = {
    raw: socket,
    closed,
    send: (data) => socket.send(data),
    next: ({ timeoutMs = 2_000 } = {}) => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(deliver), 1);
          reject(new Error(`No WebSocket message within ${timeoutMs}ms`));
        }, timeoutMs);
        const deliver = (message: string | ArrayBuffer) => {
          clearTimeout(timer);
          resolve(message);
        };
        waiting.push(deliver);
      });
    },
    close: (code, reason) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code, reason);
      return closed;
    },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket connection failed: timed out after ${options.timeoutMs ?? 5_000}ms`)), options.timeoutMs ?? 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(client);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed: ${url}`));
    });
  });
}
