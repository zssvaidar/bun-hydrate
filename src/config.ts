import { EnvVar, defineConfig, env, parseSize, type EnvSource, type Size, type TrustProxy } from "@bun-hydrate/core";

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

/** MAX_BODY_SIZE: bytes, or "512kb", "10mb", … */
const maxBodySize = new EnvVar<number>("MAX_BODY_SIZE", (raw) => {
  try {
    return { ok: true, value: parseSize(raw as Size) };
  } catch {
    return { ok: false, expected: 'a size such as "10mb" or "512kb"' };
  }
}).default(parseSize("10mb"));

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
      // Largest request body the server accepts; routes can only lower it with bodyLimit().
      maxBodySize,
      // Where LogMailer writes mail (src/shared/mailer.ts).
      outboxPath: env.string("OUTBOX_PATH").default("data/outbox.jsonl"),
      // Optional: chat rooms then reach clients on every instance (spec-6 §9).
      redisUrl: env.url("REDIS_URL").optional(),
      redisPrefix: env.string("REDIS_PREFIX").default("bun-hydrate:"),
    },
    source,
  );
}

export type AppConfig = ReturnType<typeof loadConfig>;
