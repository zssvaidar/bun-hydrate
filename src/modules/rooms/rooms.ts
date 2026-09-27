import { requirePrincipal } from "@bun-hydrate/auth";
import { BadRequestError, type App } from "@bun-hydrate/core";

const ROOM = /^[a-z0-9-]{1,40}$/;
const MAX_MESSAGE = 500;

interface Member {
  room: string;
  name: string;
}

/**
 * A chat room at /ws/rooms/:room for signed-in users. The upgrade runs through the normal
 * middleware (authentication, origin check), so an anonymous or cross-site upgrade gets an HTTP
 * error instead of a socket. Messages go to everyone in the room, sender included.
 */
export function roomsWebSocket(app: App): App {
  const topic = (room: string) => `room:${room}`;

  return app.websocket("/ws/rooms/:room", {
    upgrade(ctx): Member {
      const principal = requirePrincipal(ctx);
      if (!ROOM.test(ctx.params.room)) throw new BadRequestError("Room names are 1-40 of a-z, 0-9 and -");
      const email = principal.claims?.email;
      return { room: ctx.params.room, name: typeof email === "string" ? email : principal.id };
    },
    open(ws) {
      ws.subscribe(topic(ws.data.room));
    },
    message(ws, message) {
      const text = String(message).slice(0, MAX_MESSAGE);
      app.publish(topic(ws.data.room), JSON.stringify({ from: ws.data.name, text }));
    },
  });
}
