/// <reference lib="dom" />
import { createElement, type ReactElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { APP_ROOT_ID, PAYLOAD_ID, type HydrationPayload, type PageRegistry, type SharedData } from "./pages";

export interface HydrateOptions {
  /** Must match the renderer's `wrap`, e.g. `wrapAuth` from createAuthClient(). */
  wrap?: (page: ReactElement, shared: SharedData) => ReactElement;
}

/**
 * Browser entry helper: reads the payload the server embedded and hydrates the matching page
 * from the same registry the server rendered it with.
 */
export function hydratePage(pages: PageRegistry, options: HydrateOptions = {}): Root {
  const payloadElement = document.getElementById(PAYLOAD_ID);
  const root = document.getElementById(APP_ROOT_ID);
  if (!payloadElement || !root) {
    throw new Error(`Missing #${PAYLOAD_ID} or #${APP_ROOT_ID}; was this page rendered by createReactRenderer()?`);
  }

  const { page, props, shared = {} } = JSON.parse(payloadElement.textContent ?? "") as HydrationPayload;
  const Page = pages[page];
  if (!Page) throw new Error(`Unknown page "${page}". Register it with definePages() in the client entry too.`);

  const element = createElement(Page, props as object);
  return hydrateRoot(root, options.wrap ? options.wrap(element, shared) : element);
}
