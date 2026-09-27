import { defineAuthFeature } from "@bun-hydrate/auth";
import { LoadPrincipal } from "@bun-hydrate/auth/features";
import { AccountRepository } from "./accounts";

/**
 * The app side of auth:core: accounts, and how a signed-in account becomes a principal. The
 * email travels as a claim so the snapshot mapper in config.ts can show it.
 */
export const coreFeature = defineAuthFeature({
  id: "auth:core",
  register(container) {
    if (!container.has(AccountRepository)) container.bind(AccountRepository);
    container.factory(LoadPrincipal, (resolver) => {
      const accounts = resolver.get(AccountRepository);
      return async (id) => {
        const account = await accounts.findById(id);
        return account && { id: account.id, kind: "user", roles: [account.role], claims: { email: account.email } };
      };
    });
  },
});
