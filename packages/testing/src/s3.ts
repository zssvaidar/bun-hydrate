interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  contentDisposition?: string;
  etag: string;
  lastModified: Date;
}

interface Upload {
  key: string;
  contentType: string;
  contentDisposition?: string;
  parts: Map<number, Uint8Array>;
}

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  objects: Map<string, StoredObject>;
  stop(): Promise<void>;
}

export interface FakeS3Options {
  bucket?: string;
  /** The server's clock, for presigned URL expiry. Default: Date.now. */
  now?: () => number;
}

const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const error = (status: number, code: string, message: string) => xml(`<Error><Code>${code}</Code><Message>${escape(message)}</Message></Error>`, status);
const md5 = (bytes: Uint8Array) => `"${new Bun.CryptoHasher("md5").update(bytes).digest("hex")}"`;

/**
 * The part of the S3 REST API that Bun's S3Client uses (spec-6 §7.2): put, multipart upload, head,
 * ranged get, delete, ListObjectsV2 and presigned GET expiry. Path-style, no auth checks: for tests.
 */
export function startFakeS3(options: FakeS3Options = {}): FakeS3 {
  const bucket = options.bucket ?? "test-bucket";
  const now = options.now ?? Date.now;
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, Upload>();

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const [, bucketName = "", ...rest] = url.pathname.split("/");
      if (bucketName !== bucket) return error(404, "NoSuchBucket", `No bucket ${bucketName}`);
      const key = rest.map(decodeURIComponent).join("/");
      const query = url.searchParams;

      if (key === "" && request.method === "GET") return list(query);

      switch (request.method) {
        case "PUT": {
          const bytes = new Uint8Array(await request.arrayBuffer());
          const uploadId = query.get("uploadId");
          if (uploadId) {
            const upload = uploads.get(uploadId);
            if (!upload) return error(404, "NoSuchUpload", uploadId);
            upload.parts.set(Number(query.get("partNumber")), bytes);
            return new Response(null, { headers: { etag: md5(bytes) } });
          }
          const object = store(key, bytes, request.headers.get("content-type"), request.headers.get("content-disposition"));
          return new Response(null, { headers: { etag: object.etag } });
        }
        case "POST": {
          if (query.has("uploads")) {
            const uploadId = crypto.randomUUID();
            uploads.set(uploadId, {
              key,
              contentType: request.headers.get("content-type") ?? "application/octet-stream",
              contentDisposition: request.headers.get("content-disposition") ?? undefined,
              parts: new Map(),
            });
            return xml(`<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
          }
          const upload = uploads.get(query.get("uploadId") ?? "");
          if (!upload) return error(404, "NoSuchUpload", "unknown upload");
          await request.arrayBuffer();
          const parts = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes);
          const object = store(key, new Uint8Array(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer()), upload.contentType, upload.contentDisposition ?? null);
          uploads.delete(query.get("uploadId")!);
          return xml(`<CompleteMultipartUploadResult><Key>${escape(key)}</Key><ETag>${object.etag}</ETag></CompleteMultipartUploadResult>`);
        }
        case "HEAD": {
          const object = objects.get(key);
          return object ? new Response(null, { headers: headersOf(object) }) : new Response(null, { status: 404 });
        }
        case "GET": {
          const expires = query.get("X-Amz-Expires");
          const date = query.get("X-Amz-Date");
          if (expires && date && signedAt(date) + Number(expires) * 1000 < now()) return error(403, "AccessDenied", "Request has expired");
          const object = objects.get(key);
          if (!object) return error(404, "NoSuchKey", "The specified key does not exist.");
          const headers = headersOf(object);
          const disposition = query.get("response-content-disposition");
          if (disposition) headers.set("content-disposition", disposition);
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Number(range[2]) : object.bytes.length - 1;
            headers.set("content-range", `bytes ${start}-${end}/${object.bytes.length}`);
            headers.set("content-length", String(end - start + 1));
            return new Response(object.bytes.slice(start, end + 1), { status: 206, headers });
          }
          return new Response(object.bytes as Uint8Array<ArrayBuffer>, { headers });
        }
        case "DELETE": {
          if (query.has("uploadId")) uploads.delete(query.get("uploadId")!);
          else objects.delete(key);
          return new Response(null, { status: 204 });
        }
        default:
          return error(405, "MethodNotAllowed", request.method);
      }
    },
  });

  function store(key: string, bytes: Uint8Array, contentType: string | null, contentDisposition: string | null): StoredObject {
    const object: StoredObject = {
      bytes,
      contentType: contentType ?? "application/octet-stream",
      etag: md5(bytes),
      lastModified: new Date(Math.floor(now() / 1000) * 1000),
      ...(contentDisposition ? { contentDisposition } : {}),
    };
    objects.set(key, object);
    return object;
  }

  function list(query: URLSearchParams): Response {
    const prefix = query.get("prefix") ?? "";
    const after = query.get("continuation-token") ?? query.get("start-after") ?? "";
    const max = Number(query.get("max-keys") ?? 1000);
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && key > after).sort();
    const page = keys.slice(0, max);
    const truncated = keys.length > max;
    const contents = page
      .map((key) => {
        const object = objects.get(key)!;
        return `<Contents><Key>${escape(key)}</Key><Size>${object.bytes.length}</Size><ETag>${escape(object.etag)}</ETag><LastModified>${object.lastModified.toISOString()}</LastModified></Contents>`;
      })
      .join("");
    return xml(
      `<ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${escape(page.at(-1)!)}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`,
    );
  }

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    bucket,
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test-secret",
    objects,
    stop: async () => void server.stop(true),
  };
}

function headersOf(object: StoredObject): Headers {
  return new Headers({
    "content-type": object.contentType,
    "content-length": String(object.bytes.length),
    etag: object.etag,
    "last-modified": object.lastModified.toUTCString(),
    ...(object.contentDisposition ? { "content-disposition": object.contentDisposition } : {}),
  });
}

/** "20260927T122340Z" → epoch ms. */
function signedAt(date: string): number {
  const [, y, mo, d, h, mi, s] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date) ?? [];
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}
