import type { ModuleNames } from "./names";

export function middlewareFiles(n: ModuleNames): Record<string, string> {
  return {
    [`${n.kebab}.ts`]: `import type { Middleware } from "@bun-hydrate/core";

export function ${n.camel}(): Middleware {
  return async (ctx, next) => {
    // Runs before the route. Return a Response here to short-circuit.
    const response = await next();
    // Runs after the route. \`response\` is always a Response, even when the route threw.
    return response;
  };
}
`,
    [`${n.kebab}.test.ts`]: `import { describe, expect, test } from "bun:test";
import { App, createLogger } from "@bun-hydrate/core";
import { createTestClient } from "@bun-hydrate/testing";
import { ${n.camel} } from "./${n.kebab}";

describe("${n.camel}", () => {
  test("passes requests through to the route", async () => {
    const app = new App({ logger: createLogger({ level: "silent" }), health: false })
      .use(${n.camel}())
      .get("/", () => "ok");

    const res = await createTestClient(app).get("/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
`,
  };
}
