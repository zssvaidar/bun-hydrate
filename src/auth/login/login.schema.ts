import { MAX_PASSWORD_LENGTH } from "@bun-hydrate/auth";
import { schema, type Infer } from "@bun-hydrate/validation";
import { MIN_PASSWORD_LENGTH } from "../passwords";

const email = schema.email().max(320);

export const Credentials = schema.object({
  email,
  // Any length is checked against the hash, so login never hints at the password rules.
  password: schema.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const Registration = schema.object({
  email,
  password: schema.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

export type Credentials = Infer<typeof Credentials>;
export type Registration = Infer<typeof Registration>;
