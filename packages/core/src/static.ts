import { resolve, sep } from "node:path";
import type { Middleware } from "./middleware";
import { joinPaths } from "./router";

export interface StaticOptions {
  /** Directory to serve files from. */
  root: string;
  /** URL prefix the files are served under. Default: "/". */
  prefix?: string;
  cacheControl?: string;
}

/** Serves files from `root` for GET/HEAD requests under `prefix`; anything else falls through to `next()`. */
export function serveStatic(options: StaticOptions): Middleware {
  const root = resolve(options.root);
  const prefix = joinPaths(options.prefix ?? "/");

  return async (ctx, next) => {
    if (ctx.method !== "GET" && ctx.method !== "HEAD") return next();

    const relative = stripPrefix(ctx.path, prefix);
    const filePath = relative === undefined ? undefined : resolveInside(root, relative);
    if (!filePath) return next();

    const file = Bun.file(filePath);
    const stat = await file.stat().catch(() => undefined);
    if (!stat?.isFile()) return next();

    const headers = new Headers();
    if (options.cacheControl) headers.set("cache-control", options.cacheControl);
    return new Response(file, { headers });
  };
}

function stripPrefix(path: string, prefix: string): string | undefined {
  if (prefix === "/") return path;
  if (path === prefix || path.startsWith(prefix + "/")) return path.slice(prefix.length);
  return undefined;
}

/** Returns the absolute path only if it stays inside `root` after decoding (blocks `..%2f` traversal). */
function resolveInside(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;

  const filePath = resolve(root, "." + decoded);
  return filePath.startsWith(root + sep) ? filePath : undefined;
}
