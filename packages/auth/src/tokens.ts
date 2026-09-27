import { timingSafeEqual } from "node:crypto";

/** `bytes` of CSPRNG output as base64url (32 bytes → 43 characters). */
export function randomToken(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** Compares two hex digests in constant time. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
