import { expect, test } from "bun:test";
import { Container } from "@bun-hydrate/di";
import { createEventBus } from "@bun-hydrate/events";
import { createTestQueue } from "@bun-hydrate/testing/queue";
import { AppQueue } from "../../jobs/queue";
import { sendWelcomeEmailJob } from "../../jobs/send-welcome-email.job";
import { AccountRegistered } from "../account-registered.event";
import { welcomeEmailListener } from "./welcome-email.listener";

test("a registration queues exactly one welcome mail, however often the listener runs", async () => {
  const queue = createTestQueue();
  const container = new Container().value(AppQueue, queue);
  const events = createEventBus({ queue, container }).register(welcomeEmailListener);

  // Durable listeners run at least once: a retry or a duplicate emit must not mail twice.
  await events.emit(AccountRegistered, { accountId: "a1", email: "ada@example.com" });
  await events.emit(AccountRegistered, { accountId: "a1", email: "ada@example.com" });
  await queue.runAll({ handlers: events.jobs(), container });

  expect(await queue.dispatched(sendWelcomeEmailJob)).toEqual([{ accountId: "a1", email: "ada@example.com" }]);
});
