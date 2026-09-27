import { useState, type FormEvent } from "react";
import { useAuth } from "../../auth";

/** Only same-site paths, so `?next=` cannot send people to another site after they sign in. */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function Login() {
  const { status, user, login } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const result = await login({ email: form.get("email"), password: form.get("password") });
    setPending(false);
    if (result.ok) return window.location.assign(nextPath());
    setError(result.message);
    setFieldErrors(result.fieldErrors);
  }

  if (status === "signed-in") {
    return (
      <main>
        <p>
          Signed in as <strong>{user?.email}</strong>. <a href="/">Continue</a>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form method="post" onSubmit={onSubmit} noValidate>
        {error && <p role="alert">{error}</p>}
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required aria-invalid={Boolean(fieldErrors.email)} />
        </label>
        {fieldErrors.email && <small>{fieldErrors.email}</small>}
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required aria-invalid={Boolean(fieldErrors.password)} />
        </label>
        {fieldErrors.password && <small>{fieldErrors.password}</small>}
        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
