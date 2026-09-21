// index.ts
import { existsSync } from "node:fs";
import Controller from './src/core/controller'
import { parseArgs } from "util";
import { isNil } from "lodash";
import ProgramType from './src/core/types/ProgramType'

const buildsMatchers = new Map<string, () => Response>();

const PORT = process.env.port || 3000;
const HOST = process.env.host || "0.0.0.0";
// Set by `bun run build` (see scripts/build.ts). When present, serve the
// pre-built client bundle instead of rebuilding it on every boot.
const PUBLIC_DIR = process.env.PUBLIC_DIR || "./dist/public";

const { values, positionals } = parseArgs({
  args: Bun.argv,
  options: {
    programType: {
      type: 'string'
    },
  },
  strict: true,
  allowPositionals: true,
});

const programType = isNil(values.programType) ? "web" : values.programType;

const registerAsset = (pathname: string, asset: { stream: () => ReadableStream; type: string }) => {
  buildsMatchers.set(pathname, () => new Response(asset.stream(), {
    headers: {
      "Content-Type": asset.type,
    },
  }));
};

const init = async () => {
  if (existsSync(PUBLIC_DIR)) {
    const glob = new Bun.Glob("**/*");

    for await (const relPath of glob.scan({ cwd: PUBLIC_DIR, onlyFiles: true })) {
      registerAsset(`/${relPath}`, Bun.file(`${PUBLIC_DIR}/${relPath}`));
    }

    return;
  }

  const builds = await Bun.build({
    entrypoints: ['./src/core/hydrate.tsx'],
    target: "browser",
    splitting: true,
    minify: {
      identifiers: true,
      syntax: true,
      whitespace: true,
    },
  });

  for (const build of builds.outputs) {
    registerAsset(build.path.substring(1), build);
  }
}

const serveBuild = (req: Request) => {
  const { pathname } = new URL(req.url);

  const buildFileRequest = buildsMatchers.get(pathname);

  if (buildFileRequest) {
    return buildFileRequest();
  }
}

await init();

export const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    const buildFileRequest = serveBuild(req);

    if (buildFileRequest) {
      return buildFileRequest;
    }

    const response = await Controller(programType, req/* , server */); // demoPageRequest

    if (response) {
      return response;
    }

    return new Response(JSON.stringify({ status: 404, message: "Not found" }), { status: 404 });
  }
});

console.log(`Listening on ${HOST}:${PORT}`);