import { describe, expect, test } from "bun:test";
import { memoryPubSub } from "@bun-hydrate/core";
import { createEventBus, defineEvent } from "@bun-hydrate/events";
import { MemoryQueueAdapter, createQueue, createWorker, defineJob } from "@bun-hydrate/queue";
import { MemoryStorage } from "@bun-hydrate/storage";
import { createLogger } from "@bun-hydrate/core";
import { schema } from "@bun-hydrate/validation";
import { createMetrics } from "../src";

const silent = createLogger({ level: "silent" });
const line = (text: string, name: string) => text.split("\n").find((l) => l.startsWith(name));

describe("job, event, pub/sub and storage metrics (spec-6 §13)", () => {
  test("jobs: dispatched, finished by outcome, duration and queue latency", async () => {
    const metrics = createMetrics({ processMetrics: false });
    const observer = metrics.jobObserver();
    const queue = createQueue({ adapter: new MemoryQueueAdapter(), onDispatch: observer.onDispatch });
    let calls = 0;
    const flaky = defineJob({ name: "flaky", payload: schema.object({}), retry: { attempts: 2, backoff: () => 0 }, handle() {
      if (++calls === 1) throw new Error("once");
    } });
    const worker = createWorker({ queue, handlers: [flaky], logger: silent, poll: { min: 5, max: 10 }, signals: false, onFinished: observer.onFinished });

    await queue.dispatch(flaky, {}, { idempotencyKey: "k" });
    await queue.dispatch(flaky, {}, { idempotencyKey: "k" });
    await worker.start();
    for (let i = 0; i < 200 && calls < 2; i++) await Bun.sleep(5);
    await Bun.sleep(20);
    await worker.stop();

    const text = metrics.render();
    expect(text).toContain('jobs_dispatched_total{queue="default",job="flaky",deduplicated="false"} 1');
    expect(text).toContain('jobs_dispatched_total{queue="default",job="flaky",deduplicated="true"} 1');
    expect(text).toContain('jobs_finished_total{queue="default",job="flaky",outcome="retry"} 1');
    expect(text).toContain('jobs_finished_total{queue="default",job="flaky",outcome="completed"} 1');
    expect(text).toContain('job_duration_seconds_count{queue="default",job="flaky"} 2');
    expect(text).toContain('job_queue_latency_seconds_count{queue="default",job="flaky"} 2');
    metrics.close();
  });

  test("queue depth is sampled into a gauge by queue and state", async () => {
    const metrics = createMetrics({ processMetrics: false });
    const adapter = new MemoryQueueAdapter();
    const queue = createQueue({ adapter });
    const job = defineJob({ name: "waiting", payload: schema.object({}), queue: "mail", handle() {} });
    await queue.dispatch(job, {});
    await queue.dispatch(job, {});

    const stop = metrics.observeQueueDepth(adapter, { interval: 10 });
    await Bun.sleep(30);
    stop();
    expect(metrics.render()).toContain('jobs{queue="mail",state="pending"} 2');
    metrics.close();
  });

  test("events: emitted and listener failures", async () => {
    const metrics = createMetrics({ processMetrics: false });
    const events = createEventBus({ logger: silent, ...metrics.eventObserver() });
    const Happened = defineEvent("thing.happened", schema.object({}));
    events.on(Happened, () => {
      throw new Error("bug");
    }, { name: "buggy" });

    await events.emit(Happened, {});
    await events.idle();
    const text = metrics.render();
    expect(text).toContain('events_emitted_total{event="thing.happened",broadcast="false"} 1');
    expect(text).toContain('event_listener_failures_total{event="thing.happened",listener="buggy"} 1');
    metrics.close();
  });

  test("pub/sub: messages out and in, and failures", async () => {
    const metrics = createMetrics({ processMetrics: false });
    const pubsub = metrics.observePubSub(memoryPubSub());
    await pubsub.subscribe(() => {});
    await pubsub.publish("room", "hi");
    expect(metrics.render()).toContain('pubsub_messages_total{direction="out",outcome="ok"} 1');
    expect(metrics.render()).toContain('pubsub_messages_total{direction="in",outcome="ok"} 1');

    const broken = metrics.observePubSub({ publish: async () => { throw new Error("redis down"); }, subscribe: async () => async () => {} });
    expect(broken.publish("room", "lost")).rejects.toThrow("redis down");
    await Bun.sleep(1);
    expect(metrics.render()).toContain('pubsub_messages_total{direction="out",outcome="error"} 1');
    metrics.close();
  });

  test("storage: operations by adapter, operation and outcome", async () => {
    const metrics = createMetrics({ processMetrics: false });
    const storage = metrics.observeStorage(new MemoryStorage(), "memory");
    await storage.put("a.txt", "x");
    await storage.get("a.txt");
    await storage.put("", "x").catch(() => {});
    const text = metrics.render();
    expect(text).toContain('storage_operations_total{adapter="memory",operation="put",outcome="ok"} 1');
    expect(text).toContain('storage_operations_total{adapter="memory",operation="get",outcome="ok"} 1');
    expect(text).toContain('storage_operations_total{adapter="memory",operation="put",outcome="error"} 1');
    expect(line(text, "storage_operations_total") !== undefined).toBe(true);
    metrics.close();
  });
});
