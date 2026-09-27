import { afterEach, describe, expect, test } from "bun:test";
import { childTrace, createLogger, runWithTrace, type LogFields } from "@bun-hydrate/core";
import { createDatabase, parseMigration, type Database } from "@bun-hydrate/database";
import { Container, token } from "@bun-hydrate/di";
import { DatabaseQueueAdapter, JOBS_MIGRATION, createQueue, createWorker } from "@bun-hydrate/queue";
import { createRedis } from "@bun-hydrate/redis";
import { createTestQueue } from "@bun-hydrate/testing/queue";
import { schema } from "@bun-hydrate/validation";
import { EventPayloadError, createEventBus, defineEvent, memoryTransport } from "../src";

const silent = createLogger({ level: "silent" });
const UserRegistered = defineEvent("user.registered", schema.object({ userId: schema.string(), email: schema.email().trim() }));
const databases: Database[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

async function database() {
  const db = createDatabase({ url: "sqlite://:memory:" });
  await db.sql.unsafe(parseMigration("jobs", JOBS_MIGRATION).up);
  await db.sql`create table users (id varchar(36) primary key)`;
  databases.push(db);
  return db;
}

describe("in-process listeners", () => {
  test("receive the validated payload, the event name and the emitter's trace", async () => {
    const events = createEventBus({ logger: silent });
    const seen: unknown[] = [];
    events.on(UserRegistered, (payload, { event, traceId }) => void seen.push({ payload, event, traceId }));

    const trace = childTrace(undefined);
    await runWithTrace(trace, () => events.emit(UserRegistered, { userId: "u1", email: " ada@example.com " }));
    await events.idle();

    expect(seen).toEqual([{ payload: { userId: "u1", email: "ada@example.com" }, event: "user.registered", traceId: trace.traceId }]);
  });

  test("an invalid payload is refused at emit", async () => {
    const events = createEventBus({ logger: silent });
    const error = await events.emit(UserRegistered, { userId: "u1", email: "nope" }).catch((e) => e);
    expect(error).toBeInstanceOf(EventPayloadError);
    expect(error.message).toBe('Invalid payload for event "user.registered": email: Must be a valid email address');
  });

  test("run after the emitting transaction commits, and never after a rollback", async () => {
    const db = await database();
    const events = createEventBus({ db, logger: silent });
    const seen: string[] = [];
    events.on(UserRegistered, ({ userId }) => void seen.push(userId));

    await db.transaction(async () => {
      await events.emit(UserRegistered, { userId: "kept", email: "a@b.co" });
      await events.idle();
      expect(seen).toEqual([]);
    });
    await db.transaction(async () => {
      await events.emit(UserRegistered, { userId: "undone", email: "a@b.co" });
      throw new Error("rollback");
    }).catch(() => {});
    await events.idle();

    expect(seen).toEqual(["kept"]);
  });

  test("a failing listener is logged and counted; the emitter and other listeners carry on", async () => {
    const lines: LogFields[] = [];
    const failures: string[] = [];
    const events = createEventBus({
      logger: createLogger({ format: "json", write: (line) => void lines.push(JSON.parse(line)) }),
      onListenerFailed: ({ event, listener }) => void failures.push(`${event}/${listener}`),
    });
    const seen: string[] = [];
    events.on(UserRegistered, () => {
      throw new Error("listener bug");
    }, { name: "buggy" });
    events.on(UserRegistered, ({ userId }) => void seen.push(userId));

    await events.emit(UserRegistered, { userId: "u1", email: "a@b.co" });
    await events.idle();

    expect(seen).toEqual(["u1"]);
    expect(failures).toEqual(["user.registered/buggy"]);
    expect(lines.find((line) => line.msg === "Event listener failed")).toMatchObject({ event: "user.registered", listener: "buggy" });
  });

  test("emit does not wait for slow listeners; idle() does", async () => {
    const events = createEventBus({ logger: silent });
    let done = false;
    events.on(UserRegistered, async () => {
      await Bun.sleep(30);
      done = true;
    });

    await events.emit(UserRegistered, { userId: "u1", email: "a@b.co" });
    expect(done).toBe(false);
    await events.idle();
    expect(done).toBe(true);
  });

  test("on() returns a function that removes the listener", async () => {
    const events = createEventBus({ logger: silent });
    const seen: string[] = [];
    const off = events.on(UserRegistered, ({ userId }) => void seen.push(userId));
    off();
    await events.emit(UserRegistered, { userId: "u1", email: "a@b.co" });
    await events.idle();
    expect(seen).toEqual([]);
  });

  test("two different events cannot share a name", () => {
    const events = createEventBus({ logger: silent });
    events.on(UserRegistered, () => {});
    const impostor = defineEvent("user.registered", schema.object({}));
    expect(() => events.on(impostor, () => {})).toThrow('Two different events are named "user.registered"');
  });
});

describe("durable listeners (spec-6 §6.2)", () => {
  test("become jobs: dispatched on emit, run by a worker with services, retried like any job", async () => {
    const Mailer = token<{ send(to: string): void }>("Mailer");
    const sent: string[] = [];
    const queue = createTestQueue();
    const events = createEventBus({ queue, logger: silent });
    events.on(UserRegistered, ({ email }, { services: [mailer] }) => mailer.send(email), {
      durable: true,
      name: "send-welcome",
      inject: [Mailer] as const,
      retry: { attempts: 5 },
    });

    await events.emit(UserRegistered, { userId: "u1", email: "ada@example.com" });
    const [job] = events.jobs();
    expect(job).toMatchObject({ name: "event:user.registered:send-welcome", retry: { attempts: 5 } });
    expect(await queue.dispatched(job!)).toEqual([{ userId: "u1", email: "ada@example.com" }]);

    await queue.runAll({ handlers: events.jobs(), container: new Container().value(Mailer, { send: (to) => void sent.push(to) }) });
    expect(sent).toEqual(["ada@example.com"]);
  });

  test("with the database queue, the job is written in the emitter's transaction (the outbox)", async () => {
    const db = await database();
    const adapter = new DatabaseQueueAdapter({ db });
    const events = createEventBus({ db, queue: createQueue({ adapter, db }), logger: silent });
    events.on(UserRegistered, () => {}, { durable: true, name: "welcome" });

    await db.transaction(async () => {
      await db.sql`insert into users (id) values (${"u1"})`;
      await events.emit(UserRegistered, { userId: "u1", email: "a@b.co" });
      throw new Error("rollback");
    }).catch(() => {});
    expect((await adapter.list()).items).toEqual([]);

    await db.transaction(async () => {
      await db.sql`insert into users (id) values (${"u2"})`;
      await events.emit(UserRegistered, { userId: "u2", email: "a@b.co" });
    });
    expect((await adapter.list()).items.map((job) => job.name)).toEqual(["event:user.registered:welcome"]);

    const ran: string[] = [];
    events.on(UserRegistered, ({ userId }) => void ran.push(userId), { durable: true, name: "audit" });
    const worker = createWorker({ queue: createQueue({ adapter, db }), handlers: events.jobs(), logger: silent, poll: { min: 5, max: 10 }, signals: false });
    await events.emit(UserRegistered, { userId: "u3", email: "a@b.co" });
    await worker.start();
    for (let i = 0; i < 100 && ran.length === 0; i++) await Bun.sleep(10);
    await worker.stop();
    expect(ran).toEqual(["u3"]);
  });

  test("need a name, and a queue on the bus", () => {
    expect(() => createEventBus({ logger: silent }).on(UserRegistered, () => {}, { durable: true, name: "x" })).toThrow(
      "Durable listeners need a queue: createEventBus({ queue })",
    );
    const events = createEventBus({ queue: createTestQueue(), logger: silent });
    expect(() => events.on(UserRegistered, () => {}, { durable: true } as never)).toThrow("Durable listeners need a name");
    events.on(UserRegistered, () => {}, { durable: true, name: "once" });
    expect(() => events.on(UserRegistered, () => {}, { durable: true, name: "once" })).toThrow('"user.registered" already has a listener named "once"');
  });
});

describe("broadcast (spec-6 §6.2)", () => {
  test("reaches the in-process listeners of every instance, once each", async () => {
    const transport = memoryTransport();
    const [a, b] = [createEventBus({ transport, logger: silent }), createEventBus({ transport, logger: silent })];
    const seen: string[] = [];
    a.on(UserRegistered, ({ userId }) => void seen.push(`a:${userId}`));
    b.on(UserRegistered, ({ userId }) => void seen.push(`b:${userId}`));
    const stops = await Promise.all([a.listen(), b.listen()]);

    await a.broadcast(UserRegistered, { userId: "u1", email: "a@b.co" });
    await Bun.sleep(5);
    await Promise.all([a.idle(), b.idle()]);
    expect(seen.sort()).toEqual(["a:u1", "b:u1"]);
    await Promise.all(stops.map((stop) => stop()));
  });

  test.if(Boolean(process.env.TEST_REDIS_URL))("works across processes through Redis", async () => {
    const prefix = `test:${crypto.randomUUID()}:`;
    const [ra, rb] = [createRedis({ url: process.env.TEST_REDIS_URL!, prefix }), createRedis({ url: process.env.TEST_REDIS_URL!, prefix })];
    const a = createEventBus({ transport: ra, channel: ra.key("events"), logger: silent });
    const b = createEventBus({ transport: rb, channel: rb.key("events"), logger: silent });
    const seen: string[] = [];
    b.on(UserRegistered, ({ userId }) => void seen.push(userId));
    await Promise.all([a.listen(), b.listen()]);

    await a.broadcast(UserRegistered, { userId: "u1", email: "a@b.co" });
    for (let i = 0; i < 100 && seen.length === 0; i++) await Bun.sleep(5);
    expect(seen).toEqual(["u1"]);
    await Promise.all([ra.close(), rb.close()]);
  });
});

describe("defineListener() + register()", () => {
  test("listeners can live in their own files and be registered together", async () => {
    const { defineListener } = await import("../src");
    const seen: string[] = [];
    const local = defineListener(UserRegistered, ({ userId }) => void seen.push(userId), { name: "remember" });
    const durable = defineListener(UserRegistered, () => {}, { durable: true, name: "welcome" });
    const events = createEventBus({ queue: createTestQueue(), logger: silent });

    events.register(local, durable);
    await events.emit(UserRegistered, { userId: "u1", email: "a@b.co" });
    await events.idle();

    expect(seen).toEqual(["u1"]);
    expect(events.jobs().map((job) => job.name)).toEqual(["event:user.registered:welcome"]);
  });
});
