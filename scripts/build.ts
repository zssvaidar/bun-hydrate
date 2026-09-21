// scripts/build.ts
// Produces a deployable dist/ folder: a bundled server (dist/index.js) and
// a pre-built client asset bundle (dist/public/*). Run with `bun run build`.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const DIST_DIR = "dist";
const PUBLIC_DIR = `${DIST_DIR}/public`;

// Dependencies kept as regular npm imports in the server bundle instead of
// being inlined, so the deploy target just needs `bun install --production`.
const EXTERNAL_DEPENDENCIES = [
  "react",
  "react-dom",
  "react-dom/*",
  "react-router-dom",
  "react-router-dom/*",
  "lodash",
];

if (existsSync(DIST_DIR)) {
  await rm(DIST_DIR, { recursive: true, force: true });
}

console.log("Building client assets...");

const client = await Bun.build({
  entrypoints: ["./src/core/hydrate.tsx"],
  target: "browser",
  splitting: true,
  minify: {
    identifiers: true,
    syntax: true,
    whitespace: true,
  },
  outdir: PUBLIC_DIR,
});

if (!client.success) {
  for (const log of client.logs) console.error(log);
  process.exit(1);
}

console.log(`  -> ${client.outputs.length} file(s) in ${PUBLIC_DIR}`);

console.log("Building server...");

const server = await Bun.build({
  entrypoints: ["./index.tsx"],
  target: "bun",
  minify: true,
  outdir: DIST_DIR,
  external: EXTERNAL_DEPENDENCIES,
});

if (!server.success) {
  for (const log of server.logs) console.error(log);
  process.exit(1);
}

console.log(`  -> ${DIST_DIR}/index.js`);
console.log("Build complete.");
