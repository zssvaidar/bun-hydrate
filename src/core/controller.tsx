// controller.tsx
import { ServerApp } from './serverMain';
import { renderToReadableStream } from 'react-dom/server';
import PageHomeOne from 'app/packages/core/pages/PageHomeOne';

const Controller = async (req: Request) => {
    const { pathname } = new URL(req.url);

    if (pathname === "/data" && req.method === "GET") {
        return new Response(JSON.stringify({ time: new Date().toTimeString() }), {
          headers: {
            'Content-Type': 'text/json',
          },
        });
    }

    if (pathname === "/" && req.method === "GET") {

      const AppComponent = await ServerApp('localhost:3000', 'http', req);

      const stream = await renderToReadableStream(AppComponent, {
        bootstrapModules: ['./hydrate.js'],
      });
  
      return new Response(stream, {
        headers: {
          'content-type': 'text/html',
        },
      });
    }
  
    const pokemonNameRegex = /^\/page\/([a-zA-Z0-9_-]+)$/;
    const pageNum = pathname.match(pokemonNameRegex);

    const stream = await renderToReadableStream(<PageHomeOne pageNum={pageNum} />);

    return new Response(stream, {
      headers: { "Content-Type": "text/html" },
    });
  };

export default Controller;