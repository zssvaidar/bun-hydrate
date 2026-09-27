import { defineEvent } from "@bun-hydrate/events";
import { schema } from "@bun-hydrate/validation";

/** Emitted by POST /api/v1/auth/register in the same transaction that creates the account. */
export const AccountRegistered = defineEvent("account.registered", schema.object({ accountId: schema.string(), email: schema.email() }));
