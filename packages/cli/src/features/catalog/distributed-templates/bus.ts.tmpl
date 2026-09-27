import type { App } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { token, type Container } from "@bun-hydrate/di";
import { createEventBus, type EventBus } from "@bun-hydrate/events";
import { AppQueue } from "../jobs/queue";
import { allListeners } from "./index";

/** Emit with `container.get(AppEvents).emit(AccountRegistered, payload)`. */
export const AppEvents = token<EventBus>("AppEvents");

/**
 * The event bus (spec-6 §6) with every listener in src/events/listeners (`allListeners`).
 * In-process listeners run after the emitting transaction commits; durable ones are jobs on
 * AppQueue, run by the worker. For broadcast() across instances, pass
 * `transport: container.get(AppRedis)` and call `events.listen()` in an onStart hook.
 */
export function installEvents(app: App, container: Container): void {
  const events = createEventBus({
    queue: container.get(AppQueue),
    db: container.get(Database),
    container,
    logger: app.logger,
  }).register(...allListeners);
  container.value(AppEvents, events);
  // On shutdown, listeners already running finish before connections close.
  app.onDrain(() => events.idle());
}
