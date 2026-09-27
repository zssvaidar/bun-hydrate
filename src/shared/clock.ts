import { token } from "@bun-hydrate/di";

/** Injected so tests can pin "now". */
export const Clock = token<() => Date>("Clock");
