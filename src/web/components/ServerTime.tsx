import { useState } from "react";

export function ServerTime() {
  const [time, setTime] = useState<string>();
  const [error, setError] = useState<string>();

  async function load() {
    try {
      const response = await fetch("/api/v1/time");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setTime(((await response.json()) as { time: string }).time);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <p>
      <button type="button" data-testid="load-time" onClick={load}>
        Load server time
      </button>{" "}
      <output data-testid="server-time">{error ? `Failed: ${error}` : (time ?? "not loaded")}</output>
    </p>
  );
}
