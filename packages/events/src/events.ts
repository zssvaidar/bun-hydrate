import {
  childTrace,
  createLogger,
  currentTrace,
  formatTraceparent,
  parseTraceparent,
  runWithTrace,
  type Duration,
  type Logger,
  type TraceContext,
  type TraceParent,
} from "@bun-hydrate/core";
import type { Database } from "@bun-hydrate/database";
import type { Container, Key } from "@bun-hydrate/di";
import { defineJob, type JobDefinition, type Queue, type RetryPolicy } from "@bun-hydrate/queue";
import type { StandardSchemaV1 } from "@bun-hydrate/validation";

export interface EventDefinition<Payload = any> {
  readonly name: string;
  readonly payload: StandardSchemaV1<unknown, Payload>;
}

const EVENT_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** A named, validated event (spec-6 §6.1). Names are dotted and past tense: "order.shipped". */
export function defineEvent<Payload>(name: string, payload: StandardSchemaV1<unknown, Payload>): EventDefinition<Payload> {
  if (!EVENT_NAME.test(name)) throw new Error(`Event names are lower-case words joined by . _ or - (got "${name}")`);
  return { name, payload };
}

export class EventPayloadError extends Error {
  override name = "EventPayloadError";
  constructor(
    readonly event: string,
    readonly issues: readonly StandardSchemaV1.Issue[],
  ) {
    super(`Invalid payload for event "${event}": ${issues.map(describeIssue).join("; ")}`);
  }
}

function describeIssue(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment)).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

type Resolved<Deps extends readonly Key<unknown>[]> = {
  -readonly [I in keyof Deps]: Deps[I] extends Key<infer T> ? T : never;
};

export interface ListenerContext<Deps extends readonly Key<unknown>[] = []> {
  event: string;
  log: Logger;
  traceId: string;
  services: Resolved<Deps>;
}

export type Listener<Payload, Deps extends readonly Key<unknown>[]> = (payload: Payload, context: ListenerContext<Deps>) => unknown;

export interface InProcessListenerOptions<Deps extends readonly Key<unknown>[]> {
  durable?: false;
  /** For logs and metrics. Default: the function's name. */
  name?: string;
  /** Resolved from the bus's container. */
  inject?: Deps;
}

export interface DurableListenerOptions<Deps extends readonly Key<unknown>[]> {
  /** Runs as a job: at least once, retried, on any worker (spec-6 §6.2). */
  durable: true;
  /** Unique per event; part of the job name `event:<event>:<name>`, so keep it stable. */
  name: string;
  inject?: Deps;
  retry?: Partial<RetryPolicy>;
  timeout?: Duration;
  queue?: string;
  priority?: number;
}

/** Where broadcasts travel: the Redis manager fits, and memoryTransport() for tests. */
export interface EventTransport {
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<() => Promise<void>>;
}

export interface EventBusOptions {
  /** Needed for durable listeners. */
  queue?: Queue;
  /** In-process listeners wait for the emitter's transaction to commit. */
  db?: Database;
  /** Services for listeners' `inject`. */
  container?: Container;
  /** For broadcast() across instances. */
  transport?: EventTransport;
  /** Default: "hydrate:events". With Redis, use redis.key("events"). */
  channel?: string;
  logger?: Logger;
  onEmitted?: (event: { event: string; broadcast: boolean }) => void;
  onListenerFailed?: (event: { event: string; listener: string }) => void;
}

interface LocalListener {
  name: string;
  handler: Listener<any, any>;
  inject: readonly Key<unknown>[];
}

interface Registered {
  definition: EventDefinition;
  local: LocalListener[];
  durable: Map<string, JobDefinition>;
}

/** Emits events to in-process listeners, durable listeners (as jobs) and other instances (spec-6 §6). */
export class EventBus {
  private readonly events = new Map<string, Registered>();
  private readonly pending = new Set<Promise<void>>();
  private readonly logger: Logger;
  private readonly channel: string;
  private anonymous = 0;

  constructor(private readonly options: EventBusOptions = {}) {
    this.logger = options.logger ?? createLogger();
    this.channel = options.channel ?? "hydrate:events";
  }

  on<Payload, const Deps extends readonly Key<unknown>[] = []>(
    event: EventDefinition<Payload>,
    handler: Listener<Payload, Deps>,
    options: InProcessListenerOptions<Deps> | DurableListenerOptions<Deps> = {},
  ): () => void {
    const registered = this.register(event);
    const inject = options.inject ?? [];

    if (options.durable) {
      if (!this.options.queue) throw new Error("Durable listeners need a queue: createEventBus({ queue })");
      if (!options.name) throw new Error("Durable listeners need a name");
      if (registered.durable.has(options.name)) throw new Error(`"${event.name}" already has a listener named "${options.name}"`);
      const job = defineJob({
        name: `event:${event.name}:${options.name}`,
        payload: event.payload,
        queue: options.queue,
        priority: options.priority,
        retry: options.retry,
        timeout: options.timeout,
        inject: inject as Deps,
        handle: (payload, context) =>
          handler(payload, { event: event.name, log: context.log, traceId: context.job.traceId, services: context.services as Resolved<Deps> }),
      });
      registered.durable.set(options.name, job);
      return () => void registered.durable.delete(options.name);
    }

    if (inject.length > 0 && !this.options.container) throw new Error("Listeners with `inject` need createEventBus({ container })");
    const listener: LocalListener = { name: options.name ?? (handler.name || `listener-${++this.anonymous}`), handler, inject };
    registered.local.push(listener);
    return () => void registered.local.splice(registered.local.indexOf(listener), 1);
  }

  /** Job definitions of the durable listeners: give them to the worker's `handlers`. */
  jobs(): JobDefinition[] {
    return [...this.events.values()].flatMap((registered) => [...registered.durable.values()]);
  }

  /**
   * Validates the payload, enqueues one job per durable listener (inside the caller's transaction
   * with the database queue), and schedules in-process listeners after the commit. Does not wait
   * for in-process listeners: see idle().
   */
  async emit<Payload>(event: EventDefinition<Payload>, payload: NoInfer<Payload>): Promise<void> {
    const registered = this.register(event);
    const value = await this.validate(event, payload);
    for (const job of registered.durable.values()) await this.options.queue!.dispatch(job, value);

    const trace = currentTrace();
    const deliver = () => this.deliver(event.name, value, trace);
    if (this.options.db) await this.options.db.afterCommit(deliver);
    else deliver();
    this.options.onEmitted?.({ event: event.name, broadcast: false });
  }

  /** Delivers to the in-process listeners of every instance (at most once; spec-6 §6.2). */
  async broadcast<Payload>(event: EventDefinition<Payload>, payload: NoInfer<Payload>): Promise<void> {
    this.register(event);
    const value = await this.validate(event, payload);
    const trace = currentTrace();
    this.options.onEmitted?.({ event: event.name, broadcast: true });
    if (!this.options.transport) return this.deliver(event.name, value, trace);
    const message = JSON.stringify({ event: event.name, payload: value, traceParent: trace && formatTraceparent(trace) });
    await this.options.transport.publish(this.channel, message);
  }

  /** Receives broadcasts from other instances (and this one). Returns a function that stops listening. */
  async listen(): Promise<() => Promise<void>> {
    const transport = this.options.transport;
    if (!transport) return async () => {};
    return transport.subscribe(this.channel, (message) => void this.receive(message));
  }

  /** Resolves once every in-process listener started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private async receive(message: string): Promise<void> {
    try {
      const { event, payload, traceParent } = JSON.parse(message) as { event: string; payload: unknown; traceParent?: string };
      const registered = this.events.get(event);
      if (!registered) return; // this instance has no listeners for it
      const value = await this.validate(registered.definition, payload);
      this.deliver(event, value, parseTraceparent(traceParent ?? null));
    } catch (error) {
      this.logger.error("Dropped a broadcast event that could not be read", { error });
    }
  }

  /** Runs each in-process listener in a new span of the emitter's trace. */
  private deliver(event: string, value: unknown, trace: TraceContext | TraceParent | undefined): void {
    for (const listener of this.events.get(event)?.local ?? []) {
      const run = this.run(event, listener, value, trace).finally(() => this.pending.delete(run));
      this.pending.add(run);
    }
  }

  private run(event: string, listener: LocalListener, value: unknown, parent: TraceContext | TraceParent | undefined): Promise<void> {
    const trace = childTrace(parent);
    const log = this.logger.child({ event, listener: listener.name, traceId: trace.traceId });
    return runWithTrace(trace, async () => {
      try {
        const services = listener.inject.map((key) => this.options.container!.get(key));
        await listener.handler(value, { event, log, traceId: trace.traceId, services });
      } catch (error) {
        log.error("Event listener failed", { error });
        this.options.onListenerFailed?.({ event, listener: listener.name });
      }
    });
  }

  private register(event: EventDefinition): Registered {
    const existing = this.events.get(event.name);
    if (existing && existing.definition !== event) throw new Error(`Two different events are named "${event.name}"`);
    if (existing) return existing;
    const registered: Registered = { definition: event, local: [], durable: new Map() };
    this.events.set(event.name, registered);
    return registered;
  }

  private async validate<Payload>(event: EventDefinition<Payload>, payload: unknown): Promise<Payload> {
    const result = await event.payload["~standard"].validate(payload);
    if (result.issues) throw new EventPayloadError(event.name, result.issues);
    return result.value;
  }
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  return new EventBus(options);
}

/** Broadcasts between buses in one process (tests, single instance). */
export function memoryTransport(): EventTransport {
  const channels = new Map<string, Set<(message: string, channel: string) => void>>();
  return {
    async publish(channel, message) {
      const listeners = channels.get(channel) ?? new Set();
      for (const listener of listeners) queueMicrotask(() => listener(message, channel));
      return listeners.size;
    },
    async subscribe(channel, listener) {
      const listeners = channels.get(channel) ?? new Set();
      channels.set(channel, listeners.add(listener));
      return async () => void listeners.delete(listener);
    },
  };
}
