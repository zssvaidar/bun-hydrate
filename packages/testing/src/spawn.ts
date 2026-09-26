import type { Subprocess } from "bun";

export interface SpawnServerOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** How long to wait for the "Server listening" log line. Default: 10s. */
  timeoutMs?: number;
}

export interface RunningServer {
  url: URL;
  process: Subprocess;
  /** Every stdout/stderr line printed so far. */
  output(): string[];
  /** Sends a signal (default SIGTERM) and resolves with the exit code. */
  stop(signal?: NodeJS.Signals): Promise<number>;
}

const LISTENING_MESSAGE = "Server listening";

/**
 * Starts a real server process and resolves once it logs (as JSON) that it is listening.
 * Used by end-to-end tests that need real sockets, signals, or a built artifact.
 */
export function spawnServer(options: SpawnServerOptions): Promise<RunningServer> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const lines: string[] = [];
  const child = Bun.spawn(options.cmd, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const describeFailure = (reason: string) =>
    new Error(`${options.cmd.join(" ")} ${reason}. Output:\n${lines.join("\n")}`);

  return new Promise<RunningServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(describeFailure(`did not start within ${timeoutMs}ms`));
    }, timeoutMs);

    const onLine = (line: string) => {
      lines.push(line);
      const url = listeningUrl(line);
      if (!url) return;
      clearTimeout(timer);
      resolve({
        url,
        process: child,
        output: () => [...lines],
        stop: async (signal = "SIGTERM") => {
          child.kill(signal);
          return child.exited;
        },
      });
    };

    void readLines(child.stdout, onLine);
    void readLines(child.stderr, (line) => lines.push(line));
    void child.exited.then(async (code) => {
      clearTimeout(timer);
      await Bun.sleep(10); // let the readers flush the last lines into the error message
      reject(describeFailure(`exited with code ${code} before listening`));
    });
  });
}

function listeningUrl(line: string): URL | undefined {
  try {
    const record = JSON.parse(line) as { msg?: string; url?: string };
    return record.msg === LISTENING_MESSAGE && record.url ? new URL(record.url) : undefined;
  } catch {
    return undefined;
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffered += decoder.decode(chunk.value, { stream: true });
    const parts = buffered.split("\n");
    buffered = parts.pop()!;
    parts.filter(Boolean).forEach(onLine);
  }
  if (buffered) onLine(buffered);
}
