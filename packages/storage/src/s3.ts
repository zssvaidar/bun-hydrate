import { S3Client } from "bun";
import { parseDuration, safeFileName } from "@bun-hydrate/core";
import { StorageBase, type ListPage, type ObjectInfo, type PutOptions, type SignedUrlOptions, type StorageBody, type StoredFile } from "./storage";

export interface S3StorageOptions {
  bucket: string;
  /** Default: S3_REGION / AWS_REGION, as Bun's S3Client reads them. */
  region?: string;
  /** For S3-compatible stores (MinIO, R2, …). Default: AWS. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Or bring a configured client. */
  client?: S3Client;
}

const isMissing = (error: unknown) => (error as { code?: string } | undefined)?.code === "NoSuchKey";

/**
 * S3 and S3-compatible stores through Bun's built-in S3Client (spec-6 §7.2). Streams upload in
 * parts; signed URLs are S3 presigned URLs, so files are served by the store, not the app.
 */
export class S3Storage extends StorageBase {
  private readonly client: S3Client;

  constructor(options: S3StorageOptions) {
    super();
    this.client =
      options.client ??
      new S3Client({
        bucket: options.bucket,
        region: options.region,
        endpoint: options.endpoint,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      });
  }

  protected async write(key: string, body: StorageBody, options: PutOptions & { contentType: string }): Promise<ObjectInfo> {
    await this.client.write(key, body instanceof ReadableStream ? new Response(body) : body, {
      type: options.contentType,
      ...(options.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
    });
    return (await this.stat(key))!;
  }

  protected async read(key: string): Promise<StoredFile | null> {
    const info = await this.stat(key);
    if (!info) return null;
    const file = this.client.file(key);
    return { ...info, body: file.stream(), text: () => file.text(), bytes: () => file.bytes() };
  }

  protected async stat(key: string): Promise<ObjectInfo | null> {
    try {
      const stats = await this.client.stat(key);
      return { key, size: stats.size, contentType: stats.type, etag: stats.etag, lastModified: stats.lastModified };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  protected async remove(key: string): Promise<void> {
    await this.client.delete(key);
  }

  protected async listKeys(prefix: string, cursor: string | undefined, limit: number): Promise<ListPage> {
    const result = await this.client.list({ prefix, maxKeys: limit, ...(cursor ? { startAfter: cursor } : {}) });
    const items = (result.contents ?? []).map((object) => ({
      key: object.key,
      size: object.size ?? 0,
      etag: object.eTag ?? "",
      lastModified: new Date(object.lastModified ?? 0),
    }));
    return { items, nextCursor: result.isTruncated ? (items.at(-1)?.key ?? null) : null };
  }

  protected async sign(key: string, { expiresIn, download }: SignedUrlOptions): Promise<string> {
    return this.client.presign(key, {
      expiresIn: Math.max(1, Math.floor(parseDuration(expiresIn) / 1000)),
      ...(download ? { contentDisposition: `attachment; filename="${safeFileName(download)}"` } : {}),
    });
  }
}
