import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { documentShell } from "./document";
import type { PageName, PageProps, PageRegistry } from "./pages";

export interface RendererOptions<Pages extends PageRegistry> {
  pages: Pages;
  /** Client scripts to load; usually `(await createAssets(...))`. */
  assets: { scripts: readonly string[] };
  lang?: string;
  defaultTitle?: string;
  /** Called for errors React recovers from (e.g. inside Suspense boundaries). Default: console.error. */
  onError?: (error: unknown) => void;
}

export interface RenderOptions {
  title?: string;
  status?: number;
}

export interface ReactRenderer<Pages extends PageRegistry> {
  render<Name extends PageName<Pages>>(
    name: Name,
    props: PageProps<Pages, Name>,
    options?: RenderOptions,
  ): Promise<Response>;
}

const encoder = new TextEncoder();

export function createReactRenderer<Pages extends PageRegistry>(options: RendererOptions<Pages>): ReactRenderer<Pages> {
  const { pages, assets, lang = "en", defaultTitle = "", onError = console.error } = options;

  return {
    async render(name, props, renderOptions = {}) {
      const Page = pages[name];
      if (!Page) throw new Error(`Unknown page "${name}". Register it with definePages().`);

      // Rejects if the shell cannot render, which the app turns into a normal 500.
      const body = await renderToReadableStream(createElement(Page, props), { onError });
      const { head, tail } = documentShell({
        title: renderOptions.title ?? defaultTitle,
        lang,
        payload: { page: name, props },
        scripts: assets.scripts,
      });

      return new Response(surround(head, body, tail), {
        status: renderOptions.status ?? 200,
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    },
  };
}

/** Streams `head`, then the React stream as it renders, then `tail`. */
function surround(head: string, body: ReadableStream<Uint8Array>, tail: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(head));
      const reader = body.getReader();
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          controller.enqueue(chunk.value);
        }
        controller.enqueue(encoder.encode(tail));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
