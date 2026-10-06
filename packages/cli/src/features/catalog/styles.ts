import { defineFeature, type FeatureOutput, type Slots } from "../define";
import { generatedHeader, renderImports, type NamedImport } from "./render";
import appScss from "./styles-templates/app.scss.tmpl" with { type: "text" };
import variablesScss from "./styles-templates/variables.scss.tmpl" with { type: "text" };

/** Stylesheet languages for the client bundle; plain CSS needs no feature. */

/** Slot `client.plugins`: one Bun plugin for the client bundle, created by `call`. */
export interface ClientPluginContribution extends NamedImport {
  call: string;
}

const CLIENT_PLUGINS = "src/web/client.plugins.ts";

export const clientPluginsOutput: FeatureOutput = {
  kind: "file",
  path: CLIENT_PLUGINS,
  render(slots: Slots) {
    const plugins = slots.get<ClientPluginContribution>("client.plugins");
    return [
      generatedHeader("Pass clientPlugins to hydrate.config.ts and createAssets() in src/main.ts."),
      'import type { ClientPlugin } from "@bun-hydrate/react";',
      ...renderImports(plugins),
      "",
      "/** The client bundle's Bun plugins, the same in `hydrate dev` and `hydrate build`. */",
      `export const clientPlugins: ClientPlugin[] = [${plugins.map((plugin) => plugin.call).join(", ")}];`,
      "",
    ].join("\n");
  },
};

export const stylesFeatures = [
  defineFeature({
    id: "styles:sass",
    description: "Sass (.scss/.sass) in the client bundle, compiled by Dart Sass and linked from every page's <head>",
    scaffold: { "src/web/styles/app.scss": appScss, "src/web/styles/_variables.scss": variablesScss },
    contributes: { "client.plugins": [{ from: "@bun-hydrate/react/sass", name: "sassPlugin", call: "sassPlugin()" }] },
    outputs: [clientPluginsOutput],
    instructions: [
      "Install the compiler (build time only, never part of dist/): bun add -d sass-embedded",
      'In hydrate.config.ts: import { clientPlugins } from "./src/web/client.plugins"; and set clientPlugins in defineHydrateConfig()',
      'In src/main.ts: import { clientPlugins } from "./web/client.plugins"; and pass plugins: clientPlugins to createAssets()',
      'In src/web/client.tsx: import "./styles/app.scss";',
    ],
  }),
];
