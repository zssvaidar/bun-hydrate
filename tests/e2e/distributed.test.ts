import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connectWebSocket, spawnServer, type RunningServer } from "@bun-hydrate/testing";
import { E2E_ENV, E2E_SIGNING_KEY, buildArtifact, prepareDatabase, startArtifact } from "./helpers";

/**
 * v0.4 on the built artifact (spec-6 §15): the web process and a separate worker process share
 * the database queue; files are served through signed URLs; chat crosses instances via Redis.
 */
const REDIS_URL = process.env.TEST_REDIS_URL;

interface Mail {
  to: string;
  subject: string;
}

/** A cookie-keeping client on the app's own origin. */
function session(server: RunningServer) {
  let cookie = "";
  const origin = new URL(server.url).origin;
  const request = async (method: string, path: string, body?: unknown) => {
    const json = body !== undefined && !(body instanceof FormData);
    const res = await fetch(new URL(path, server.url), {
      method,
      headers: { origin, ...(cookie ? { cookie } : {}), ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(body) : (body as FormData | undefined),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    return res;
  };
  return { request, cookie: () => cookie };
}

describe("web and worker processes from dist/", () => {
  let databaseUrl: string;
  let dataDir: string;
  let env: Record<string, string>;
  let web: RunningServer;

  const outbox = async (): Promise<Mail[]> => {
    const file = Bun.file(env.OUTBOX_PATH!);
    if (!(await file.exists())) return [];
    return (await file.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Mail);
  };

  async function waitForMail(to: string): Promise<Mail | undefined> {
    for (let i = 0; i < 150; i++) {
      const mail = (await outbox()).find((candidate) => candidate.to === to);
      if (mail) return mail;
      await Bun.sleep(100);
    }
    return undefined;
  }

  const startWorker = async () =>
    spawnServer({ cmd: ["bun", "dist/worker.js"], cwd: await buildArtifact(), env: { ...E2E_ENV, ...env, WORKER_PORT: "0" } });

  beforeAll(async () => {
    databaseUrl = await prepareDatabase([]);
    dataDir = await mkdtemp(join(tmpdir(), "hydrate-v04-"));
    env = {
      DATABASE_URL: databaseUrl,
      OUTBOX_PATH: join(dataDir, "outbox.jsonl"),
      STORAGE_ROOT: join(dataDir, "storage"),
      STORAGE_SIGNING_KEY: E2E_SIGNING_KEY,
    };
    web = await startArtifact(env);
  }, 120_000);

  afterAll(async () => {
    if (web?.process.exitCode === null) await web.stop();
    await rm(dataDir, { recursive: true, force: true });
    await rm(dirname(databaseUrl.slice("sqlite://".length)), { recursive: true, force: true });
  });

  test("the built worker refuses to start without the production signing key", async () => {
    const { STORAGE_SIGNING_KEY: _, ...withoutKey } = env;
    const run = Bun.spawnSync(["bun", "dist/worker.js"], {
      cwd: await buildArtifact(),
      env: { ...process.env, ...E2E_ENV, ...withoutKey },
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("STORAGE_SIGNING_KEY");
  });

  test(
    "registering sends the welcome mail from the separate worker process; SIGTERM stops it cleanly",
    async () => {
      const worker = await startWorker();
      expect((await (await fetch(new URL("/ready", worker.url))).json()).checks).toEqual({ database: "ok" });

      const ada = session(web);
      expect((await ada.request("POST", "/api/v1/auth/register", { email: "ada@example.com", password: "correct horse battery" })).status).toBe(201);
      expect(await waitForMail("ada@example.com")).toMatchObject({ subject: "Welcome to bun-hydrate" });

      expect(await worker.stop("SIGTERM")).toBe(0);
      expect(worker.output().some((line) => line.includes("Worker stopped"))).toBe(true);
    },
    60_000,
  );

  test(
    "registrations made while no worker runs are mailed once one starts again",
    async () => {
      const bob = session(web);
      expect((await bob.request("POST", "/api/v1/auth/register", { email: "bob@example.com", password: "bob password 123" })).status).toBe(201);
      await Bun.sleep(300);
      expect((await outbox()).some((mail) => mail.to === "bob@example.com")).toBe(false);

      const worker = await startWorker();
      expect(await waitForMail("bob@example.com")).toMatchObject({ subject: "Welcome to bun-hydrate" });
      expect(await worker.stop("SIGTERM")).toBe(0);
      expect((await outbox()).filter((mail) => mail.to === "bob@example.com")).toHaveLength(1);
    },
    60_000,
  );

  test("an uploaded avatar is served through its signed URL with safe headers", async () => {
    const ada = session(web);
    await ada.request("POST", "/api/v1/auth/login", { email: "ada@example.com", password: "correct horse battery" });
    const form = new FormData();
    const png = new Uint8Array(128).map((_, i) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? 7);
    form.append("avatar", new File([png], "me.png", { type: "image/png" }));

    const uploaded = await ada.request("PUT", "/api/v1/users/me/avatar", form);
    expect(uploaded.status).toBe(200);
    const image = await fetch(new URL((await uploaded.json()).url, web.url));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  });
});

describe.if(Boolean(REDIS_URL))("two web instances with Redis (TEST_REDIS_URL)", () => {
  let databaseUrl: string;
  let instances: RunningServer[];

  beforeAll(async () => {
    databaseUrl = await prepareDatabase([]);
    const env = {
      DATABASE_URL: databaseUrl,
      REDIS_URL: REDIS_URL!,
      REDIS_PREFIX: `e2e-${process.pid}:`,
      STORAGE_SIGNING_KEY: E2E_SIGNING_KEY,
    };
    instances = await Promise.all([startArtifact(env), startArtifact(env)]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(instances.filter((server) => server.process.exitCode === null).map((server) => server.stop()));
    await rm(dirname(databaseUrl.slice("sqlite://".length)), { recursive: true, force: true });
  });

  test("a chat message sent on one instance reaches members connected to the other", async () => {
    const [a, b] = instances as [RunningServer, RunningServer];
    const one = session(a);
    const two = session(b);
    await one.request("POST", "/api/v1/auth/register", { email: "one@example.com", password: "password one 123" });
    await two.request("POST", "/api/v1/auth/register", { email: "two@example.com", password: "password two 123" });
    expect((await (await fetch(new URL("/ready", a.url))).json()).checks).toMatchObject({ redis: "ok" });

    const onA = await connectWebSocket(`ws://${new URL(a.url).host}/ws/rooms/lobby`, { headers: { cookie: one.cookie(), origin: new URL(a.url).origin } });
    const onB = await connectWebSocket(`ws://${new URL(b.url).host}/ws/rooms/lobby`, { headers: { cookie: two.cookie(), origin: new URL(b.url).origin } });
    await Bun.sleep(100); // both sockets subscribe in open()

    onB.send("hello across instances");
    const expected = { from: "two@example.com", text: "hello across instances" };
    expect(JSON.parse(String(await onA.next()))).toEqual(expected);
    expect(JSON.parse(String(await onB.next()))).toEqual(expected);
    await Promise.all([onA.close(), onB.close()]);
  });
});
