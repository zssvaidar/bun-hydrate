import { describe, expect, test } from "bun:test";
import { spawnServer } from "../src/index";

const fixture = `${import.meta.dir}/fixtures/json-server.ts`;

describe("spawnServer", () => {
  test("resolves once the process logs that it is listening, and stops it gracefully", async () => {
    const server = await spawnServer({ cmd: ["bun", fixture] });

    expect(await (await fetch(server.url)).text()).toBe("spawned");

    const exitCode = await server.stop();
    expect(exitCode).toBe(0);
    expect(server.output().some((line) => line.includes('"msg":"Stopped"'))).toBe(true);
  });

  test("rejects with the process output when it exits before listening", async () => {
    await expect(spawnServer({ cmd: ["bun", fixture], env: { FAIL_ON_START: "1" } })).rejects.toThrow(
      /exited with code 3[\s\S]*refusing to start/,
    );
  });

  test("rejects when the server does not start in time", async () => {
    await expect(spawnServer({ cmd: ["bun", "-e", "setInterval(() => {}, 1000)"], timeoutMs: 300 })).rejects.toThrow(
      /did not start within 300ms/,
    );
  });
});
