import { describe, expect, test } from "bun:test";
import { App } from "../src/app";
import { createLogger } from "../src/logger";
import { bodyLimit, parseSize, safeFileName } from "../src/upload";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const PDF = new TextEncoder().encode("%PDF-1.7\n...");

function app() {
  return new App({ logger: createLogger({ level: "silent" }), health: false, securityHeaders: false, maxBodySize: "4kb" })
    .post("/avatar", async (ctx) => {
      const file = await ctx.upload("avatar", { types: ["image/png", "image/jpeg"], maxSize: "100b" });
      return { name: file.name, originalName: file.originalName, type: file.type, size: file.size };
    })
    .post("/docs", async (ctx) => {
      const files = await ctx.uploads("docs", { types: ["application/pdf", "text/plain"], maxFiles: 2 });
      return files.map((file) => ({ name: file.name, type: file.type }));
    })
    .post("/small", bodyLimit("100b"), async (ctx) => ({ length: (await ctx.body.text()).length }));
}

function form(entries: [string, Blob, string][]) {
  const data = new FormData();
  for (const [field, blob, name] of entries) data.append(field, blob, name);
  return data;
}

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app().fetch(new Request(`http://localhost${path}`, { method: "POST", body, headers }));

const details = async (response: Response) => (await response.json()).error.details;

describe("ctx.upload()", () => {
  test("accepts an allowed type, judged by the bytes, not the declared type or name", async () => {
    const res = await post("/avatar", form([["avatar", new Blob([PNG], { type: "application/octet-stream" }), "../../me.PNG"]]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "me.PNG", originalName: "../../me.PNG", type: "image/png", size: PNG.length });
  });

  test("refuses content that is not an allowed type, whatever it claims to be", async () => {
    const fake = new Blob(["<script>alert(1)</script>"], { type: "image/png" });
    const res = await post("/avatar", form([["avatar", fake, "avatar.png"]]));
    expect(res.status).toBe(422);
    expect(await details(res)).toEqual([{ location: "body", path: "avatar", message: "must be one of: image/png, image/jpeg" }]);
  });

  test("refuses files over maxSize, missing files, and several files where one is expected", async () => {
    const big = new Uint8Array(200);
    big.set(PNG);
    expect(await details(await post("/avatar", form([["avatar", new Blob([big]), "big.png"]])))).toEqual([
      { location: "body", path: "avatar", message: "must be at most 100 B" },
    ]);
    expect(await details(await post("/avatar", form([["other", new Blob([PNG]), "x.png"]])))).toEqual([
      { location: "body", path: "avatar", message: "is required" },
    ]);
    const two = form([["avatar", new Blob([PNG]), "a.png"], ["avatar", new Blob([JPEG]), "b.jpg"]]);
    expect(await details(await post("/avatar", two))).toEqual([{ location: "body", path: "avatar", message: "expects one file" }]);
  });

  test("a request that is not a form is a clear 400", async () => {
    const res = await post("/avatar", JSON.stringify({ avatar: "x" }), { "content-type": "application/json" });
    expect(res.status).toBe(400);
  });
});

describe("ctx.uploads()", () => {
  test("accepts several files; text types must be valid UTF-8 text", async () => {
    const ok = await post("/docs", form([["docs", new Blob([PDF]), "a.pdf"], ["docs", new Blob(["notes ✓"], { type: "text/plain" }), "b.txt"]]));
    expect(await ok.json()).toEqual([
      { name: "a.pdf", type: "application/pdf" },
      { name: "b.txt", type: "text/plain;charset=utf-8" }, // Bun adds the charset, which the UTF-8 check confirmed
    ]);

    const binary = await post("/docs", form([["docs", new Blob([new Uint8Array([0, 159, 146, 150])], { type: "text/plain" }), "c.txt"]]));
    expect(await details(binary)).toEqual([{ location: "body", path: "docs", message: "must be one of: application/pdf, text/plain" }]);
  });

  test("refuses more than maxFiles", async () => {
    const three = form([["docs", new Blob([PDF]), "1.pdf"], ["docs", new Blob([PDF]), "2.pdf"], ["docs", new Blob([PDF]), "3.pdf"]]);
    expect(await details(await post("/docs", three))).toEqual([{ location: "body", path: "docs", message: "expects at most 2 files" }]);
  });
});

describe("body size limits", () => {
  test("bodies over the app's maxBodySize are refused with 413 before they are read", async () => {
    const res = await post("/small", "x".repeat(5000));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("bodyLimit() lowers the limit for one route, also for bodies without Content-Length", async () => {
    expect(await (await post("/small", "x".repeat(50))).json()).toEqual({ length: 50 });
    expect((await post("/small", "x".repeat(150))).status).toBe(413);

    const chunked = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode("x".repeat(40)));
        controller.close();
      },
    });
    expect((await post("/small", chunked)).status).toBe(413);
  });
});

describe("helpers", () => {
  test("parseSize", () => {
    expect([parseSize(512), parseSize("100b"), parseSize("2kb"), parseSize("1.5mb"), parseSize("1gb")]).toEqual([512, 100, 2048, 1572864, 1073741824]);
    expect(() => parseSize("lots" as never)).toThrow('Invalid size "lots"');
  });

  test.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\ada\\photo.jpg", "photo.jpg"],
    ["my résumé (final).pdf", "my_r_sum_final_.pdf"],
    ["\u0000\u001f..hidden", "hidden"],
    ["", "file"],
    [`${"a".repeat(300)}.png`, `${"a".repeat(96)}.png`],
  ])("safeFileName(%j) → %j", (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });
});
