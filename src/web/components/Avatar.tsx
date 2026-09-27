import { useState, type ChangeEvent } from "react";
import { useAuth } from "../auth";

/**
 * The signed-in user's avatar and a picker to change it. The image URL is signed and expires,
 * so the server renders a fresh one with each page.
 */
export function Avatar({ initialUrl }: { initialUrl?: string }) {
  const { status } = useAuth();
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string>();
  if (status !== "signed-in") return null;

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("avatar", file);
    const res = await fetch("/api/v1/users/me/avatar", { method: "PUT", body: form });
    const body = await res.json();
    if (res.ok) {
      setUrl(body.url);
      setError(undefined);
    } else {
      setError(body.error?.details?.[0]?.message ?? body.error?.message ?? "Upload failed");
    }
  }

  return (
    <section className="avatar">
      {url ? <img src={url} alt="Your avatar" width={64} height={64} /> : <p>No avatar yet.</p>}
      <label>
        {url ? "Change avatar" : "Add an avatar"} (PNG, JPEG or WebP, up to 2 MB){" "}
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void upload(event)} />
      </label>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
