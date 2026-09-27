import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseDuration } from "@bun-hydrate/core";
import {
  StorageBase,
  StorageKeyError,
  type ListPage,
  type ObjectInfo,
  type PutOptions,
  type SignedUrlOptions,
  type StorageBody,
  type StoredFile,
} from "./storage";

export interface LocalStorageOptions {
  /** Directory holding the files. Created when missing. */
  root: string;
  /** HMAC key for signed URLs, at least 32 characters (STORAGE_SIGNING_KEY). */
  signingKey: string;
  /** Where storageRoutes() is mounted. Default: "/files". */
  baseUrl?: string;
  now?: () => number;
}

interface Meta {
  contentType: string;
  contentDisposition?: string;
  etag: string;
}

const RESERVED = [".meta", ".tmp"];

export type SignatureCheck = "valid" | "expired" | "invalid";

/**
 * Files on the local disk (spec-6 §7.2). Writes go to a temp file first and are renamed into
 * place, so readers never see half a file. Content type and etag live in a sidecar under .meta/.
 * Single host only: use S3Storage when several instances serve files.
 */
export class LocalStorage extends StorageBase {
  readonly root: string;
  readonly baseUrl: string;
  private readonly signingKey: Promise<CryptoKey>;
  private readonly now: () => number;
  private realRoot: Promise<string> | undefined;
  private resolvedRoot: string | undefined;

  constructor(options: LocalStorageOptions) {
    super();
    if (options.signingKey.length < 32) throw new Error("LocalStorage signingKey must be at least 32 characters");
    this.root = resolve(options.root);
    this.baseUrl = (options.baseUrl ?? "/files").replace(/\/$/, "");
    this.now = options.now ?? Date.now;
    this.signingKey = crypto.subtle.importKey("raw", new TextEncoder().encode(options.signingKey), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  }

  protected async write(key: string, body: StorageBody, options: PutOptions & { contentType: string }): Promise<ObjectInfo> {
    const target = await this.pathFor(key, { create: true });
    const temp = join(await this.rootPath(), ".tmp", crypto.randomUUID());
    await mkdir(dirname(temp), { recursive: true });
    try {
      await writeFile(temp, body);
      const meta: Meta = {
        contentType: options.contentType,
        etag: await fileEtag(temp),
        ...(options.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
      };
      await Bun.write(this.metaPath(target), JSON.stringify(meta));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return (await this.stat(key))!;
  }

  protected async read(key: string): Promise<StoredFile | null> {
    const info = await this.stat(key);
    if (!info) return null;
    const file = Bun.file(await this.pathFor(key));
    return { ...info, body: file.stream(), text: () => file.text(), bytes: () => file.bytes() };
  }

  protected async stat(key: string): Promise<ObjectInfo | null> {
    const path = await this.pathFor(key);
    const stats = await stat(path).catch(() => undefined);
    if (!stats?.isFile()) return null;
    const meta = await this.readMeta(path);
    return {
      key,
      size: stats.size,
      contentType: meta?.contentType ?? "application/octet-stream",
      etag: meta?.etag ?? `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
      lastModified: stats.mtime,
      ...(meta?.contentDisposition ? { contentDisposition: meta.contentDisposition } : {}),
    };
  }

  protected async remove(key: string): Promise<void> {
    const path = await this.pathFor(key);
    await rm(path, { force: true });
    await rm(this.metaPath(path), { force: true });
  }

  protected async listKeys(prefix: string, cursor: string | undefined, limit: number): Promise<ListPage> {
    const root = await this.rootPath();
    const keys = (await walk(root, root))
      .filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor))
      .sort();
    const items: ObjectInfo[] = [];
    for (const key of keys.slice(0, limit)) {
      const info = await this.stat(key);
      if (info) items.push(info);
    }
    return { items, nextCursor: keys.length > limit ? items.at(-1)!.key : null };
  }

  protected async sign(key: string, { expiresIn, download }: SignedUrlOptions): Promise<string> {
    const expires = Math.floor((this.now() + parseDuration(expiresIn)) / 1000);
    const signature = await this.signature(key, expires, download);
    const query = new URLSearchParams({ expires: String(expires), sig: signature, ...(download ? { download } : {}) });
    return `${this.baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}?${query}`;
  }

  /** Checks a signed URL's parameters for `key` in constant time. */
  async verify(key: string, expires: string | null, signature: string | null, download: string | null): Promise<SignatureCheck> {
    if (!expires || !signature || !/^\d+$/.test(expires)) return "invalid";
    const expected = Buffer.from(await this.signature(key, Number(expires), download ?? undefined));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return "invalid";
    return Number(expires) * 1000 < this.now() ? "expired" : "valid";
  }

  /** The file behind a key, for storageRoutes(). */
  async file(key: string): Promise<{ file: ReturnType<typeof Bun.file>; info: ObjectInfo } | null> {
    const info = await this.stat(key);
    return info && { file: Bun.file(await this.pathFor(key)), info };
  }

  private async signature(key: string, expires: number, download: string | undefined): Promise<string> {
    const payload = new TextEncoder().encode(`${key}\n${expires}\n${download ?? ""}`);
    return Buffer.from(await crypto.subtle.sign("HMAC", await this.signingKey, payload)).toString("base64url");
  }

  private rootPath(): Promise<string> {
    this.realRoot ??= mkdir(this.root, { recursive: true })
      .then(() => realpath(this.root))
      .then((root) => (this.resolvedRoot = root));
    return this.realRoot;
  }

  /** The path for a key, refusing reserved names and anything that resolves outside the root (symlinks). */
  private async pathFor(key: string, { create = false } = {}): Promise<string> {
    if (RESERVED.some((name) => key === name || key.startsWith(`${name}/`))) {
      throw new StorageKeyError(`Storage key "${key}" is reserved by LocalStorage`);
    }
    const root = await this.rootPath();
    const path = join(root, key);
    const parent = dirname(path);
    if (create) await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent).catch(() => parent);
    if (realParent !== root && !realParent.startsWith(root + sep)) {
      throw new StorageKeyError(`Storage key "${key}" resolves outside the storage root`);
    }
    return join(realParent, relative(parent, path));
  }

  /** The sidecar holding a file's content type and etag: <root>/.meta/<key>.json. */
  private metaPath(path: string): string {
    const root = this.resolvedRoot!; // set by rootPath(), which pathFor() always awaits first
    return join(root, ".meta", `${relative(root, path)}.json`);
  }

  private async readMeta(path: string): Promise<Meta | undefined> {
    const file = Bun.file(this.metaPath(path));
    return (await file.exists()) ? ((await file.json()) as Meta) : undefined;
  }
}

/** Streams are written chunk by chunk: Bun.write(path, new Response(stream)) never settles in Bun 1.3.11. */
async function writeFile(path: string, body: StorageBody): Promise<void> {
  if (!(body instanceof ReadableStream)) {
    await Bun.write(path, body);
    return;
  }
  const sink = Bun.file(path).writer();
  const reader = body.getReader();
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) await sink.write(chunk.value);
  } finally {
    await sink.end();
  }
}

async function fileEtag(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("md5");
  const reader = Bun.file(path).stream().getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) hasher.update(chunk.value);
  return `"${hasher.digest("hex")}"`;
}

async function walk(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const keys: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (directory === root && RESERVED.includes(entry.name)) continue;
    if (entry.isDirectory()) keys.push(...(await walk(root, path)));
    else if (entry.isFile()) keys.push(relative(root, path).split(sep).join("/"));
  }
  return keys;
}
