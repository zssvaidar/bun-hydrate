import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from "playwright-core";
import type { RunningServer } from "@bun-hydrate/testing";
import { prepareDatabase, startArtifact } from "./helpers";

const ADMIN = { email: "root@example.com", password: "admin password 123", role: "admin" };

// Uses the Chromium that matches playwright-core (see PLAYWRIGHT_BROWSERS_PATH). Install with
// `bunx playwright-core install chromium` to run this suite locally.
const browserInstalled = existsSync(chromium.executablePath());

describe.skipIf(!browserInstalled)("hydration in a real browser", () => {
  let server: RunningServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startArtifact({ DATABASE_URL: await prepareDatabase([ADMIN]) });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (server?.process.exitCode === null) await server.stop();
  });

  async function openPage(path: string, context?: BrowserContext) {
    const page = await (context ?? browser).newPage();
    const problems: string[] = [];
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    await page.goto(new URL(path, server.url).href);
    return { page, problems };
  }

  test("server HTML becomes interactive after hydration", async () => {
    const { page, problems } = await openPage("/");
    const counter = page.getByTestId("counter");

    expect(await counter.textContent()).toBe("Clicked 0 times");
    await page.waitForFunction(() => {
      const root = document.getElementById("app") as HTMLElement & Record<string, unknown>;
      return Object.keys(root).some((key) => key.startsWith("__reactContainer"));
    });

    await counter.click();
    await counter.click();

    expect(await counter.textContent()).toBe("Clicked 2 times");
    expect(problems).toEqual([]);
    await page.close();
  });

  test("hydrated components can call the API", async () => {
    const { page, problems } = await openPage("/");

    await page.getByTestId("load-time").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="server-time"]')?.textContent !== "not loaded");

    const text = await page.getByTestId("server-time").textContent();
    expect(Number.isNaN(Date.parse(text ?? ""))).toBe(false);
    expect(problems).toEqual([]);
    await page.close();
  });

  test("links navigate to other server-rendered pages", async () => {
    const { page, problems } = await openPage("/");

    await page.getByRole("link", { name: "Page 1" }).click();
    await page.waitForURL("**/page/1");

    expect(await page.locator("h1").textContent()).toBe("Page 1");
    expect(await page.title()).toBe("Page 1");
    expect(problems).toEqual([]);
    await page.close();
  });

  /** A browser profile that signed in with a same-origin fetch, as the app's own JavaScript would. */
  async function signedInContext(account: { email: string; password: string }, path: "login" | "register") {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(new URL("/login", server.url).href);
    expect(await status(page, "POST", `/api/v1/auth/${path}`, account)).toBeLessThan(300);
    await page.close();
    return context;
  }

  /** The status of a same-origin request made by the page (with its cookies). */
  function status(page: Page, method: string, path: string, body?: unknown): Promise<number> {
    return page.evaluate(
      async ({ method, path, body }) => {
        const init: RequestInit = { method, headers: { "content-type": "application/json" } };
        if (body !== undefined) init.body = JSON.stringify(body);
        return (await fetch(path, init)).status;
      },
      { method, path, body },
    );
  }

  test("the first HTML is already signed in (no signed-out flash), and hydration agrees", async () => {
    const context = await signedInContext({ email: "member@example.com", password: "member password 1" }, "register");
    const { page, problems } = await openPage("about:blank", context);

    const response = await page.goto(new URL("/", server.url).href);
    expect(await response!.text()).toContain("Signed in as <strong>member@example.com</strong>");
    await page.getByTestId("counter").click(); // hydrated and interactive
    expect(await page.locator(".account").textContent()).toContain("member@example.com");
    expect(problems).toEqual([]); // a hydration mismatch would be reported here
    await context.close();
  });

  test("admin-only controls are hidden from members and shown to admins, like the API decides", async () => {
    const member = await signedInContext({ email: "member2@example.com", password: "member password 2" }, "register");
    const admin = await signedInContext(ADMIN, "login");

    const memberPage = (await openPage("/", member)).page;
    const adminPage = (await openPage("/", admin)).page;

    expect(await memberPage.getByText("Admin tools").count()).toBe(0);
    expect(await status(memberPage, "GET", "/api/v1/users")).toBe(403);
    expect(await adminPage.getByText("Admin tools").count()).toBe(1);
    expect(await status(adminPage, "GET", "/api/v1/users")).toBe(200);
    await Promise.all([member.close(), admin.close()]);
  });

  test("signing in through the login page works under the default CSP", async () => {
    const context = await browser.newContext();
    const { page, problems } = await openPage("/login", context);

    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(new URL("/", server.url).href);

    expect(await page.locator(".account").textContent()).toContain(ADMIN.email);
    expect(await page.getByText("Admin tools").count()).toBe(1);
    expect(problems).toEqual([]);
    await context.close();
  });

  test("signing out in one tab signs out the others", async () => {
    const context = await signedInContext({ email: "tabs@example.com", password: "tabs password 12" }, "register");
    const first = (await openPage("/", context)).page;
    const second = (await openPage("/", context)).page;
    for (const page of [first, second]) {
      await page.waitForFunction(() => Object.keys(document.getElementById("app")!).some((key) => key.startsWith("__reactContainer")));
    }

    await first.getByRole("button", { name: "Sign out" }).click();

    await second.getByRole("link", { name: "Sign in" }).waitFor({ timeout: 5_000 });
    expect(await second.locator(".account").textContent()).toBe("Sign in");
    await context.close();
  });
});
