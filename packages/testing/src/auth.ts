import {
  definePolicy,
  generateJwtKeyPair,
  signJwt,
  type JwtClaims,
  type JwtKey,
  type PolicyDefinition,
  type Principal,
} from "@bun-hydrate/auth";

let keys: Promise<{ privateKey: JwtKey; publicKey: JwtKey }> | undefined;

/** A throwaway ES256 key pair, shared by the whole test run. Give `publicKey` to jwtStrategy. */
export function testKeys(): Promise<{ privateKey: JwtKey; publicKey: JwtKey }> {
  keys ??= generateJwtKeyPair("ES256", "test-key");
  return keys;
}

/** A valid token (5 minutes) signed with testKeys(). */
export async function signTestToken(claims: JwtClaims): Promise<string> {
  return signJwt(claims, (await testKeys()).privateKey, { expiresIn: "5m" });
}

export interface TestPrincipalOptions {
  id?: string;
  kind?: Principal["kind"];
  roles?: string[];
  permissions?: string[];
  via?: Principal["via"];
  /** Resolves roles the way authenticate() would. */
  policy?: PolicyDefinition;
}

/** A principal for unit-testing services and policies, without HTTP or a database. */
export function createTestPrincipal(options: TestPrincipalOptions = {}): Principal {
  const roles = options.roles ?? [];
  const fromRoles = options.policy ? definePolicy(options.policy).permissionsFor(roles) : [];
  return {
    id: options.id ?? "test-user",
    kind: options.kind ?? "user",
    roles,
    permissions: [...new Set([...(options.permissions ?? []), ...fromRoles])],
    via: options.via ?? "session",
  };
}
