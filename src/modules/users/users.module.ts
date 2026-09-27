import type { Router } from "@bun-hydrate/core";
import type { Container } from "@bun-hydrate/di";
import { UsersController } from "./users.controller";
import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";
import { usersRoutes } from "./users.routes";

/** Registers the module's classes and returns its routes. Needs Database and Clock in the container. */
export function usersModule(container: Container): Router {
  container.bind(UsersRepository).bind(UsersService).bind(UsersController);
  return usersRoutes(container.get(UsersController));
}
