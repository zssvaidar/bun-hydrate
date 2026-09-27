import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { createReactRenderer } from "../src/renderer";
import { pages } from "./fixtures/pages";

const assets = { scripts: ["/assets/client-abc.js"] };

function createApp() {
  const react = createReactRenderer({ pages, assets, onError: () => {} });
  const app = new App({ logger: createLogger({ level: "silent" }), health: false })
    .get("/hello/:name", (ctx) => react.render("Greeting", { name: ctx.params.name, items: ["a", "b"] }, { title: "Hi <you>" }))
    .get("/evil", () =>
      react.render("Greeting", { name: "</script><script>alert(1)</script>", items: [] }, { title: "evil" }),
    )
    .get("/created", () => react.render("Greeting", { name: "x", items: [] }, { status: 201 }))
    .get("/boom", () => react.render("Boom", {} as never));
  return createTestClient(app);
}

function payloadOf(html: string) {
  const match = html.match(/<script type="application\/json" id="__HYDRATE__">(.*?)<\/script>/s);
  if (!match) throw new Error("payload script not found");
  return JSON.parse(match[1]!);
}

describe("createReactRenderer", () => {
  test("streams a complete HTML document with the server-rendered page", async () => {
    const res = await createApp().get("/hello/Ada");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain('<div id="app"><main><h1>Hello, <!-- -->Ada</h1>');
    expect(html).toEndWith("</html>");
  });

  test("escapes the title", async () => {
    const html = await (await createApp().get("/hello/Ada")).text();
    expect(html).toContain("<title>Hi &lt;you&gt;</title>");
  });

  test("embeds the page name and props for hydration", async () => {
    const html = await (await createApp().get("/hello/Ada")).text();
    expect(payloadOf(html)).toEqual({ page: "Greeting", props: { name: "Ada", items: ["a", "b"] } });
  });

  test("loads the client bundle as a module script after the payload", async () => {
    const html = await (await createApp().get("/hello/Ada")).text();

    expect(html).toContain('<script type="module" src="/assets/client-abc.js"></script>');
    expect(html.indexOf("__HYDRATE__")).toBeLessThan(html.indexOf("/assets/client-abc.js"));
  });

  test("props cannot break out of the payload script (FR-225)", async () => {
    const html = await (await createApp().get("/evil")).text();

    expect(html.match(/<script/g)).toHaveLength(2);
    expect(payloadOf(html).props.name).toBe("</script><script>alert(1)</script>");
  });

  test("supports a custom status", async () => {
    expect((await createApp().get("/created")).status).toBe(201);
  });

  test("render errors become normal 500 responses", async () => {
    const res = await createApp().get("/boom");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  test("page names and props are type-checked (checked by tsc)", () => {
    const react = createReactRenderer({ pages, assets });
    // @ts-expect-error — unknown page
    void (() => react.render("Nope", {}));
    // @ts-expect-error — wrong props for Greeting
    void (() => react.render("Greeting", { name: 1, items: [] }));
  });
});

describe("shared per-request data (spec-5 §8.1)", () => {
  function createApp() {
    const react = createReactRenderer({
      pages,
      assets,
      onError: () => {},
      shared: (ctx) => ({ auth: { user: ctx.headers.get("x-user") ? { id: ctx.headers.get("x-user") } : null, permissions: [] } }),
    });
    const app = new App({ logger: createLogger({ level: "silent" }), health: false })
      .get("/with-ctx", (ctx) => react.render("Greeting", { name: "x", items: [] }, { ctx }))
      .get("/without-ctx", () => react.render("Greeting", { name: "x", items: [] }));
    return createTestClient(app);
  }

  test("render(…, { ctx }) adds the shared data to the payload", async () => {
    const html = await (await createApp().get("/with-ctx").header("x-user", "u1")).text();
    expect(payloadOf(html)).toEqual({
      page: "Greeting",
      props: { name: "x", items: [] },
      shared: { auth: { user: { id: "u1" }, permissions: [] } },
    });
  });

  test("without ctx the payload is unchanged", async () => {
    const html = await (await createApp().get("/without-ctx")).text();
    expect(payloadOf(html)).toEqual({ page: "Greeting", props: { name: "x", items: [] } });
  });

  test("wrap(page, shared) wraps the server render too, so hydration matches", async () => {
    const react = createReactRenderer({
      pages,
      assets,
      shared: () => ({ theme: "dark" }),
      wrap: (page, shared) => <div data-theme={String(shared.theme)}>{page}</div>,
    });
    const app = new App({ logger: createLogger({ level: "silent" }), health: false }).get("/", (ctx) =>
      react.render("Greeting", { name: "x", items: [] }, { ctx }),
    );
    const html = await (await createTestClient(app).get("/")).text();

    expect(html).toContain('<div id="app"><div data-theme="dark"><main>');
  });
});
