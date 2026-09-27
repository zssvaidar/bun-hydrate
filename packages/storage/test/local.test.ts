import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, createLogger } from "@bun-hydrate/core";
import { storageContract } from "@bun-hydrate/testing/storage";
import { LocalStorage, StorageKeyError, storageRoutes } from "../src";

const SIGNING_KEY = "k".repeat(32);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "hydrate-storage-"));
  roots.push(root);
  return root;
}

storageContract("local", async () => {
  const root = await mkdtemp(join(tmpdir(), "hydrate-storage-"));
  return { storage: new LocalStorage({ root, signingKey: SIGNING_KEY }), cleanup: () => rm(root, { recursive: true, force: true }) };
});

describe("LocalStorage specifics", () => {
  test("writes are atomic: readers see the old content until the new one is complete", async () => {
    const storage = new LocalStorage({ root: await tempRoot(), signingKey: SIGNING_KEY });
    await storage.put("doc.txt", "old");

    let finish!: () => void;
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("new, "));
        await new Promise<void>((resolve) => (finish = resolve));
        controller.enqueue(new TextEncoder().encode("complete"));
        controller.close();
      },
    });
    const writing = storage.put("doc.txt", slow);
    await Bun.sleep(20);
    expect(await (await storage.get("doc.txt"))!.text()).toBe("old");

    finish();
    await writing;
    expect(await (await storage.get("doc.txt"))!.text()).toBe("new, complete");
  });

  test("a symlink inside the root cannot lead outside it", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(root, "escape"));
    const storage = new LocalStorage({ root, signingKey: SIGNING_KEY });

    const error = await storage.put("escape/owned.txt", "x").catch((e) => e);
    expect(error).toBeInstanceOf(StorageKeyError);
    expect(error.message).toContain("outside the storage root");
    expect(await Bun.file(join(outside, "owned.txt")).exists()).toBe(false);
  });

  test("keys under the adapter's own .meta/ and .tmp/ are refused", async () => {
    const storage = new LocalStorage({ root: await tempRoot(), signingKey: SIGNING_KEY });
    expect(storage.put(".meta/x", "x")).rejects.toThrow("reserved");
    expect(storage.put(".tmp/x", "x")).rejects.toThrow("reserved");
  });

  test("needs a signing key of at least 32 characters", async () => {
    expect(() => new LocalStorage({ root: "/tmp/x", signingKey: "short" })).toThrow("signingKey must be at least 32 characters");
  });
});

describe("storageRoutes(): serving signed URLs (spec-6 §7.3)", () => {
  let storage: LocalStorage;
  let app: App;
  let now: number;

  beforeEach(async () => {
    now = Date.UTC(2026, 0, 1);
    storage = new LocalStorage({ root: await tempRoot(), signingKey: SIGNING_KEY, baseUrl: "/files", now: () => now });
    app = new App({ logger: createLogger({ level: "silent" }), health: false }).route("/files", storageRoutes(storage));
  });

  const fetchUrl = (url: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://localhost${url}`, { headers }));

  test("serves the object with hardened headers", async () => {
    await storage.put("avatars/ada.png", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
    const url = await storage.signedUrl("avatars/ada.png", { expiresIn: "10m" });
    expect(url).toStartWith("/files/avatars/ada.png?expires=");

    const res = await fetchUrl(url);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("anything that could render as a page is a download, never inline", async () => {
    await storage.put("uploads/page.html", "<script>steal()</script>", { contentType: "text/html" });
    const res = await fetchUrl(await storage.signedUrl("uploads/page.html", { expiresIn: "10m" }));
    expect(res.headers.get("content-disposition")).toBe("attachment");

    await storage.put("reports/q1.pdf", "%PDF-1.7");
    const named = await fetchUrl(await storage.signedUrl("reports/q1.pdf", { expiresIn: "10m", download: "Q1 report.pdf" }));
    expect(named.headers.get("content-disposition")).toBe(`attachment; filename="Q1_report.pdf"`);
  });

  test("tampered and expired URLs are refused", async () => {
    await storage.put("private/a.txt", "secret");
    await storage.put("private/b.txt", "other secret");
    const url = await storage.signedUrl("private/a.txt", { expiresIn: "1m" });

    expect((await fetchUrl(url.replace("a.txt", "b.txt"))).status).toBe(403);
    expect((await fetchUrl(url.replace(/sig=[^&]+/, "sig=AAAA"))).status).toBe(403);
    expect((await fetchUrl(url.replace(/expires=\d+/, `expires=${Math.floor(now / 1000) + 99999}`))).status).toBe(403);
    expect((await fetchUrl("/files/private/a.txt")).status).toBe(403);

    now += 61_000;
    const expired = await fetchUrl(url);
    expect(expired.status).toBe(403);
    expect((await expired.json()).error.code).toBe("SIGNED_URL_EXPIRED");
  });

  test("Range requests get partial content; If-None-Match gets 304", async () => {
    await storage.put("media/clip.txt", "0123456789", { contentType: "text/plain" });
    const url = await storage.signedUrl("media/clip.txt", { expiresIn: "10m" });

    const partial = await fetchUrl(url, { range: "bytes=2-5" });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("2345");
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await (await fetchUrl(url, { range: "bytes=-3" })).text()).toBe("789");
    expect((await fetchUrl(url, { range: "bytes=20-30" })).status).toBe(416);

    const etag = (await fetchUrl(url)).headers.get("etag")!;
    expect((await fetchUrl(url, { "if-none-match": etag })).status).toBe(304);
  });

  test("a signed URL for a key that no longer exists is a 404", async () => {
    await storage.put("gone.txt", "x");
    const url = await storage.signedUrl("gone.txt", { expiresIn: "10m" });
    await storage.delete("gone.txt");
    expect((await fetchUrl(url)).status).toBe(404);
  });
});
