import { APP_ROOT_ID, PAYLOAD_ID, type HydrationPayload } from "./pages";
import { escapeHtml, serializeForScript } from "./serialize";

export interface DocumentOptions {
  title: string;
  lang: string;
  payload: HydrationPayload;
  scripts: readonly string[];
}

/**
 * The HTML around the React output. React renders only into #app, so hydration never has to
 * reconcile <html>/<head>, and the shell stays a plain string.
 */
export function documentShell({ title, lang, payload, scripts }: DocumentOptions): { head: string; tail: string } {
  const head =
    `<!doctype html><html lang="${escapeHtml(lang)}"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `</head><body><div id="${APP_ROOT_ID}">`;

  const scriptTags = scripts.map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`).join("");
  const tail =
    `</div>` +
    `<script type="application/json" id="${PAYLOAD_ID}">${serializeForScript(payload)}</script>` +
    scriptTags +
    `</body></html>`;

  return { head, tail };
}
