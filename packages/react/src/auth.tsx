import { createContext, useContext, useState, useEffect, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { can } from "@bun-hydrate/auth/permissions";
import type { SharedData } from "./pages";

/** What the server embeds for the browser (see authSnapshot() in @bun-hydrate/auth). */
export interface AuthSnapshot<User = Record<string, unknown>> {
  user: User | null;
  permissions: readonly string[];
}

export interface AuthState<User = Record<string, unknown>> extends AuthSnapshot<User> {
  status: "signed-in" | "signed-out";
}

export type AuthResult = { ok: true } | { ok: false; message: string; fieldErrors: Record<string, string> };

export interface AuthClientOptions {
  /** Where the auth routes live, e.g. "/api/v1/auth" (login, register, logout, me). */
  basePath: string;
  fetch?: typeof fetch;
  /** Full navigation after logout. Default: window.location.assign. */
  navigate?: (url: string) => void;
  /** Where logout goes. Default: "/". */
  afterLogout?: string;
  /** Called when an authFetch() gets a 401 while signed in. */
  onSessionExpired?: () => void;
  /** For identity-provider SDKs: a bearer token attached by authFetch(). */
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  /** Sync login/logout across tabs. Default: on in browsers. */
  broadcast?: boolean;
}

const CHANNEL = "bun-hydrate-auth";
const SIGNED_OUT: AuthSnapshot<never> = { user: null, permissions: [] };

function toState<User>(snapshot: AuthSnapshot<User>): AuthState<User> {
  return { ...snapshot, status: snapshot.user ? "signed-in" : "signed-out" };
}

async function toFailure(response: Response): Promise<AuthResult> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; details?: { path?: string; message?: string }[] };
  };
  const fieldErrors: Record<string, string> = {};
  for (const detail of body.error?.details ?? []) {
    if (detail.path && detail.message && !(detail.path in fieldErrors)) fieldErrors[detail.path] = detail.message;
  }
  return { ok: false, message: body.error?.message ?? `Request failed (${response.status})`, fieldErrors };
}

/**
 * The auth state and actions, independent of React and the DOM (spec-5 §8.2). One store per
 * provider instance: a module-level store would leak one user's state into another user's
 * server render.
 */
export function createAuthStore<User = Record<string, unknown>>(initial: AuthSnapshot<User>, options: AuthClientOptions) {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const navigate = options.navigate ?? ((url: string) => globalThis.location?.assign(url));
  const listeners = new Set<() => void>();
  const useBroadcast = options.broadcast ?? (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined");
  const channel = useBroadcast ? new BroadcastChannel(CHANNEL) : undefined;
  let state = toState(initial);

  const set = (snapshot: AuthSnapshot<User>) => {
    state = toState(snapshot);
    for (const listener of listeners) listener();
  };
  const url = (path: string) => `${options.basePath}${path}`;
  const post = (path: string, body?: unknown) =>
    doFetch(url(path), {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const signIn = async (path: string, body: unknown): Promise<AuthResult> => {
    const response = await post(path, body);
    if (!response.ok) return toFailure(response);
    set((await response.json()) as AuthSnapshot<User>);
    channel?.postMessage("signed-in");
    return { ok: true };
  };

  const store = {
    getSnapshot: (): AuthState<User> => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    login: (credentials: Record<string, unknown>) => signIn("/login", credentials),
    register: (input: Record<string, unknown>) => signIn("/register", input),
    async logout(): Promise<void> {
      await post("/logout").catch(() => undefined);
      set(SIGNED_OUT);
      channel?.postMessage("signed-out");
      // A full navigation drops any private server-rendered data still in memory.
      navigate(options.afterLogout ?? "/");
    },
    async refresh(): Promise<void> {
      const response = await doFetch(url("/me"), { credentials: "same-origin" });
      set(response.ok ? ((await response.json()) as AuthSnapshot<User>) : SIGNED_OUT);
    },
    async authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      const token = await options.getAccessToken?.();
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await doFetch(input, { credentials: "same-origin", ...init, headers });
      if (response.status === 401 && state.status === "signed-in") {
        set(SIGNED_OUT);
        options.onSessionExpired?.();
      }
      return response;
    },
    can: (...required: string[]) => can(state.permissions, ...required),
    dispose() {
      channel?.close();
      listeners.clear();
    },
  };

  channel?.addEventListener("message", (event) => {
    if (event.data === "signed-out") {
      set(SIGNED_OUT);
      navigate(options.afterLogout ?? "/");
    } else if (event.data === "signed-in") {
      void store.refresh();
    }
  });

  return store;
}

export type AuthStore<User = Record<string, unknown>> = ReturnType<typeof createAuthStore<User>>;

/**
 * Typed React bindings: `createAuthClient<Permission>({ basePath })`. Permission names passed to
 * useCan/<Can> are checked by tsc against the app's permission list (spec-5 §8.3).
 */
export function createAuthClient<P extends string, User = Record<string, unknown>>(options: AuthClientOptions) {
  const StoreContext = createContext<AuthStore<User> | null>(null);

  function useStore(hook: string): AuthStore<User> {
    const store = useContext(StoreContext);
    if (!store) throw new Error(`${hook} needs an <AuthProvider>`);
    return store;
  }

  function AuthProvider({ initial, children }: { initial?: AuthSnapshot<User>; children?: ReactNode }) {
    const [store] = useState(() => createAuthStore<User>(initial ?? SIGNED_OUT, options));
    useEffect(() => () => store.dispose(), [store]);
    return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
  }

  function useAuth() {
    const store = useStore("useAuth()");
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return {
      ...state,
      login: store.login,
      register: store.register,
      logout: store.logout,
      refresh: store.refresh,
      authFetch: store.authFetch,
    };
  }

  function useCan(...required: P[]): boolean {
    const store = useStore("useCan()");
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return can(state.permissions, ...required);
  }

  function Can({ permission, fallback = null, children }: { permission: P | P[]; fallback?: ReactNode; children?: ReactNode }) {
    const allowed = useCan(...(Array.isArray(permission) ? permission : [permission]));
    return <>{allowed ? children : fallback}</>;
  }

  /** Pass as `wrap` to createReactRenderer and hydratePage. */
  function wrapAuth(page: ReactElement, shared: SharedData): ReactElement {
    return <AuthProvider initial={(shared.auth as AuthSnapshot<User> | undefined) ?? SIGNED_OUT}>{page}</AuthProvider>;
  }

  return { AuthProvider, useAuth, useCan, Can, wrapAuth };
}
