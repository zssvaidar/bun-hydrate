import { defineJob } from "@bun-hydrate/queue";
import { schema } from "@bun-hydrate/validation";
import { Mailer } from "../shared/mailer";

/** Queued by the welcome-email listener once per new account. Retried with backoff if the mailer fails. */
export const sendWelcomeEmailJob = defineJob({
  name: "send-welcome-email",
  payload: schema.object({ accountId: schema.string(), email: schema.email() }),
  retry: { attempts: 5 },
  timeout: "30s",
  inject: [Mailer],
  async handle({ email }, { log, services: [mailer] }) {
    await mailer.send({
      to: email,
      subject: "Welcome to bun-hydrate",
      text: `Hello ${email},\n\nyour account is ready. Sign in at /login.\n`,
    });
    log.info("Welcome mail sent", { to: email });
  },
});
