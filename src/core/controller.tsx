// controller.tsx
import { ServerApp } from './serverMain';
import {renderToReadableStream} from 'react-dom/server.browser'
import PageHomeOne from 'app/packages/core/pages/PageHomeOne';
import ProgramType from './types/ProgramType';

const PORT = process.env.port;
const HOST = process.env.host;
const protocol = process.env.protocol;

const Controller = async (programType: any, req: Request) => {
    const { pathname } = new URL(req.url);

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
  
    // https://www.tercmd.com/creating-file-system-routing-in-bun

    const pokemonNameRegex = /^\/page\/([a-zA-Z0-9_-]+)$/;
    const pageNum = pathname.match(pokemonNameRegex);

    const stream = await renderToReadableStream(<PageHomeOne pageNum={pageNum} />);

    return new Response(stream, {
      headers: { "Content-Type": "text/html" },
    });
  };

export default Controller;