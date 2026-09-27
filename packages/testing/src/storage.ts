import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StorageKeyError, type Storage } from "@bun-hydrate/storage";

export interface StorageContractTarget {
  storage: Storage;
  cleanup?: () => Promise<void>;
}

/** Content types without parameters: some stores add ";charset=utf-8" to text. */
const mime = (type: string | undefined) => type?.split(";")[0]?.trim();

/**
 * The behaviour every storage adapter must have (spec-6 §7.2). Run it for your own adapter:
 * `storageContract("gcs", async () => ({ storage: new GcsStorage(…) }))`.
 */
export function storageContract(name: string, create: () => StorageContractTarget | Promise<StorageContractTarget>): void {
  describe(`storage contract: ${name}`, () => {
    let target: StorageContractTarget;
    let storage: Storage;

    beforeEach(async () => {
      target = await create();
      storage = target.storage;
    });
    afterEach(() => target.cleanup?.());

    test("stores and returns text with its content type", async () => {
      const info = await storage.put("notes/hello.txt", "hello ✓", { contentType: "text/plain" });
      expect(info).toMatchObject({ key: "notes/hello.txt", size: Buffer.byteLength("hello ✓") });

      const file = await storage.get("notes/hello.txt");
      expect(await file!.text()).toBe("hello ✓");
      expect(mime(file!.contentType)).toBe("text/plain");
      expect(file!.lastModified).toBeInstanceOf(Date);
    });

    test("round-trips binary exactly, taking the type from a Blob", async () => {
      const bytes = new Uint8Array(256).map((_, i) => i);
      await storage.put("bin/all-bytes", new Blob([bytes], { type: "image/png" }));

      const file = await storage.get("bin/all-bytes");
      expect([...(await file!.bytes())]).toEqual([...bytes]);
      expect(mime(file!.contentType)).toBe("image/png");
    });

    test("streams a 10 MB body in and out", async () => {
      const chunk = new Uint8Array(1024 * 1024).fill(7);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 10; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      await storage.put("big/ten-megabytes.bin", body, { contentType: "application/octet-stream" });

      const file = await storage.get("big/ten-megabytes.bin");
      let total = 0;
      const reader = file!.body.getReader();
      for (let part = await reader.read(); !part.done; part = await reader.read()) total += part.value.byteLength;
      expect(total).toBe(10 * 1024 * 1024);
      expect((await storage.head("big/ten-megabytes.bin"))!.size).toBe(10 * 1024 * 1024);
    }, 30_000);

    test("Unicode keys work and are NFC-normalized", async () => {
      await storage.put("photos/café ☕.txt", "coffee");
      expect(await (await storage.get("photos/café ☕.txt"))!.text()).toBe("coffee");
    });

    test("missing keys: get and head are null, exists is false, delete is fine", async () => {
      expect(await storage.get("nothing/here")).toBeNull();
      expect(await storage.head("nothing/here")).toBeNull();
      expect(await storage.exists("nothing/here")).toBe(false);
      await storage.delete("nothing/here");
    });

    test("overwriting replaces the content and changes the etag; delete removes it", async () => {
      const first = await storage.put("doc.txt", "one");
      const second = await storage.put("doc.txt", "two!");
      expect(second.etag).not.toBe(first.etag);
      expect(await (await storage.get("doc.txt"))!.text()).toBe("two!");

      await storage.delete("doc.txt");
      expect(await storage.exists("doc.txt")).toBe(false);
    });

    test("list is ordered, isolated by prefix, and paginates", async () => {
      for (const key of ["a/3", "a/1", "a/2", "ab/1", "b/1"]) await storage.put(key, key);

      const first = await storage.list("a/", { limit: 2 });
      expect(first.items.map((item) => item.key)).toEqual(["a/1", "a/2"]);
      const second = await storage.list("a/", { limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((item) => item.key)).toEqual(["a/3"]);
      expect(second.nextCursor).toBeNull();
      expect(second.items[0]).toMatchObject({ size: 3 });
    });

    test.each([
      ["", "is empty"],
      ["/etc/passwd", "starts with /"],
      ["a/../b", "segment"],
      ["./a", "segment"],
      ["a//b", "segment"],
      ["a\\b", "contains \\"],
      ["a\u0000b", "control characters"],
      ["x".repeat(1025), "longer than 1024 bytes"],
    ])("refuses the key %j", async (key, message) => {
      const error = await storage.put(key, "x").catch((e) => e);
      expect(error).toBeInstanceOf(StorageKeyError);
      expect(error.message).toContain(message);
    });

    test("key() joins segments and refuses segments containing /", () => {
      expect(storage.key("avatars", "u1", "original.png")).toBe("avatars/u1/original.png");
      expect(() => storage.key("avatars", "../u1")).toThrow(StorageKeyError);
    });

    test("scope() keeps keys under a prefix and hides it", async () => {
      const avatars = storage.scope("avatars");
      const info = await avatars.put("u1.png", "img");

      expect(info.key).toBe("u1.png");
      expect(await (await storage.get("avatars/u1.png"))!.text()).toBe("img");
      expect((await avatars.list()).items.map((item) => item.key)).toEqual(["u1.png"]);
    });

    test("signedUrl() returns a URL for the object", async () => {
      await storage.put("share/report.pdf", "%PDF-1.7");
      expect(typeof (await storage.signedUrl("share/report.pdf", { expiresIn: "5m" }))).toBe("string");
    });
  });
}
