import { hydratePage } from "@bun-hydrate/react/client";
import { wrapAuth } from "./auth";
import { pages } from "./pages";

hydratePage(pages, { wrap: wrapAuth });
