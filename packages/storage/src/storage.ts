import type { Duration } from "@bun-hydrate/core";

export interface ObjectInfo {
  key: string;
  size: number;
  contentType: string;
  /** Changes whenever the content changes. */
  etag: string;
  lastModified: Date;
  contentDisposition?: string;
}

export interface StoredFile extends ObjectInfo {
  /** Streams the content: large files never sit in memory. */
  body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export type StorageBody = Blob | ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string;

export interface PutOptions {
  /** Default: the Blob's type, else application/octet-stream. */
  contentType?: string;
  contentDisposition?: string;
}

export interface SignedUrlOptions {
  expiresIn: Duration;
  /** Serve as a download with this file name. */
  download?: string;
}

export interface ListPage {
  items: ObjectInfo[];
  nextCursor: string | null;
}

/** One interface for every store (spec-6 §7.1). Keys are validated the same way everywhere. */
export interface Storage {
  put(key: string, body: StorageBody, options?: PutOptions): Promise<ObjectInfo>;
  /** null when the key does not exist. */
  get(key: string): Promise<StoredFile | null>;
  head(key: string): Promise<ObjectInfo | null>;
  exists(key: string): Promise<boolean>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix`, in key order. */
  list(prefix?: string, page?: { cursor?: string; limit?: number }): Promise<ListPage>;
  /** A URL that serves the object until it expires. */
  signedUrl(key: string, options: SignedUrlOptions): Promise<string>;
  /** Joins validated segments: key("avatars", userId, "original.png"). */
  key(...segments: string[]): string;
  /** A view whose keys live under `prefix`, e.g. storage.scope("avatars/"). */
  scope(prefix: string): Storage;
}

export class StorageKeyError extends Error {
  override name = "StorageKeyError";
}

const MAX_KEY_BYTES = 1024;

/**
 * Checks a key the same way for every adapter and returns it NFC-normalized: no empty key, no
 * leading "/", no "\", no control characters, no empty, "." or ".." segments, at most 1024 bytes.
 */
export function validateKey(key: string): string {
  const normalized = key.normalize("NFC");
  const problem =
    normalized === ""
      ? "is empty"
      : normalized.startsWith("/")
        ? "starts with /"
        : normalized.includes("\\")
          ? "contains \\"
          : /[\u0000-\u001f\u007f]/.test(normalized)
            ? "contains control characters"
            : normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
              ? 'has an empty, "." or ".." segment'
              : Buffer.byteLength(normalized) > MAX_KEY_BYTES
                ? `is longer than ${MAX_KEY_BYTES} bytes`
                : undefined;
  if (problem) throw new StorageKeyError(`Storage key ${JSON.stringify(key.slice(0, 100))} ${problem}`);
  return normalized;
}

export function joinKey(segments: readonly string[]): string {
  for (const segment of segments) {
    if (segment.includes("/")) throw new StorageKeyError(`Key segment ${JSON.stringify(segment)} contains /`);
  }
  return validateKey(segments.join("/"));
}

/** The raw operations an adapter provides; keys are already validated. */
export abstract class StorageBase implements Storage {
  protected abstract write(key: string, body: StorageBody, options: PutOptions & { contentType: string }): Promise<ObjectInfo>;
  protected abstract read(key: string): Promise<StoredFile | null>;
  protected abstract stat(key: string): Promise<ObjectInfo | null>;
  protected abstract remove(key: string): Promise<void>;
  protected abstract listKeys(prefix: string, cursor: string | undefined, limit: number): Promise<ListPage>;
  protected abstract sign(key: string, options: SignedUrlOptions): Promise<string>;

  // async throughout: an invalid key rejects the promise rather than throwing at the call.
  async put(key: string, body: StorageBody, options: PutOptions = {}): Promise<ObjectInfo> {
    const contentType = options.contentType ?? (body instanceof Blob && body.type ? body.type : "application/octet-stream");
    return this.write(validateKey(key), body, { ...options, contentType });
  }

  async get(key: string): Promise<StoredFile | null> {
    return this.read(validateKey(key));
  }

  async head(key: string): Promise<ObjectInfo | null> {
    return this.stat(validateKey(key));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    return this.remove(validateKey(key));
  }

  async list(prefix = "", page: { cursor?: string; limit?: number } = {}): Promise<ListPage> {
    return this.listKeys(prefix.normalize("NFC"), page.cursor, page.limit ?? 1000);
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return this.sign(validateKey(key), options);
  }

  key(...segments: string[]): string {
    return joinKey(segments);
  }

  scope(prefix: string): Storage {
    return new ScopedStorage(this, prefix);
  }
}

class ScopedStorage implements Storage {
  private readonly prefix: string;

  constructor(
    private readonly parent: Storage,
    prefix: string,
  ) {
    this.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    validateKey(this.prefix.slice(0, -1));
  }

  private inner = (key: string) => this.prefix + validateKey(key);
  private outer = <T extends ObjectInfo | null>(info: T): T => (info ? { ...info, key: info.key.slice(this.prefix.length) } : info);

  async put(key: string, body: StorageBody, options?: PutOptions) {
    return this.outer(await this.parent.put(this.inner(key), body, options));
  }
  async get(key: string) {
    return this.outer(await this.parent.get(this.inner(key)));
  }
  async head(key: string) {
    return this.outer(await this.parent.head(this.inner(key)));
  }
  async exists(key: string) {
    return this.parent.exists(this.inner(key));
  }
  async delete(key: string) {
    return this.parent.delete(this.inner(key));
  }
  async list(prefix = "", page?: { cursor?: string; limit?: number }) {
    const result = await this.parent.list(this.prefix + prefix, page);
    return { ...result, items: result.items.map((item) => this.outer(item)) };
  }
  async signedUrl(key: string, options: SignedUrlOptions) {
    return this.parent.signedUrl(this.inner(key), options);
  }
  key(...segments: string[]) {
    return joinKey(segments);
  }
  scope(prefix: string): Storage {
    return new ScopedStorage(this, prefix);
  }
}

/** Reads any accepted body into bytes (for adapters that store in memory or need a length). */
export async function toBytes(body: StorageBody): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function md5Etag(bytes: Uint8Array): string {
  return `"${new Bun.CryptoHasher("md5").update(bytes).digest("hex")}"`;
}
