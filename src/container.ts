import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import type { AppConfig } from "./config";
import { Clock } from "./shared/clock";
import { LogMailer, Mailer } from "./shared/mailer";

/**
 * The services both processes share: the web app (src/app.ts) and the worker (src/worker.ts).
 * Jobs and listeners `inject` from it.
 */
export function createContainer({ config, db }: { config: AppConfig; db: Database }): Container {
  return new Container()
    .value(Database, db)
    .value(Clock, () => new Date())
    .value(Mailer, new LogMailer(config.outboxPath));
}
