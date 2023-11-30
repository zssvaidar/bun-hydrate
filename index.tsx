// index.ts
import Controller from 'core/controller'

const buildsMatchers = new Map<string, () => Response>();

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
  port: 3000,
  async fetch(req, server) {
    const buildFileRequest = serveBuild(req);

    if (buildFileRequest) {
      return buildFileRequest;
    }

    const response = await Controller(req, server); // demoPageRequest

    if (response) {
      return response;
    }

    return new Response(JSON.stringify({ status: 404, message: "Not found" }), { status: 404 });
  }
});

console.log(`Listening on ${server.hostname}:${server.port}`);