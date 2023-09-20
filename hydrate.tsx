// hydrate.ts
/// <reference lib="dom" />

import { hydrateRoot } from 'react-dom/client';
import { App } from "./main";

hydrateRoot(document, <App />);