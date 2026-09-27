import { ForbiddenError, HttpError, NotFoundError, Router, safeFileName, type Context } from "@bun-hydrate/core";
import type { LocalStorage } from "./local";
import { StorageKeyError, validateKey } from "./storage";

/** Types a browser may show inline; everything else (HTML, SVG, scripts, …) is a download. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain|video\/|audio\/)/;

/**
 * Serves LocalStorage signed URLs (spec-6 §7.3): `app.route("/files", storageRoutes(storage))`.
 * Uploaded files are untrusted, so responses are sandboxed, never sniffed, and anything that could
 * render as a page downloads instead.
 */
export function storageRoutes(storage: LocalStorage): Router {
  return new Router().get("/*", async (ctx) => {
    const key = keyOf(ctx);
    const download = ctx.query.get("download");
    const check = await storage.verify(key, ctx.query.get("expires"), ctx.query.get("sig"), download);
    if (check === "expired") throw new ForbiddenError("This link has expired", { code: "SIGNED_URL_EXPIRED" });
    if (check !== "valid") throw new ForbiddenError("This link is not valid", { code: "SIGNED_URL_INVALID" });

    const found = await storage.file(key);
    if (!found) throw new NotFoundError("File not found", { code: "FILE_NOT_FOUND" });
    const { file, info } = found;

    const headers = new Headers({
      "content-type": info.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "content-disposition": download
        ? `attachment; filename="${safeFileName(download)}"`
        : INLINE.test(info.contentType)
          ? "inline"
          : "attachment",
      "cache-control": "private, no-transform",
      etag: info.etag,
      "last-modified": info.lastModified.toUTCString(),
      "accept-ranges": "bytes",
    });

    if (ctx.headers.get("if-none-match") === info.etag) return new Response(null, { status: 304, headers });

    const range = ctx.headers.get("range");
    if (range) {
      const bounds = parseRange(range, info.size);
      if (!bounds) {
        headers.set("content-range", `bytes */${info.size}`);
        throw new HttpError(416, "Range not satisfiable", { code: "RANGE_NOT_SATISFIABLE", headers: Object.fromEntries(headers) });
      }
      const [start, end] = bounds;
      headers.set("content-range", `bytes ${start}-${end}/${info.size}`);
      headers.set("content-length", String(end - start + 1));
      return new Response(file.slice(start, end + 1), { status: 206, headers });
    }
    headers.set("content-length", String(info.size));
    return new Response(file, { headers });
  });
}

function keyOf(ctx: Context<{ "*": string }>): string {
  try {
    return validateKey(ctx.params["*"].split("/").map(decodeURIComponent).join("/"));
  } catch (error) {
    if (error instanceof StorageKeyError || error instanceof URIError) throw new NotFoundError("File not found", { code: "FILE_NOT_FOUND" });
    throw error;
  }
}

/** One `bytes=` range: "a-b", "a-" or "-n". Multiple ranges are not supported. */
function parseRange(header: string, size: number): [number, number] | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  let start: number;
  let end: number;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? [start, end] : undefined;
}
