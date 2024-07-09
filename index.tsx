// index.ts
import Controller from './src/core/controller'
import { parseArgs } from "util";
import { isNil } from "lodash";
import ProgramType from './src/core/types/ProgramType'

const buildsMatchers = new Map<string, () => Response>();

const PORT = process.env.port;
const HOST = process.env.host;

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

if(isNil(values.programType))
  throw new Error("no program type specified, either api, web");

const init = async () => {
  const builds = await Bun.build({
    entrypoints: ['./hydrate.tsx'],
    target: "browser",
    splitting: true,
    minify: {
      identifiers: true,
      syntax: true,
      whitespace: true,
    },
  });

  for (const build of builds.outputs) {
    buildsMatchers.set(build.path.substring(1), () => new Response(build.stream(), {
      headers: {
        "Content-Type": build.type,
      },
    }));
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

    const response = await Controller(values.programType, req/* , server */); // demoPageRequest

    if (response) {
      return response;
    }

    return new Response(JSON.stringify({ status: 404, message: "Not found" }), { status: 404 });
  }
});

console.log(`Listening on ${HOST}:${PORT}`);