import { requireAuth, requirePermission } from "@bun-hydrate/auth";
import { Router } from "@bun-hydrate/core";
import type { UsersController } from "./users.controller";

/** Listing, creating and deleting need a permission; reading and editing one entry is also allowed for its owner. */
export function usersRoutes(controller: UsersController): Router {
  return new Router()
    .get("/", requirePermission("users.read"), controller.list)
    .post("/", requirePermission("users.create"), controller.create)
    .get("/:id", requireAuth(), controller.get)
    .patch("/:id", requireAuth(), controller.update)
    .delete("/:id", requirePermission("users.delete"), controller.remove);
}
