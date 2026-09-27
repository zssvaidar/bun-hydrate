import { defineFeature, definePreset, type FeatureOutput, type Slots } from "../../define";
import { generatedHeader, renderImports, type NamedImport } from "../render";
import accountFeature from "./templates/account.feature.ts.tmpl" with { type: "text" };
import accountPage from "./templates/Account.tsx.tmpl" with { type: "text" };
import accountPageTest from "./templates/Account.test.tsx.tmpl" with { type: "text" };
import accounts from "./templates/accounts.ts.tmpl" with { type: "text" };
import accountsTest from "./templates/accounts.test.ts.tmpl" with { type: "text" };
import apiKeysCommands from "./templates/api-keys.commands.ts.tmpl" with { type: "text" };
import config from "./templates/config.ts.tmpl" with { type: "text" };
import core from "./templates/core.ts.tmpl" with { type: "text" };
import coreCommands from "./templates/core.commands.ts.tmpl" with { type: "text" };
import loginFeature from "./templates/login.feature.ts.tmpl" with { type: "text" };
import loginRoutes from "./templates/login.routes.ts.tmpl" with { type: "text" };
import loginSchema from "./templates/login.schema.ts.tmpl" with { type: "text" };
import loginTest from "./templates/login.test.ts.tmpl" with { type: "text" };
import loginPage from "./templates/Login.tsx.tmpl" with { type: "text" };
import loginPageTest from "./templates/Login.test.tsx.tmpl" with { type: "text" };
import passwords from "./templates/passwords.ts.tmpl" with { type: "text" };
import passwordsCommands from "./templates/passwords.commands.ts.tmpl" with { type: "text" };
import passwordsTest from "./templates/passwords.test.ts.tmpl" with { type: "text" };
import registerPage from "./templates/Register.tsx.tmpl" with { type: "text" };
import registerPageTest from "./templates/Register.test.tsx.tmpl" with { type: "text" };
import sessionsCommands from "./templates/sessions.commands.ts.tmpl" with { type: "text" };
import webAuth from "./templates/web-auth.ts.tmpl" with { type: "text" };

/** The auth features (spec-5 §9.1). Runtime pieces come from @bun-hydrate/auth; the rest is generated app code. */

/** Slot `auth.features`: an entry in the composition root's `features` list. */
interface RuntimeFeature extends NamedImport {
  /** How the entry is written, e.g. `sessionsFeature(authConfig.features?.sessions)`. Default: the name. */
  expression?: string;
}

/** Slot `auth.commands`: a console command handler exported by an app file. */
interface AppCommand extends NamedImport {
  command: string;
}

/** Slot `web.authPages`: a page added to definePages() and served at `path`. */
interface AuthPage extends NamedImport {
  path: string;
  title: string;
}

const RUNTIME = "@bun-hydrate/auth/features";
const COMMANDS_MODULE = "src/auth/commands.ts";

const compositionRoot: FeatureOutput = {
  kind: "file",
  path: "src/auth/index.ts",
  render(slots: Slots) {
    const features = slots.get<RuntimeFeature>("auth.features");
    return `${generatedHeader("Customize src/auth/config.ts instead.")}
import type { Context } from "@bun-hydrate/core";
${renderImports([{ from: "@bun-hydrate/auth", name: "createAuth" }, { from: "./config", name: "authConfig" }, ...features]).join("\n")}

export const auth = createAuth({
  config: authConfig,
  features: [
${features.map((feature) => `    ${feature.expression ?? feature.name},`).join("\n")}
  ],
});

/** Call once in src/app.ts: \`installAuth(app, container)\`. The container needs Database. */
export const installAuth = auth.install;

/** For createReactRenderer({ shared: authShared }): pages render signed in from the first paint. */
export const authShared = (ctx: Context<any>) => ({ auth: auth.snapshot(ctx) });
`;
  },
};

const commandsIndex: FeatureOutput = {
  kind: "file",
  path: COMMANDS_MODULE,
  render(slots: Slots) {
    const commands = slots.get<AppCommand>("auth.commands");
    return `${generatedHeader("Commands live in the *.commands.ts files next to it.")}
import type { CommandHandler } from "@bun-hydrate/cli/commands";
${renderImports(commands).join("\n")}

/** Run with \`bun hydrate <name>\`; the CLI opens the database from DATABASE_URL. */
export const commands: Record<string, CommandHandler> = {
${commands.map((command) => `  "${command.command}": ${command.name},`).join("\n")}
};
`;
  },
};

const PERMISSIONS_FILE = `/**
 * Every permission the app checks, shared by the server (requirePermission) and the browser
 * (useCan, <Can>), so a typo fails \`tsc\` on both sides. The lines between the markers are
 * maintained by \`hydrate\` (features and \`generate module --auth\`); add your own after them.
 */
export const PERMISSIONS = [
  // hydrate:permissions:start
  // hydrate:permissions:end
] as const;

export type Permission = (typeof PERMISSIONS)[number];
`;

const permissionsBlock: FeatureOutput = {
  kind: "block",
  path: "src/shared/permissions.ts",
  block: "permissions",
  initial: PERMISSIONS_FILE,
  render: (slots) => [...new Set(slots.get<string>("permissions"))].map((name) => `  "${name}",`).join("\n"),
};

const authPages: FeatureOutput = {
  kind: "file",
  path: "src/web/auth-pages.ts",
  render(slots: Slots) {
    const pages = slots.get<AuthPage>("web.authPages");
    const routes = pages.map((page) => `  { path: "${page.path}", name: "${page.name}", title: "${page.title}" },`);
    return [
      generatedHeader("Pages live in src/web/pages/auth/."),
      ...renderImports(pages),
      "",
      "/** Spread into definePages(): `definePages({ ...yourPages, ...authPages })`. */",
      `export const authPages = ${pages.length > 0 ? `{ ${pages.map((page) => page.name).join(", ")} }` : "{}"};`,
      "",
      "/** Serve them: `for (const page of authPageRoutes) router.get(page.path, (ctx) => react.render(page.name, {}, { title: page.title, ctx }))`. */",
      `export const authPageRoutes = [${routes.length > 0 ? `\n${routes.join("\n")}\n` : ""}] as const;`,
      "",
    ].join("\n");
  },
};

export const ACCOUNTS_TABLE = `create table if not exists accounts (
  id varchar(36) primary key,
  email varchar(320) not null unique,
  role varchar(64) not null,
  created_at varchar(32) not null
);`;

export const authFeatures = [
  defineFeature({
    id: "auth:core",
    description: "Accounts, principals, the permission list and the auth composition root",
    files: {
      "src/auth/accounts.ts": accounts,
      "src/auth/accounts.test.ts": accountsTest,
      "src/auth/core.ts": core,
      "src/auth/core.commands.ts": coreCommands,
    },
    scaffold: { "src/auth/config.ts": config },
    migration: { up: ACCOUNTS_TABLE, down: "drop table if exists accounts;", tables: ["accounts"] },
    contributes: {
      "auth.features": [{ from: "./core", name: "coreFeature" }],
      "auth.commands": [
        { command: "auth:set-role", from: "./core.commands", name: "setRoleCommand" },
        { command: "auth:permissions", from: "./core.commands", name: "permissionsCommand" },
      ],
    },
    outputs: [compositionRoot, commandsIndex, permissionsBlock],
    commands: [
      { name: "auth:set-role", usage: "--email <email> --role <role>", description: "Change a user's role and end their sessions" },
      { name: "auth:permissions", usage: "", description: "Show which role grants which permission" },
    ],
    commandsModule: COMMANDS_MODULE,
    instructions: [
      'Once, in src/app.ts: import { installAuth } from "./auth"; then call installAuth(app, container) (the container needs Database)',
    ],
  }),

  defineFeature({
    id: "auth:passwords",
    description: "Password sign-in: argon2id hashes, rehash on login",
    requires: ["auth:core"],
    files: {
      "src/auth/passwords.ts": passwords,
      "src/auth/passwords.test.ts": passwordsTest,
      "src/auth/passwords.commands.ts": passwordsCommands,
    },
    migration: {
      up: `create table if not exists account_passwords (
  account_id varchar(36) primary key references accounts (id) on delete cascade,
  hash varchar(255) not null,
  updated_at varchar(32) not null
);`,
      down: "drop table if exists account_passwords;",
      tables: ["account_passwords"],
    },
    contributes: {
      "auth.features": [{ from: "./passwords", name: "passwordsFeature" }],
      "auth.commands": [{ command: "auth:create-user", from: "./passwords.commands", name: "createUserCommand" }],
    },
    commands: [
      {
        name: "auth:create-user",
        usage: "--email <email> [--role <role>] [--password-stdin]",
        description: "Create a user (e.g. the first admin); the password is read at a hidden prompt",
      },
    ],
    commandsModule: COMMANDS_MODULE,
  }),

  defineFeature({
    id: "auth:sessions",
    description: "Server-side sessions with opaque cookies, plus CSRF protection",
    requires: ["auth:core"],
    files: { "src/auth/sessions.commands.ts": sessionsCommands },
    migration: {
      up: `create table if not exists sessions (
  id_hash varchar(64) primary key,
  user_id varchar(64) not null,
  created_at bigint not null,
  last_seen_at bigint not null,
  expires_at bigint not null,
  user_agent varchar(512),
  ip varchar(64)
);
create index if not exists sessions_user_id on sessions (user_id);`,
      down: "drop table if exists sessions;",
      tables: ["sessions"],
    },
    env: [
      { name: "SESSION_IDLE_TIMEOUT", description: "Sign out after this much inactivity (default 30m)" },
      { name: "SESSION_ABSOLUTE_TIMEOUT", description: "Sign out this long after login regardless (default 7d)" },
    ],
    contributes: {
      "auth.features": [{ from: RUNTIME, name: "sessionsFeature", expression: "sessionsFeature(authConfig.features?.sessions)" }],
      "auth.commands": [{ command: "auth:revoke-sessions", from: "./sessions.commands", name: "revokeSessionsCommand" }],
    },
    commands: [{ name: "auth:revoke-sessions", usage: "--email <email>", description: "Sign a user out everywhere" }],
    commandsModule: COMMANDS_MODULE,
  }),

  defineFeature({
    id: "auth:jwt",
    description: "Bearer JWTs signed by this app (HS256 from JWT_SECRET)",
    requires: ["auth:core"],
    conflicts: ["auth:oidc"],
    env: [
      { name: "JWT_SECRET", description: "HMAC key, at least 32 random characters", required: true },
      { name: "JWT_TTL", description: "Access token lifetime (default 15m)" },
      { name: "JWT_ISSUER", description: "Sets and checks the iss claim" },
      { name: "JWT_AUDIENCE", description: "Sets and checks the aud claim" },
    ],
    contributes: {
      "auth.features": [{ from: RUNTIME, name: "jwtFeature", expression: "jwtFeature(authConfig.features?.jwt)" }],
    },
  }),

  defineFeature({
    id: "auth:oidc",
    description: "Accept bearer tokens from an OIDC identity provider (resource server)",
    requires: ["auth:core"],
    conflicts: ["auth:jwt"],
    env: [
      { name: "OIDC_ISSUER", description: "The provider's issuer URL", required: true },
      { name: "OIDC_AUDIENCE", description: "This API's audience at the provider", required: true },
    ],
    contributes: {
      "auth.features": [{ from: RUNTIME, name: "oidcFeature", expression: "oidcFeature(authConfig.features?.oidc)" }],
    },
  }),

  defineFeature({
    id: "auth:api-keys",
    description: "Service-to-service API keys, hashed at rest",
    requires: ["auth:core"],
    files: { "src/auth/api-keys.commands.ts": apiKeysCommands },
    migration: {
      up: `create table if not exists api_keys (
  key_id varchar(32) primary key,
  hash varchar(64) not null,
  name varchar(200) not null,
  principal_id varchar(64) not null,
  permissions text not null,
  created_at bigint not null,
  last_used_at bigint,
  revoked_at bigint
);`,
      down: "drop table if exists api_keys;",
      tables: ["api_keys"],
    },
    contributes: {
      "auth.features": [{ from: RUNTIME, name: "apiKeysFeature", expression: "apiKeysFeature(authConfig.features?.apiKeys)" }],
      "auth.commands": [{ command: "auth:api-key", from: "./api-keys.commands", name: "apiKeyCommand" }],
    },
    commands: [
      {
        name: "auth:api-key",
        usage: "create --name <n> --permissions <a,b> [--owner <email>] | list | revoke <keyId>",
        description: "Create (shown once), list or revoke API keys",
      },
    ],
    commandsModule: COMMANDS_MODULE,
  }),

  defineFeature({
    id: "auth:login",
    description: "/register, /login, /logout and /me routes, with a login rate limit",
    requires: ["auth:passwords", ["auth:sessions", "auth:jwt"]],
    files: {
      "src/auth/login/login.schema.ts": loginSchema,
      "src/auth/login/login.routes.ts": loginRoutes,
      "src/auth/login/feature.ts": loginFeature,
      "src/auth/login/login.test.ts": loginTest,
    },
    contributes: { "auth.features": [{ from: "./login/feature", name: "loginFeature" }] },
  }),

  defineFeature({
    id: "auth:react",
    description: "AuthProvider, useAuth, useCan and <Can> for React, seeded by the server render",
    requires: ["auth:core"],
    files: { "src/web/auth.ts": webAuth },
    outputs: [authPages],
    instructions: [
      "Once, where you call createReactRenderer: add shared: authShared (from src/auth/index.ts) and wrap: wrapAuth (from src/web/auth.ts), and pass { ctx } to render()",
      'Once, in src/web/client.tsx: hydratePage(pages, { wrap: wrapAuth })',
      "Once, in src/web/pages.ts: definePages({ …, ...authPages }), and serve authPageRoutes next to your page routes (both from src/web/auth-pages.ts)",
    ],
  }),

  defineFeature({
    id: "auth:ui-login",
    description: "Login page at /login",
    requires: ["auth:login", "auth:react"],
    files: { "src/web/pages/auth/Login.tsx": loginPage, "src/web/pages/auth/Login.test.tsx": loginPageTest },
    contributes: { "web.authPages": [{ from: "./pages/auth/Login", name: "Login", path: "/login", title: "Sign in" }] },
  }),

  defineFeature({
    id: "auth:ui-register",
    description: "Registration page at /register",
    requires: ["auth:login", "auth:react"],
    files: { "src/web/pages/auth/Register.tsx": registerPage, "src/web/pages/auth/Register.test.tsx": registerPageTest },
    contributes: {
      "web.authPages": [{ from: "./pages/auth/Register", name: "Register", path: "/register", title: "Create an account" }],
    },
  }),

  defineFeature({
    id: "auth:ui-account",
    description: 'Account page at /account with "sign out everywhere"',
    requires: ["auth:sessions", "auth:react"],
    files: {
      "src/web/pages/auth/Account.tsx": accountPage,
      "src/web/pages/auth/Account.test.tsx": accountPageTest,
      "src/auth/account/feature.ts": accountFeature,
    },
    contributes: {
      "auth.features": [{ from: "./account/feature", name: "accountFeature" }],
      "web.authPages": [{ from: "./pages/auth/Account", name: "Account", path: "/account", title: "Your account" }],
    },
  }),
];

export const authPresets = [
  definePreset({
    id: "auth",
    description: "Sessions and a login page: core, passwords, sessions, login, react, ui-login",
    features: ["auth:core", "auth:passwords", "auth:sessions", "auth:login", "auth:react", "auth:ui-login"],
  }),
  definePreset({
    id: "auth:api",
    description: "JWT sign-in for APIs and mobile apps: core, passwords, jwt, login",
    features: ["auth:core", "auth:passwords", "auth:jwt", "auth:login"],
  }),
  definePreset({
    id: "auth:service",
    description: "Service-to-service API keys: core, api-keys",
    features: ["auth:core", "auth:api-keys"],
  }),
];
