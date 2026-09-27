import { describe, expect, test } from "bun:test";
import { ConfigError, defineConfig, env } from "../src/config";

describe("defineConfig", () => {
  test("parses typed values from the source", () => {
    const config = defineConfig(
      {
        port: env.port("PORT"),
        name: env.string("APP_NAME"),
        debug: env.boolean("DEBUG"),
        ratio: env.number("RATIO"),
        workers: env.integer("WORKERS"),
        mode: env.enum("APP_ENV", ["development", "production"]),
        dbUrl: env.url("DATABASE_URL"),
      },
      {
        PORT: "8080",
        APP_NAME: "shop",
        DEBUG: "yes",
        RATIO: "0.5",
        WORKERS: "4",
        APP_ENV: "production",
        DATABASE_URL: "postgres://localhost:5432/shop",
      },
    );

    expect(config).toEqual({
      port: 8080,
      name: "shop",
      debug: true,
      ratio: 0.5,
      workers: 4,
      mode: "production",
      dbUrl: "postgres://localhost:5432/shop",
    });
  });

  test("applies defaults and optional values when unset or empty", () => {
    const config = defineConfig(
      {
        port: env.port("PORT").default(3000),
        host: env.string("HOST").default("0.0.0.0"),
        redisUrl: env.url("REDIS_URL").optional(),
      },
      { HOST: "" },
    );

    expect(config).toEqual({ port: 3000, host: "0.0.0.0", redisUrl: undefined });
  });

  test("returns a frozen object", () => {
    const config = defineConfig({ port: env.port("PORT").default(1) }, {});
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("reports every problem at once", () => {
    const load = () =>
      defineConfig(
        {
          port: env.port("PORT"),
          dbUrl: env.url("DATABASE_URL"),
          debug: env.boolean("DEBUG"),
          mode: env.enum("APP_ENV", ["development", "production"]),
        },
        { PORT: "http", DEBUG: "maybe", APP_ENV: "staging" },
      );

    expect(load).toThrow(ConfigError);
    try {
      load();
    } catch (error) {
      const issues = (error as ConfigError).issues.map((i) => i.key);
      expect(issues).toEqual(["PORT", "DATABASE_URL", "DEBUG", "APP_ENV"]);
      const message = (error as ConfigError).message;
      expect(message).toContain("DATABASE_URL: required but not set");
      expect(message).toContain('PORT: expected a port number (0-65535), received "http"');
      expect(message).toContain('APP_ENV: expected one of development, production, received "staging"');
      expect(message).toContain("Set these in .env or the process environment.");
    }
  });

  test("hints at case mismatches, since env names are case-sensitive", () => {
    try {
      defineConfig({ host: env.string("HOST") }, { host: "localhost" });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect((error as Error).message).toContain(
        'HOST: required but not set (found "host" — environment variable names are case-sensitive)',
      );
    }
  });

  test("rejects non-integers for integer and out-of-range ports", () => {
    expect(() => defineConfig({ n: env.integer("N") }, { N: "1.5" })).toThrow("expected an integer");
    expect(() => defineConfig({ p: env.port("P") }, { P: "70000" })).toThrow("expected a port number");
  });

  test("reads <NAME>_FILE, as mounted by Docker and Kubernetes secrets", async () => {
    const path = `${import.meta.dir}/fixtures/.secret-db-url`;
    await Bun.write(path, "postgres://user:pw@db:5432/app\n");
    try {
      expect(defineConfig({ dbUrl: env.url("DATABASE_URL") }, { DATABASE_URL_FILE: path })).toEqual({
        dbUrl: "postgres://user:pw@db:5432/app",
      });
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("setting both NAME and NAME_FILE is an error", () => {
    expect(() => defineConfig({ port: env.port("PORT") }, { PORT: "1", PORT_FILE: "/run/secrets/port" })).toThrow(
      "PORT: set either PORT or PORT_FILE, not both",
    );
  });

  test("an unreadable _FILE is reported without leaking contents", () => {
    expect(() => defineConfig({ token: env.string("TOKEN") }, { TOKEN_FILE: "/definitely/missing" })).toThrow(
      'TOKEN: cannot read TOKEN_FILE "/definitely/missing"',
    );
  });

  test("a value read from a file is validated like any other, without echoing it", () => {
    const path = `${import.meta.dir}/fixtures/.secret-port`;
    require("node:fs").writeFileSync(path, "not-a-port");
    try {
      expect(() => defineConfig({ port: env.port("PORT") }, { PORT_FILE: path })).toThrow(
        "PORT: expected a port number (0-65535), read from PORT_FILE",
      );
    } finally {
      require("node:fs").rmSync(path);
    }
  });

  test("defaults to process.env when no source is given", () => {
    process.env.BUN_HYDRATE_TEST_VALUE = "from-process";
    try {
      expect(defineConfig({ v: env.string("BUN_HYDRATE_TEST_VALUE") }).v).toBe("from-process");
    } finally {
      delete process.env.BUN_HYDRATE_TEST_VALUE;
    }
  });
});
