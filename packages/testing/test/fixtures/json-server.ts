import { App, createLogger } from "@bun-hydrate/core";

const app = new App({ logger: createLogger({ format: "json" }) }).get("/", () => "spawned");

if (process.env.FAIL_ON_START === "1") {
  console.error("refusing to start");
  process.exit(3);
}

await app.listen({ port: 0, hostname: "127.0.0.1" });
