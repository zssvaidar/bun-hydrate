import { SessionManager } from "@bun-hydrate/auth";
import { defineJob } from "@bun-hydrate/queue";
import { schema } from "@bun-hydrate/validation";

/** Hourly (src/worker.ts): deletes sessions past their idle or absolute limit, so the table stays small. */
export const cleanupExpiredSessionsJob = defineJob({
  name: "cleanup-expired-sessions",
  payload: schema.object({}),
  inject: [SessionManager],
  async handle(_payload, { log, services: [sessions] }) {
    log.info("Expired sessions deleted", { deleted: await sessions.purgeExpired() });
  },
});
