// index.ts
import { renderToReadableStream } from 'react-dom/server';
import { ServerApp } from './serverMain';

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

const serveDemoPage = async (req: Request) => {
  const { pathname } = new URL(req.url);

    if (pathname === "/data" && req.method === "GET") {
        return new Response(JSON.stringify({ time: new Date().toTimeString() }), {
            headers: {
              'Content-Type': 'text/json',
            },
          });
    }

  if (pathname === "/demo" && req.method === "GET") {
    const AppComponent = await ServerApp();

    const stream = await renderToReadableStream(AppComponent, {
      bootstrapModules: ['./hydrate.js'],
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/html',
      },
    });
  }
};

await init();

export const server = Bun.serve({
  port: 3000,
  async fetch(req, server) {
    const buildFileRequest = serveBuild(req);

    if (buildFileRequest) {
      return buildFileRequest;
    }
    
    const demoPageRequest = await serveDemoPage(req, server);

    if (demoPageRequest) {
      return demoPageRequest;
    }

    return new Response(JSON.stringify({ status: 404, message: "Not found" }), { status: 404 });
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);