import { expect, test } from "bun:test";
import { Container } from "@bun-hydrate/di";
import { createTestQueue } from "@bun-hydrate/testing/queue";
import { Mailer, type Mail } from "../shared/mailer";
import { sendWelcomeEmailJob } from "./send-welcome-email.job";

test("sends the welcome mail through the app's Mailer", async () => {
  const sent: Mail[] = [];
  const container = new Container().value(Mailer, { send: async (mail: Mail) => void sent.push(mail) });
  const queue = createTestQueue();

  await queue.dispatch(sendWelcomeEmailJob, { accountId: "a1", email: "ada@example.com" });
  await queue.runAll({ handlers: [sendWelcomeEmailJob], container });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: "ada@example.com", subject: "Welcome to bun-hydrate" });
  expect(await queue.dispatched(sendWelcomeEmailJob)).toEqual([]);
});
