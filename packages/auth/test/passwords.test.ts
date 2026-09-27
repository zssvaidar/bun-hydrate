import { describe, expect, test } from "bun:test";
import { hashPassword, needsRehash, verifyPassword } from "../src/passwords";

describe("passwords", () => {
  test("hashes with argon2id at the current parameters", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toStartWith("$argon2id$v=19$m=65536,t=2,p=1$");
  });

  test("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("s3cret-pass");
    expect(await verifyPassword("s3cret-pass", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("a missing user still costs a full hash, so timing does not reveal which emails exist", async () => {
    const hash = await hashPassword("s3cret-pass");
    const time = async (run: () => Promise<unknown>) => {
      const startedAt = performance.now();
      await run();
      return performance.now() - startedAt;
    };
    await verifyPassword("warm-up", undefined);

    const realUser = await time(() => verifyPassword("wrong", hash));
    const missingUser = await time(() => verifyPassword("wrong", undefined));

    expect(await verifyPassword("anything", undefined)).toBe(false);
    expect(missingUser).toBeGreaterThan(realUser * 0.3);
  });

  test("needsRehash is true for older parameters or algorithms", async () => {
    expect(needsRehash(await hashPassword("x"))).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")).toBe(true);
    expect(needsRehash(await Bun.password.hash("x", { algorithm: "bcrypt", cost: 4 }))).toBe(true);
  });

  test("absurdly long passwords are refused before hashing (DoS guard)", async () => {
    const huge = "x".repeat(10_000);
    await expect(hashPassword(huge)).rejects.toThrow("Password is too long");
    expect(await verifyPassword(huge, await hashPassword("x"))).toBe(false);
  });
});
