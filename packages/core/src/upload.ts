import { HttpError, ValidationError } from "./errors";
import type { Middleware } from "./middleware";

/** Bytes, or a string such as "512kb", "2mb", "1gb" (1 kb = 1024 bytes). */
export type Size = number | `${number}${"b" | "kb" | "mb" | "gb"}`;

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

export function parseSize(size: Size): number {
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) return Math.floor(size);
  const match = typeof size === "string" ? /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(size.trim()) : null;
  if (!match) throw new Error(`Invalid size "${size}": use bytes or a string such as "512kb", "2mb"`);
  return Math.floor(Number(match[1]) * UNITS[match[2]!.toLowerCase()]!);
}

export function formatSize(bytes: number): string {
  for (const [unit, factor] of [["GB", 1024 ** 3], ["MB", 1024 ** 2], ["KB", 1024]] as const) {
    if (bytes >= factor) return `${Number((bytes / factor).toFixed(1))} ${unit}`;
  }
  return `${bytes} B`;
}

export class PayloadTooLargeError extends HttpError {
  constructor(limit: number) {
    super(413, `The request body is larger than ${formatSize(limit)}`, { code: "PAYLOAD_TOO_LARGE" });
  }
}

/** The subset of Context the limit needs; avoids a circular import. */
interface LimitTarget {
  headers: Headers;
  limitBody(bytes: number): void;
}

/** Throws 413 when the declared length is over `bytes`, and caps what the body readers accept. */
export function enforceBodyLimit(ctx: LimitTarget, bytes: number): void {
  ctx.limitBody(bytes);
  const declared = ctx.headers.get("content-length");
  if (declared !== null && Number(declared) > bytes) throw new PayloadTooLargeError(bytes);
}

/**
 * Lowers the body size limit for a route (the app's `maxBodySize` is the ceiling: Bun refuses
 * larger bodies before any code runs). Bodies without Content-Length are counted as they stream.
 */
export function bodyLimit(size: Size): Middleware {
  const bytes = parseSize(size);
  return (ctx, next) => {
    enforceBodyLimit(ctx, bytes);
    return next();
  };
}

/** Reads a body, refusing it once it passes `limit` bytes. */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw new PayloadTooLargeError(limit);
  if (!request.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PayloadTooLargeError(limit);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface UploadRules {
  /** Allowed types, judged by the file's bytes (spec-6 D8). */
  types: readonly string[];
  /** Per file. Default: no limit beyond the body limit. */
  maxSize?: Size;
}

export interface UploadsRules extends UploadRules {
  /** Default: 10. */
  maxFiles?: number;
  /** Require at least one file. Default: false. */
  required?: boolean;
}

/** A validated upload: `type` is the sniffed type and `name` a safe display name. */
export interface UploadedFile extends File {
  /** The name the client sent. Never use it as a path or storage key. */
  readonly originalName: string;
}

const SIGNATURES: { type: string; matches: (head: Uint8Array) => boolean }[] = [
  { type: "image/png", matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: "image/jpeg", matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  { type: "image/gif", matches: (h) => ascii(h, 0, "GIF87a") || ascii(h, 0, "GIF89a") },
  { type: "image/webp", matches: (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WEBP") },
  { type: "application/pdf", matches: (h) => ascii(h, 0, "%PDF-") },
  { type: "application/zip", matches: (h) => startsWith(h, [0x50, 0x4b, 0x03, 0x04]) },
];

const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
}

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The type the bytes show, among `allowed`; undefined when they show none of them. */
async function sniff(file: File, allowed: readonly string[]): Promise<string | undefined> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const binary = SIGNATURES.find((signature) => signature.matches(head))?.type;
  if (binary) return allowed.includes(binary) ? binary : undefined;
  const textTypes = allowed.filter((type) => TEXT_TYPES.has(type));
  if (textTypes.length === 0 || !isText(await file.bytes())) return undefined;
  const declared = file.type.split(";")[0]!.trim();
  return textTypes.includes(declared) ? declared : textTypes[0];
}

/** A display name safe for headers and logs: no path, no control or odd characters, at most 100 long. */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  let safe = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^[._]+/, "");
  if (safe.length > 100) {
    const extension = /\.[A-Za-z0-9]{1,10}$/.exec(safe)?.[0] ?? "";
    safe = safe.slice(0, 100 - extension.length) + extension;
  }
  return safe || "file";
}

const invalid = (field: string, message: string) => new ValidationError("Invalid upload", { details: [{ location: "body", path: field, message }] });

/** Checks the files sent in `field` against `rules` (spec-6 §8). */
export async function checkUploads(field: string, entries: FormDataEntryValue[], rules: UploadsRules): Promise<UploadedFile[]> {
  const files = entries.filter((entry): entry is File => typeof entry !== "string");
  const maxFiles = rules.maxFiles ?? 10;
  if (files.length !== entries.length) throw invalid(field, "must be a file");
  if (rules.required && files.length === 0) throw invalid(field, "is required");
  if (files.length > maxFiles) throw invalid(field, maxFiles === 1 ? "expects one file" : `expects at most ${maxFiles} files`);

  const maxSize = rules.maxSize === undefined ? undefined : parseSize(rules.maxSize);
  const checked: UploadedFile[] = [];
  for (const file of files) {
    if (maxSize !== undefined && file.size > maxSize) throw invalid(field, `must be at most ${formatSize(maxSize)}`);
    const type = await sniff(file, rules.types);
    if (!type) throw invalid(field, `must be one of: ${rules.types.join(", ")}`);
    // slice(): a nameless Blob, because Bun keeps the name of a File passed as a part.
    const uploaded = new File([file.slice()], safeFileName(file.name), { type });
    checked.push(Object.defineProperty(uploaded, "originalName", { value: file.name, enumerable: true }) as UploadedFile);
  }
  return checked;
}
