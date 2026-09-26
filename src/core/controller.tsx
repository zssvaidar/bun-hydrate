// controller.tsx
import { ServerApp } from './serverMain';
import {renderToReadableStream} from 'react-dom/server.browser'
import PageHomeOne from 'app/packages/core/pages/PageHomeOne';
import ProgramType from './types/ProgramType';

const PORT = process.env.port || 3000;
const HOST = process.env.host || "localhost";
const protocol = process.env.protocol || "http";

const startedAt = Date.now();

const Controller = async (programType: any, req: Request) => {
    const { pathname } = new URL(req.url);

    if (pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
        return new Response(JSON.stringify({
          status: "ok",
          programType,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          timestamp: new Date().toISOString(),
        }), {
          headers: {
            'Content-Type': 'application/json',
          },
        });
    }

    if (pathname === "/data" && req.method === "GET") {
        return new Response(JSON.stringify({ time: new Date().toTimeString() }), {
          headers: {
            'Content-Type': 'text/json',
          },
        });
    }

    if (pathname === "/" && req.method === "GET") {

      const AppComponent = await ServerApp(`${HOST}:${PORT}`, protocol, req);

      const stream = await renderToReadableStream(AppComponent, {
        bootstrapModules: ['./hydrate.js'],
      });
  
      return new Response(stream, {
        headers: {
          'content-type': 'text/html',
        },
      });
    }

  
    const file = await staticFile(pathname);
    if (file) return file;

    // https://www.tercmd.com/creating-file-system-routing-in-bun

    const pokemonNameRegex = /^\/page\/([a-zA-Z0-9_-]+)$/;
    const pageNum = pathname.match(pokemonNameRegex);

    const stream = await renderToReadableStream(<PageHomeOne pageNum={pageNum} />);

    return new Response(stream, {
      headers: { "Content-Type": "text/html" },
    });
  };

export default Controller;