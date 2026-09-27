import { defineListener } from "@bun-hydrate/events";
import { AppQueue } from "../../jobs/queue";
import { sendWelcomeEmailJob } from "../../jobs/send-welcome-email.job";
import { AccountRegistered } from "../account-registered.event";

/**
 * Durable: runs as a job on the worker, at least once. The idempotency key makes a retried or
 * repeated run queue the same mail job instead of a second one.
 */
export const welcomeEmailListener = defineListener(
  AccountRegistered,
  async (payload, { services: [queue] }) => {
    await queue.dispatch(sendWelcomeEmailJob, payload, { idempotencyKey: `welcome-email:${payload.accountId}` });
  },
  { durable: true, name: "welcome-email", inject: [AppQueue] },
);
