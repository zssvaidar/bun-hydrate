import { describe, expect, test } from "bun:test";
import { startFakeS3 } from "@bun-hydrate/testing/s3";
import { storageContract } from "@bun-hydrate/testing/storage";
import { S3Storage } from "../src";

storageContract("s3 (fake server)", () => {
  const s3 = startFakeS3();
  return { storage: new S3Storage(s3), cleanup: () => s3.stop() };
});

// TEST_S3_URL=http://ACCESS_KEY:SECRET@host:port/bucket runs the contract against a real store (MinIO, AWS, R2).
if (process.env.TEST_S3_URL) {
  storageContract("s3 (TEST_S3_URL)", () => {
    const url = new URL(process.env.TEST_S3_URL!);
    const bucket = url.pathname.slice(1);
    const scope = `test-${crypto.randomUUID()}`;
    const storage = new S3Storage({
      bucket,
      endpoint: `${url.protocol}//${url.host}`,
      accessKeyId: decodeURIComponent(url.username),
      secretAccessKey: decodeURIComponent(url.password),
      region: url.searchParams.get("region") ?? "us-east-1",
    });
    return {
      storage: storage.scope(scope),
      cleanup: async () => {
        for (let page = await storage.list(`${scope}/`); page.items.length > 0; page = await storage.list(`${scope}/`)) {
          for (const item of page.items) await storage.delete(item.key);
        }
      },
    };
  });
}

describe("S3Storage specifics", () => {
  test("signed URLs are presigned by the store and served by it", async () => {
    const s3 = startFakeS3();
    const storage = new S3Storage(s3);
    await storage.put("reports/q1.pdf", "%PDF-1.7", { contentType: "application/pdf" });

    const url = await storage.signedUrl("reports/q1.pdf", { expiresIn: "5m", download: "Q1 report.pdf" });
    expect(url).toStartWith(`${s3.endpoint}/${s3.bucket}/reports/q1.pdf?`);
    const res = await fetch(url);
    expect(await res.text()).toBe("%PDF-1.7");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Q1_report.pdf"`);
    await s3.stop();
  });

  test("an expired presigned URL is refused by the store", async () => {
    let now = Date.now();
    const s3 = startFakeS3({ now: () => now });
    const storage = new S3Storage(s3);
    await storage.put("a.txt", "x");
    const url = await storage.signedUrl("a.txt", { expiresIn: "1m" });

    now += 5 * 60_000;
    expect((await fetch(url)).status).toBe(403);
    await s3.stop();
  });
});
