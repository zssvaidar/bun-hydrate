import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { wrapAuth } from "../../auth";
import { Login } from "./Login";

describe("Login page", () => {
  test("shows the form when signed out", () => {
    const html = renderToString(wrapAuth(<Login />, { auth: { user: null, permissions: [] } }));

    expect(html).toContain('name="email"');
    expect(html).toContain('type="password"');
    expect(html).toMatch(/autocomplete="current-password"/i);
  });

  test("says who is signed in, on the first render", () => {
    const auth = { user: { id: "u1", email: "ada@example.com", role: "member" }, permissions: [] };
    expect(renderToString(wrapAuth(<Login />, { auth }))).toContain("<strong>ada@example.com</strong>");
  });
});
