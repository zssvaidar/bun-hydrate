/** Current argon2id parameters (spec-5 §3.2); hashes made with others are upgraded on next login. */
const ARGON2 = { algorithm: "argon2id", memoryCost: 65536, timeCost: 2 } as const;
const CURRENT_PARAMS = `$argon2id$v=19$m=${ARGON2.memoryCost},t=${ARGON2.timeCost},p=1$`;

/** Longer inputs are refused: hashing megabytes of "password" is a cheap way to burn CPU. */
export const MAX_PASSWORD_LENGTH = 1024;

let dummyHash: Promise<string> | undefined;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length > MAX_PASSWORD_LENGTH) throw new RangeError("Password is too long");
  return Bun.password.hash(plain, ARGON2);
}

/**
 * With no stored hash (unknown user) this still verifies against a dummy hash, so the response
 * takes as long as a real check and timing does not reveal which accounts exist.
 */
export async function verifyPassword(plain: string, hash: string | undefined | null): Promise<boolean> {
  if (plain.length > MAX_PASSWORD_LENGTH) return false;
  if (!hash) {
    dummyHash ??= Bun.password.hash("dummy-password-for-timing", ARGON2);
    await Bun.password.verify(plain, await dummyHash);
    return false;
  }
  return Bun.password.verify(plain, hash);
}

/** True when the hash uses another algorithm or older parameters than hashPassword() does now. */
export function needsRehash(hash: string): boolean {
  return !hash.startsWith(CURRENT_PARAMS);
}
