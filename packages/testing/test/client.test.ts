import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "../src/index";

function createApp() {
  return new App({ logger: createLogger({ level: "silent" }), health: false })
    .get("/users/:id", (ctx) => ({ id: ctx.params.id, page: ctx.query.get("page") }))
    .post("/users", async (ctx) => {
      ctx.status(201);
      return { received: await ctx.body.json(), contentType: ctx.headers.get("content-type") };
    })
    .post("/text", async (ctx) => ctx.body.text())
    .post("/form", async (ctx) => ({ name: (await ctx.body.formData()).get("name") }))
    .get("/whoami", (ctx) => ctx.headers.get("authorization") ?? "anonymous");
}

describe("createTestClient", () => {
  test("sends requests in process and returns standard Responses", async () => {
    const res = await createTestClient(createApp()).get("/users/42");

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42", page: null });
  });

  test("json() sends a JSON body with the right content type", async () => {
    const res = await createTestClient(createApp()).post("/users").json({ name: "Test User" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      received: { name: "Test User" },
      contentType: "application/json",
    });
  });

  test("query(), header(), text() and form()", async () => {
    const client = createTestClient(createApp());
    const form = new FormData();
    form.set("name", "Ada");

    expect(await (await client.get("/users/1").query({ page: 2 })).json()).toEqual({ id: "1", page: "2" });
    expect(await (await client.get("/whoami").header("authorization", "Bearer t")).text()).toBe("Bearer t");
    expect(await (await client.post("/text").text("plain")).text()).toBe("plain");
    expect(await (await client.post("/form").form(form)).json()).toEqual({ name: "Ada" });
  });

  test("default headers apply to every request", async () => {
    const client = createTestClient(createApp(), { headers: { authorization: "Bearer default" } });
    expect(await (await client.get("/whoami")).text()).toBe("Bearer default");
  });

  test("supports every HTTP method", async () => {
    const client = createTestClient(createApp());
    const methods = [client.put("/x"), client.patch("/x"), client.delete("/x"), client.head("/x"), client.options("/x")];
    const statuses = await Promise.all(methods.map(async (req) => (await req).status));

    expect(statuses).toEqual([404, 404, 404, 404, 404]);
  });

  test("accepts a bare fetch function", async () => {
    const res = await createTestClient((req: Request) => new Response(new URL(req.url).pathname)).get("/raw");
    expect(await res.text()).toBe("/raw");
  });
});

describe("v0.3 client helpers", () => {
  function sessionApp() {
    return new App({ logger: createLogger({ level: "silent" }), health: false, securityHeaders: false })
      .post("/login", (ctx) => {
        ctx.cookies.set("sid", "abc");
        return "in";
      })
      .post("/logout", (ctx) => {
        ctx.cookies.delete("sid");
        return "out";
      })
      .get("/whoami", (ctx) => ({ sid: ctx.cookies.get("sid"), ip: ctx.ip, auth: ctx.headers.get("authorization") }));
  }

  test("cookies: true keeps a cookie jar across requests, honouring deletion", async () => {
    const client = createTestClient(sessionApp(), { cookies: true });

    await client.post("/login");
    expect((await (await client.get("/whoami")).json()).sid).toBe("abc");
    expect(client.cookies.get("sid")).toBe("abc");

    await client.post("/logout");
    expect((await (await client.get("/whoami")).json()).sid).toBeNull();
    expect(client.cookies.get("sid")).toBeUndefined();
  });

  test("without a jar, cookies are not remembered", async () => {
    const client = createTestClient(sessionApp());
    await client.post("/login");
    expect((await (await client.get("/whoami")).json()).sid).toBeNull();
  });

  test(".ip() sets the client address and .bearer() the Authorization header", async () => {
    const body = await (await createTestClient(sessionApp()).get("/whoami").ip("203.0.113.9").bearer("t0k")).json();
    expect(body).toMatchObject({ ip: "203.0.113.9", auth: "Bearer t0k" });
  });
});
