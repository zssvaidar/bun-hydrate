import { schema, type Infer } from "@bun-hydrate/validation";

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

const name = schema.string().trim().min(2).max(100);
const email = schema.email().trim().max(255);

export const UserParams = schema.object({ id: schema.uuid() });

export const ListUsersQuery = schema.object({
  limit: schema.coerce.integer().min(1).max(100).default(20),
  cursor: schema.uuid().optional(),
});

export const CreateUserBody = schema.object({ name, email });

export const UpdateUserBody = schema
  .object({ name: name.optional(), email: email.optional() })
  .refine((changes) => Object.keys(changes).length > 0, "Provide at least one field to update");

export type ListUsersQuery = Infer<typeof ListUsersQuery>;
export type CreateUser = Infer<typeof CreateUserBody>;
export type UpdateUser = Infer<typeof UpdateUserBody>;
