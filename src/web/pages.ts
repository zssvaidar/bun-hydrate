import { definePages } from "@bun-hydrate/react";
import { Home } from "./pages/Home";
import { PageDetail } from "./pages/PageDetail";

/** Shared by the server (to render) and the browser entry (to hydrate). */
export const pages = definePages({ Home, PageDetail });
