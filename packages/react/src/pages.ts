import type { ComponentProps, ComponentType } from "react";

// Pages take arbitrary JSON props; `any` here is what lets each page keep its own props type.
export type PageRegistry = Record<string, ComponentType<any>>;
export type PageName<Pages extends PageRegistry> = keyof Pages & string;
export type PageProps<Pages extends PageRegistry, Name extends PageName<Pages>> = ComponentProps<Pages[Name]>;

/** Per-request data shared by every page, e.g. `{ auth: AuthSnapshot }`. */
export type SharedData = Record<string, unknown>;

/** What the server embeds in the document so the client knows what to hydrate. */
export interface HydrationPayload {
  page: string;
  props: unknown;
  shared?: SharedData;
}

export const APP_ROOT_ID = "app";
export const PAYLOAD_ID = "__HYDRATE__";

/**
 * The page registry shared by server and client. Pages are referenced by name, so the
 * server can tell the client which component to hydrate without shipping code references.
 */
export function definePages<const Pages extends PageRegistry>(pages: Pages): Pages {
  return pages;
}
