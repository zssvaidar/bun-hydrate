/**
 * Every permission the app checks, shared by the server (requirePermission) and the browser
 * (useCan, <Can>), so a typo fails `tsc` on both sides. The lines between the markers are
 * maintained by `hydrate` (features and `generate module --auth`); add your own after them.
 */
export const PERMISSIONS = [
  // hydrate:permissions:start
  // hydrate:permissions:end
  "users.read",
  "users.create",
  "users.update",
  "users.delete",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
