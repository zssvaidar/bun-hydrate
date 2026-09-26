import { defineHydrateConfig } from "@bun-hydrate/cli";

export default defineHydrateConfig({
  server: "src/main.ts",
  client: "src/web/client.tsx",
  outDir: "dist",
});
