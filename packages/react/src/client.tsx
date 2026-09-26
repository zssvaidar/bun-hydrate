/// <reference lib="dom" />
import { createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { APP_ROOT_ID, PAYLOAD_ID, type HydrationPayload, type PageRegistry } from "./pages";

/**
 * Browser entry helper: reads the payload the server embedded and hydrates the matching page
 * from the same registry the server rendered it with.
 */
export function hydratePage(pages: PageRegistry): Root {
  const payloadElement = document.getElementById(PAYLOAD_ID);
  const root = document.getElementById(APP_ROOT_ID);
  if (!payloadElement || !root) {
    throw new Error(`Missing #${PAYLOAD_ID} or #${APP_ROOT_ID}; was this page rendered by createReactRenderer()?`);
  }

  const { page, props } = JSON.parse(payloadElement.textContent ?? "") as HydrationPayload;
  const Page = pages[page];
  if (!Page) throw new Error(`Unknown page "${page}". Register it with definePages() in the client entry too.`);

  return hydrateRoot(root, createElement(Page, props as object));
}
