import { parseDuration } from "@bun-hydrate/core";
import { StorageBase, md5Etag, toBytes, type ListPage, type ObjectInfo, type PutOptions, type SignedUrlOptions, type StorageBody, type StoredFile } from "./storage";

/** Objects in memory: for tests and the contract suite. Signed URLs are memory:// placeholders. */
export class MemoryStorage extends StorageBase {
  private readonly objects = new Map<string, { bytes: Uint8Array; info: ObjectInfo }>();

  protected async write(key: string, body: StorageBody, options: PutOptions & { contentType: string }): Promise<ObjectInfo> {
    const bytes = await toBytes(body);
    const info: ObjectInfo = {
      key,
      size: bytes.byteLength,
      contentType: options.contentType,
      etag: md5Etag(bytes),
      lastModified: new Date(),
      ...(options.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
    };
    this.objects.set(key, { bytes: bytes.slice(), info });
    return { ...info };
  }

  protected async read(key: string): Promise<StoredFile | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const blob = new Blob([object.bytes as Uint8Array<ArrayBuffer>]);
    return { ...object.info, body: blob.stream(), text: () => blob.text(), bytes: async () => new Uint8Array(await blob.arrayBuffer()) };
  }

  protected async stat(key: string): Promise<ObjectInfo | null> {
    const object = this.objects.get(key);
    return object ? { ...object.info } : null;
  }

  protected async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  protected async listKeys(prefix: string, cursor: string | undefined, limit: number): Promise<ListPage> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor)).sort();
    const items = keys.slice(0, limit).map((key) => ({ ...this.objects.get(key)!.info }));
    return { items, nextCursor: keys.length > limit ? items.at(-1)!.key : null };
  }

  protected async sign(key: string, { expiresIn }: SignedUrlOptions): Promise<string> {
    return `memory://${encodeURI(key)}?expires=${Date.now() + parseDuration(expiresIn)}`;
  }
}
