import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createAuth } from "@bun-hydrate/auth";
import { jwtFeature, sessionsFeature } from "@bun-hydrate/auth/features";
import { App, createLogger } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import { Container } from "@bun-hydrate/di";
import { createTestClient } from "@bun-hydrate/testing";
import { createTestDatabase } from "@bun-hydrate/testing/database";
import { authConfig } from "../config";
import { coreFeature } from "../core";
import { auth as app } from "../index";
import { passwordsFeature } from "../passwords";
import { AUTH_BASE_PATH, loginFeature } from "./feature";

const MIGRATIONS = join(import.meta.dir, "../../../migrations");
const ORIGIN = "http://localhost";
const ada = { email: "ada@example.com", password: "correct horse battery" };
const path = (route: string) => `${AUTH_BASE_PATH}${route}`;

let db: Database;
beforeEach(async () => {
  db = await createTestDatabase({ migrations: MIGRATIONS });
});
afterEach(() => db.close());

/** The login feature with sessions or JWT (each tested when the app installs it), and nothing else. */
function clientWith(mode: "sessions" | "jwt") {
  const tokens = mode === "sessions" ? sessionsFeature({ env: {} }) : jwtFeature({ env: { JWT_SECRET: "a-test-secret-of-at-least-32-chars" } });
  const auth = createAuth({ config: authConfig, features: [coreFeature, passwordsFeature, tokens, loginFeature] });
  const app = new App({ logger: createLogger({ level: "silent" }), health: false });
  auth.install(app, new Container().value(Database, db));
  return createTestClient(app, { cookies: true });
}

/** What a failed login tells the caller (the request id differs per request). */
const failure = async (response: Response) => {
  const { error } = await response.json();
  return { status: response.status, code: error.code, message: error.message };
};

describe.if(app.has("auth:sessions"))("login with sessions", () => {
  test("register signs in with a cookie; /me follows it until logout", async () => {
    const client = clientWith("sessions");

    const registered = await client.post(path("/register")).header("origin", ORIGIN).json(ada);
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ user: { email: ada.email } });
    expect(await (await client.get(path("/me"))).json()).toMatchObject({ user: { email: ada.email } });

    expect((await client.post(path("/logout")).header("origin", ORIGIN)).status).toBe(204);
    expect(await (await client.get(path("/me"))).json()).toEqual({ user: null, permissions: [] });
  });

  test("a wrong password and an unknown email get the same 401", async () => {
    const client = clientWith("sessions");
    await client.post(path("/register")).header("origin", ORIGIN).json(ada);
    await client.post(path("/logout")).header("origin", ORIGIN);

    const wrong = await client.post(path("/login")).header("origin", ORIGIN).json({ ...ada, password: "nope" });
    const unknown = await client.post(path("/login")).header("origin", ORIGIN).json({ ...ada, email: "who@example.com" });

    const invalid = { status: 401, code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" };
    expect(await failure(wrong)).toEqual(invalid);
    expect(await failure(unknown)).toEqual(invalid);
    expect((await client.post(path("/login")).header("origin", ORIGIN).json(ada)).status).toBe(200);
  });

  test("repeated failures for one email are rate limited", async () => {
    const client = clientWith("sessions");
    const attempt = () => client.post(path("/login")).header("origin", ORIGIN).json({ ...ada, password: "guess" });

    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  test("input is validated and an email registers only once", async () => {
    const client = clientWith("sessions");

    expect((await client.post(path("/register")).header("origin", ORIGIN).json({ email: "x", password: "short" })).status).toBe(422);
    await client.post(path("/register")).header("origin", ORIGIN).json(ada);
    expect((await client.post(path("/register")).header("origin", ORIGIN).json(ada)).status).toBe(409);
  });

  test("a cross-site form post is refused", async () => {
    const client = clientWith("sessions");
    expect((await client.post(path("/register")).header("origin", "https://evil.example").json(ada)).status).toBe(403);
  });
});

describe.if(app.has("auth:jwt"))("login with JWT", () => {
  test("login returns a bearer token that authenticates later requests", async () => {
    const client = clientWith("jwt");
    await client.post(path("/register")).json(ada);

    const login = await (await client.post(path("/login")).json(ada)).json();
    const token: string = login.token;

    expect(login).toMatchObject({ user: { email: ada.email }, tokenType: "Bearer" });
    expect(token).toBeString();
    expect(await (await client.get(path("/me")).bearer(token)).json()).toMatchObject({ user: { email: ada.email } });
  });
});
