import { Router } from "@bun-hydrate/core";
import type { UsersController } from "./users.controller";

export function usersRoutes(controller: UsersController): Router {
  return new Router()
    .get("/", controller.list)
    .post("/", controller.create)
    .get("/:id", controller.get)
    .patch("/:id", controller.update)
    .delete("/:id", controller.remove);
}
