import { EnvVar, defineConfig, env, type EnvSource, type TrustProxy } from "@bun-hydrate/core";

/**
 * TRUST_PROXY: "false" (default; the socket address is the client), a hop count such as "1"
 * behind one load balancer, or comma-separated proxy addresses/CIDRs such as "10.0.0.0/8".
 */
const trustProxy = new EnvVar<TrustProxy>("TRUST_PROXY", (raw) => {
  const value = raw.trim();
  if (value === "false") return { ok: true, value: false };
  if (/^\d+$/.test(value)) return { ok: true, value: Number(value) };
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? { ok: true, value: entries } : { ok: false, expected: '"false", a hop count or a list of CIDRs' };
}).default(false);

export function loadConfig(source: EnvSource = process.env) {
  return defineConfig(
    {
      port: env.port("PORT").default(3000),
      host: env.string("HOST").default("0.0.0.0"),
      logLevel: env.enum("LOG_LEVEL", ["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
      logFormat: env.enum("LOG_FORMAT", ["json", "pretty"]).optional(),
      databaseUrl: env.string("DATABASE_URL").default("sqlite://:memory:"),
      migrateOnStart: env.boolean("MIGRATE_ON_START").default(false),
      trustProxy,
    },
    source,
  );
}

export type AppConfig = ReturnType<typeof loadConfig>;
