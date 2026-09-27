import { afterEach, describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createAuthClient, createAuthStore, type AuthSnapshot } from "../src/auth";

type Permission = "users.read" | "users.delete" | "profile.read";

const signedIn: AuthSnapshot = { user: { id: "u1", name: "Ada" }, permissions: ["users.read", "profile.*"] };
const signedOut: AuthSnapshot = { user: null, permissions: [] };

/** A fetch stand-in that records calls and answers from a route table. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; method: string; body?: unknown; credentials?: string; authorization?: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init?.credentials,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const handler = routes[`${method} ${url}`];
    return handler ? handler(init) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const stores: ReturnType<typeof createAuthStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function store(initial: AuthSnapshot, routes: Record<string, (init?: RequestInit) => Response> = {}, extra = {}) {
  const { fetchImpl, calls } = fakeFetch(routes);
  const navigations: string[] = [];
  const instance = createAuthStore(initial, {
    basePath: "/api/v1/auth",
    fetch: fetchImpl,
    navigate: (url) => void navigations.push(url),
    ...extra,
  });
  stores.push(instance);
  return { instance, calls, navigations };
}

describe("auth store", () => {
  test("starts from the server snapshot", () => {
    const { instance } = store(signedIn);
    expect(instance.getSnapshot()).toMatchObject({ status: "signed-in", user: { id: "u1" } });
    expect(store(signedOut).instance.getSnapshot().status).toBe("signed-out");
  });

  test("login posts credentials and applies the snapshot the server returns", async () => {
    const { instance, calls } = store(signedOut, { "POST /api/v1/auth/login": () => Response.json(signedIn) });
    const changes: string[] = [];
    instance.subscribe(() => void changes.push(instance.getSnapshot().status));

    expect(await instance.login({ email: "ada@example.com", password: "pw" })).toEqual({ ok: true });
    expect(instance.getSnapshot().user).toEqual({ id: "u1", name: "Ada" });
    expect(changes).toEqual(["signed-in"]);
    expect(calls[0]).toMatchObject({ method: "POST", body: { email: "ada@example.com", password: "pw" }, credentials: "same-origin" });
  });

  test("login turns 422 details into per-field errors and 401 into a message", async () => {
    const validation = Response.json(
      { error: { code: "VALIDATION_FAILED", message: "Invalid request", details: [{ location: "body", path: "email", message: "Must be a valid email address" }] } },
      { status: 422 },
    );
    const { instance } = store(signedOut, { "POST /api/v1/auth/login": () => validation });
    expect(await instance.login({ email: "x", password: "" })).toEqual({
      ok: false,
      message: "Invalid request",
      fieldErrors: { email: "Must be a valid email address" },
    });

    const wrong = store(signedOut, {
      "POST /api/v1/auth/login": () => Response.json({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } }, { status: 401 }),
    });
    expect(await wrong.instance.login({ email: "a@b.c", password: "no" })).toEqual({
      ok: false,
      message: "Email or password is incorrect",
      fieldErrors: {},
    });
    expect(wrong.instance.getSnapshot().status).toBe("signed-out");
  });

  test("logout clears the state and navigates away, so no private page stays in memory", async () => {
    const { instance, navigations } = store(signedIn, { "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }) });

    await instance.logout();

    expect(instance.getSnapshot().status).toBe("signed-out");
    expect(navigations).toEqual(["/"]);
  });

  test("authFetch flips to signed-out on 401 and reports the expired session", async () => {
    const expired: string[] = [];
    const { instance } = store(
      signedIn,
      { "GET /api/v1/users": () => new Response(null, { status: 401 }) },
      { onSessionExpired: () => void expired.push("expired") },
    );

    const res = await instance.authFetch("/api/v1/users");

    expect(res.status).toBe(401);
    expect(instance.getSnapshot().status).toBe("signed-out");
    expect(expired).toEqual(["expired"]);
  });

  test("authFetch attaches a bearer token when an identity-provider SDK supplies one", async () => {
    const { instance, calls } = store(
      signedIn,
      { "GET /api/v1/users": () => Response.json([]) },
      { getAccessToken: async () => "idp-token" },
    );
    await instance.authFetch("/api/v1/users");
    expect(calls[0]!.authorization).toBe("Bearer idp-token");
  });

  test("can() uses the same wildcard rules as the server", () => {
    const { instance } = store(signedIn);
    expect(instance.can("users.read")).toBe(true);
    expect(instance.can("profile.read")).toBe(true);
    expect(instance.can("users.delete")).toBe(false);
  });

  test("login and logout are broadcast to other tabs", async () => {
    const first = store(signedIn, { "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }) }, { broadcast: true });
    const second = store(signedIn, {}, { broadcast: true });

    await first.instance.logout();
    await Bun.sleep(20);

    expect(second.instance.getSnapshot().status).toBe("signed-out");
  });
});

describe("React bindings (server-rendered, no DOM needed)", () => {
  const { AuthProvider, useAuth, useCan, Can, wrapAuth } = createAuthClient<Permission>({ basePath: "/api/v1/auth" });

  function Profile() {
    const { user, status } = useAuth();
    const canDelete = useCan("users.delete");
    return (
      <p>
        {status}:{String(user?.name ?? "nobody")}:{String(canDelete)}
      </p>
    );
  }

  test("the provider seeds hooks from the snapshot on the first render", () => {
    expect(renderToString(<AuthProvider initial={signedIn}><Profile /></AuthProvider>)).toBe("<p>signed-in<!-- -->:<!-- -->Ada<!-- -->:<!-- -->false</p>");
  });

  test("<Can> renders children or the fallback", () => {
    const html = renderToString(
      <AuthProvider initial={signedIn}>
        <Can permission="users.read">read</Can>
        <Can permission="users.delete" fallback={<i>no</i>}>delete</Can>
      </AuthProvider>,
    );
    expect(html).toBe("read<i>no</i>");
  });

  test("wrapAuth(page, shared) is what hydratePage and the renderer use", () => {
    expect(renderToString(wrapAuth(<Profile />, { auth: signedOut }))).toContain("signed-out");
  });

  test("hooks outside a provider fail with a clear message", () => {
    expect(() => renderToString(<Profile />)).toThrow("useAuth() needs an <AuthProvider>");
  });

  test("permission names are type-checked (checked by tsc)", () => {
    function Typo() {
      // @ts-expect-error — not a known permission
      useCan("users.dlete");
      return null;
    }
    void Typo;
  });
});
