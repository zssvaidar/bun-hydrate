import type { PubSub, PubSubMessage } from "@bun-hydrate/core";
import type { Redis } from "./redis";

interface Envelope {
  topic: string;
  /** Text message. */
  text?: string;
  /** Binary message, base64. */
  binary?: string;
}

/**
 * WebSocket fan-out through Redis (spec-6 §9): `new App({ pubsub: redisPubSub(redis) })`. All
 * topics share one channel of envelopes, because pattern subscriptions don't take a listener in
 * Bun 1.3.11. Every instance, the publisher included, delivers from that channel, so ordering is
 * the same everywhere.
 */
export function redisPubSub(redis: Redis, channel = redis.key("ws")): PubSub {
  return {
    async publish(topic: string, message: PubSubMessage) {
      const envelope: Envelope =
        typeof message === "string" ? { topic, text: message } : { topic, binary: Buffer.from(message).toString("base64") };
      await redis.publish(channel, JSON.stringify(envelope));
    },
    subscribe(deliver) {
      return redis.subscribe(channel, (raw) => {
        const envelope = JSON.parse(raw) as Envelope;
        deliver(envelope.topic, envelope.binary === undefined ? (envelope.text ?? "") : new Uint8Array(Buffer.from(envelope.binary, "base64")));
      });
    },
  };
}
