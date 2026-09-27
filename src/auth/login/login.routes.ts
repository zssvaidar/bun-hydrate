import { SessionManager, authSnapshot, type Principal } from "@bun-hydrate/auth";
import { JwtIssuer } from "@bun-hydrate/auth/features";
import { Router, UnauthorizedError, type Context } from "@bun-hydrate/core";
import { Database } from "@bun-hydrate/database";
import type { Container } from "@bun-hydrate/di";
import { peekJson, rateLimit } from "@bun-hydrate/rate-limit";
import { validate } from "@bun-hydrate/validation";
import { AccountRegistered } from "../../events/account-registered.event";
import { AppEvents } from "../../events/bus";
import { AccountRepository, normalizeEmail, type Account } from "../accounts";
import { DEFAULT_ROLE, authConfig } from "../config";
import { Passwords } from "../passwords";
import { Credentials, Registration } from "./login.schema";

/** Brute-force protection: 5 attempts per 15 minutes per client IP and email; refuses if the limiter is down. */
export function loginRateLimit() {
  return rateLimit({
    name: "login",
    limit: 5,
    window: "15m",
    failClosed: true,
    key: async (ctx) => {
      const body = await peekJson<{ email?: unknown }>(ctx);
      return `${ctx.ip}:${normalizeEmail(String(body?.email ?? ""))}`;
    },
  });
}

const toUser = authConfig.user ?? ((principal: Principal) => ({ id: principal.id }));

/** Same answer for an unknown email and a wrong password, so logins cannot probe for accounts. */
const invalidCredentials = () => new UnauthorizedError("Email or password is incorrect", { code: "INVALID_CREDENTIALS" });

/** POST /register, POST /login, POST /logout, GET /me — the routes useAuth() in the browser talks to. */
export function loginRoutes(container: Container): Router {
  const db = container.get(Database);
  const accounts = container.get(AccountRepository);
  const passwords = container.get(Passwords);
  const sessions = container.has(SessionManager) ? container.get(SessionManager) : undefined;
  const tokens = container.has(JwtIssuer) ? container.get(JwtIssuer) : undefined;
  const events = container.has(AppEvents) ? container.get(AppEvents) : undefined;

  /** Starts a session and/or issues a bearer token, whichever the app has installed. */
  async function signIn(ctx: Context<any>, account: Account) {
    const principal: Principal = {
      id: account.id,
      kind: "user",
      roles: [account.role],
      permissions: authConfig.policy.permissionsFor([account.role]),
      via: sessions ? "session" : "jwt",
      claims: { email: account.email },
    };
    if (sessions) await sessions.create(ctx, account.id);
    const token = tokens ? await tokens.issue(principal) : {};
    return { user: toUser(principal), permissions: [...principal.permissions], ...token };
  }

  return new Router()
    .post(
      "/register",
      validate({ body: Registration }, async (ctx, { body }) => {
        const account = await db.transaction(async () => {
          const created = await accounts.create({ email: body.email, role: DEFAULT_ROLE });
          await passwords.set(created.id, body.password);
          // Same transaction: the welcome mail job exists exactly when the account does.
          await events?.emit(AccountRegistered, { accountId: created.id, email: created.email });
          return created;
        });
        ctx.status(201);
        return signIn(ctx, account);
      }),
    )
    .post(
      "/login",
      loginRateLimit(),
      validate({ body: Credentials }, async (ctx, { body }) => {
        const account = await accounts.findByEmail(body.email);
        if (!(await passwords.verify(account, body.password))) throw invalidCredentials();
        return signIn(ctx, account!);
      }),
    )
    .post("/logout", async (ctx) => {
      if (sessions) await sessions.destroy(ctx);
    })
    .get("/me", (ctx) => authSnapshot(ctx, { user: toUser }));
}
