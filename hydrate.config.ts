import { defineHydrateConfig } from "@bun-hydrate/cli";
import { clientPlugins } from "./src/web/client.plugins";

export default defineHydrateConfig({
  server: "src/main.ts",
  client: "src/web/client.tsx",
  clientPlugins,
  outDir: "dist",
});
