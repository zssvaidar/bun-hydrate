import { App } from "@bun-hydrate/core";

const app = new App().get("/", () => ({ built: true, nodeEnv: process.env.NODE_ENV }));

await app.listen({ port: Number(process.env.PORT ?? 0), hostname: "127.0.0.1" });
