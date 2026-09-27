export type PubSubMessage = string | Uint8Array;

/**
 * How `app.publish()` reaches WebSocket subscribers (spec-6 §9). Without one, publishing stays in
 * this process. With one (e.g. redisPubSub from @bun-hydrate/redis), every instance, this one
 * included, receives each message through the adapter and delivers it to its own sockets.
 */
export interface PubSub {
  publish(topic: string, message: PubSubMessage): Promise<void>;
  /** Delivers every published message; returns a function that stops the delivery. */
  subscribe(deliver: (topic: string, message: PubSubMessage) => void): Promise<() => Promise<void>>;
}

/** A PubSub shared by apps in one process: for tests and local development. */
export function memoryPubSub(): PubSub {
  const subscribers = new Set<(topic: string, message: PubSubMessage) => void>();
  return {
    async publish(topic, message) {
      for (const deliver of subscribers) deliver(topic, message);
    },
    async subscribe(deliver) {
      subscribers.add(deliver);
      return async () => void subscribers.delete(deliver);
    },
  };
}
