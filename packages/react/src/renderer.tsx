import { createElement, type ReactElement } from "react";
import type { Context } from "@bun-hydrate/core";
import { renderToReadableStream } from "react-dom/server";
import { documentShell } from "./document";
import type { PageName, PageProps, PageRegistry, SharedData } from "./pages";

export interface RendererOptions<Pages extends PageRegistry> {
  pages: Pages;
  /** Client scripts and stylesheets to load; usually `(await createAssets(...))`. Read on every render. */
  assets: { scripts: readonly string[]; styles?: readonly string[] };
  lang?: string;
  defaultTitle?: string;
  /** Called for errors React recovers from (e.g. inside Suspense boundaries). Default: console.error. */
  onError?: (error: unknown) => void;
  /** Per-request data every page gets (e.g. the auth snapshot), embedded in the payload when `ctx` is passed. */
  shared?: (ctx: Context<any>) => SharedData | Promise<SharedData>;
  /** Wraps every page (e.g. in providers). hydratePage must use the same wrap so hydration matches. */
  wrap?: (page: ReactElement, shared: SharedData) => ReactElement;
}

export interface RenderOptions {
  title?: string;
  status?: number;
  /** The request, so `shared(ctx)` can run. */
  ctx?: Context<any>;
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
  const { pages, assets, lang = "en", defaultTitle = "", onError = console.error, shared, wrap } = options;

  return {
    async render(name, props, renderOptions = {}) {
      const Page = pages[name];
      if (!Page) throw new Error(`Unknown page "${name}". Register it with definePages().`);

      const sharedData = renderOptions.ctx && shared ? await shared(renderOptions.ctx) : undefined;
      const page = createElement(Page, props);
      const element = wrap ? wrap(page, sharedData ?? {}) : page;

      // Rejects if the shell cannot render, which the app turns into a normal 500.
      const body = await renderToReadableStream(element, { onError });
      const { head, tail } = documentShell({
        title: renderOptions.title ?? defaultTitle,
        lang,
        payload: sharedData === undefined ? { page: name, props } : { page: name, props, shared: sharedData },
        scripts: assets.scripts,
        styles: assets.styles,
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
