/**
 * Permission matching shared by the server (requirePermission) and the browser (useCan / <Can>),
 * so wildcards mean exactly the same on both sides (spec-5 §8.3). Browser-safe: no Bun APIs.
 */

/** Every proper dot-prefix: "users.profile.read" → "users" | "users.profile". */
type Prefixes<P extends string> = P extends `${infer Head}.${infer Tail}` ? Head | `${Head}.${Prefixes<Tail>}` : never;

/** What a role may grant: a permission, a wildcard over a real prefix, or everything. */
export type PermissionPattern<P extends string> = P | `${Prefixes<P>}.*` | "*";

export type PermissionSubject = { readonly permissions: readonly string[] } | readonly string[] | null | undefined;

/** `*` grants everything; `users.*` grants `users.read` and `users.profile.read`, but not `users`. */
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === "*" || granted === required) return true;
  if (!granted.endsWith(".*")) return false;
  const prefix = granted.slice(0, -1); // keep the dot: "users."
  return required.startsWith(prefix) && required.length > prefix.length;
}

/** True when the subject holds every required permission. Anonymous subjects hold none. */
export function can(subject: PermissionSubject, ...required: string[]): boolean {
  if (!subject) return false;
  const granted = Array.isArray(subject) ? subject : (subject as { permissions: readonly string[] }).permissions;
  return required.every((permission) => granted.some((grant) => permissionMatches(grant, permission)));
}

export interface PolicyDefinition<P extends string = string> {
  roles: Record<string, readonly PermissionPattern<P>[]>;
}

export interface Policy {
  readonly roles: Readonly<Record<string, readonly string[]>>;
  /** The permission patterns granted by these roles, de-duplicated, in role order. Unknown roles grant nothing. */
  permissionsFor(roles: readonly string[]): string[];
}

export function definePolicy<P extends string = string>(definition: PolicyDefinition<P>): Policy {
  return {
    roles: definition.roles,
    permissionsFor: (roles) => [...new Set(roles.flatMap((role) => definition.roles[role] ?? []))],
  };
}

/**
 * Typed helpers for an app's permission list, so typos fail `tsc` on the server and the client:
 * `const permissions = createPermissions<Permission>()`.
 */
export function createPermissions<P extends string>() {
  return {
    can: (subject: PermissionSubject, ...required: P[]) => can(subject, ...required),
    definePolicy: (definition: PolicyDefinition<P>) => definePolicy<P>(definition),
  };
}
