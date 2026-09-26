import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type ConsoleMessage } from "playwright-core";
import type { RunningServer } from "@bun-hydrate/testing";
import { startArtifact } from "./helpers";

// Uses the Chromium that matches playwright-core (see PLAYWRIGHT_BROWSERS_PATH). Install with
// `bunx playwright-core install chromium` to run this suite locally.
const browserInstalled = existsSync(chromium.executablePath());

describe.skipIf(!browserInstalled)("hydration in a real browser", () => {
  let server: RunningServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startArtifact();
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (server?.process.exitCode === null) await server.stop();
  });

  async function openPage(path: string) {
    const page = await browser.newPage();
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
});
