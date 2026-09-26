import type { Context } from "./context";

export type Next = () => Promise<Response>;

// Middleware sees every route, so it cannot know the route's param names.
export type Middleware = (ctx: Context<any>, next: Next) => Response | Promise<Response>;

type Terminal = (ctx: Context<any>) => Promise<Response>;
export type ErrorToResponse = (error: unknown, ctx: Context<any>) => Promise<Response>;

/**
 * Onion-style composition: each middleware wraps everything registered after it.
 *
 * Errors are converted into responses where they are thrown, so `await next()` always
 * resolves to a Response and outer middleware (logging, CORS, headers) can see and
 * decorate error responses the same way as successful ones.
 */
export function compose(middleware: readonly Middleware[], terminal: Terminal, onError: ErrorToResponse): Terminal {
  return (ctx) => {
    const dispatch = async (index: number): Promise<Response> => {
      const current = middleware[index];
      try {
        if (!current) return await terminal(ctx);

        let called = false;
        return await current(ctx, () => {
          if (called) return Promise.reject(new Error("next() was called more than once in the same middleware"));
          called = true;
          return dispatch(index + 1);
        });
      } catch (error) {
        return onError(error, ctx);
      }
    };
    return dispatch(0);
  };
}
