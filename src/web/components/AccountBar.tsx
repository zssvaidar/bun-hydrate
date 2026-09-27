import { useAuth } from "../auth";

/** Who is signed in. Rendered on the server from the session, so there is no signed-out flash. */
export function AccountBar() {
  const { status, user, logout } = useAuth();
  if (status !== "signed-in") {
    return (
      <p className="account">
        <a href="/login">Sign in</a>
      </p>
    );
  }
  return (
    <p className="account">
      Signed in as <strong>{user?.email}</strong>{" "}
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </p>
  );
}
