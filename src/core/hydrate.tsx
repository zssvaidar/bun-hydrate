// hydrate.ts
/// <reference lib="dom" />

import { hydrateRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import routes from './routes';

let router = createBrowserRouter(routes);

hydrateRoot(
  document.getElementById("app"),
  <RouterProvider router={router} />
)