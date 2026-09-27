import type { ServerWebSocket } from "bun";
import type { Context } from "./context";

export interface WebSocketHandlers<Data extends object, Params> {
  /**
   * Runs after global middleware, like any GET route. Throw to refuse (a normal HTTP error
   * response is sent); return the data that becomes `ws.data`.
   */
  upgrade?(ctx: Context<Params>): Data | Promise<Data>;
  open?(ws: ServerWebSocket<Data>): void | Promise<void>;
  message?(ws: ServerWebSocket<Data>, message: string | Buffer): void | Promise<void>;
  close?(ws: ServerWebSocket<Data>, code: number, reason: string): void | Promise<void>;
  drain?(ws: ServerWebSocket<Data>): void;
}

export interface WebSocketOptions {
  /** Origins allowed besides the app's own (cross-site WebSocket hijacking protection). */
  allowedOrigins?: readonly string[];
  /** Largest accepted message in bytes. Default: 64 KiB. */
  maxPayloadLength?: number;
  /** Seconds without traffic before a connection is closed. Default: 120. */
  idleTimeout?: number;
  /** Bytes buffered per socket before sends report backpressure. Default: 1 MiB. */
  backpressureLimit?: number;
}

/** The part of Bun's server that `app.handle()` needs. */
export interface UpgradeCapable {
  requestIP(request: Request): { address: string } | null;
  upgrade(request: Request, options: { data: object; headers?: HeadersInit }): boolean;
}

/** Stored on ws.data under a symbol, so user data keeps exactly the shape the upgrade returned. */
export const ROUTE_HANDLERS: unique symbol = Symbol("bun-hydrate.websocket.handlers");

export type AnyHandlers = WebSocketHandlers<object, unknown>;

export function handlersOf(ws: ServerWebSocket<object>): AnyHandlers | undefined {
  return (ws.data as { [ROUTE_HANDLERS]?: AnyHandlers })[ROUTE_HANDLERS];
}

export const WEBSOCKET_DEFAULTS = {
  maxPayloadLength: 64 * 1024,
  idleTimeout: 120,
  backpressureLimit: 1024 * 1024,
} as const;
