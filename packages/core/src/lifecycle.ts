import type { Logger } from "./logger";

export type LifecycleState = "created" | "initializing" | "ready" | "running" | "stopping" | "stopped";

export type Cleanup = () => void | Promise<void>;
/** Runs before the server binds. May return a cleanup function that runs on stop. */
export type StartHook = () => void | Cleanup | Promise<void | Cleanup>;
export type StopHook = () => void | Promise<void>;

export interface ListenOptions {
  port?: number;
  hostname?: string;
  /** Stop gracefully on SIGTERM/SIGINT. Default: true. */
  handleSignals?: boolean;
}

export interface StopOptions {
  /** How long in-flight requests get to finish before connections are closed. Default: 10s. */
  timeoutMs?: number;
}

export type ReadinessCheck = () => boolean | Promise<boolean>;
export interface ReadinessCheckOptions {
  timeoutMs?: number;
}

/** Tracks the lifecycle state and runs start/stop hooks (spec-3 §7). The App owns the server itself. */
export class Lifecycle {
  state: LifecycleState = "created";
  private readonly startHooks: StartHook[] = [];
  private readonly stopHooks: StopHook[] = [];
  private cleanups: Cleanup[] = [];

  constructor(private readonly logger: Logger) {}

  onStart(hook: StartHook): void {
    this.startHooks.push(hook);
  }

  onStop(hook: StopHook): void {
    this.stopHooks.push(hook);
  }

  /** Runs start hooks in order. If one fails, the hooks that already started are cleaned up. */
  async start(): Promise<void> {
    this.state = "initializing";
    try {
      for (const hook of this.startHooks) {
        const cleanup = await hook();
        if (typeof cleanup === "function") this.cleanups.push(cleanup);
      }
    } catch (error) {
      await this.runAll([...this.cleanups].reverse(), "cleanup");
      this.state = "stopped";
      throw error;
    }
    this.state = "ready";
  }

  /** Cleanups and stop hooks run in reverse order, so resources close opposite to how they opened. */
  async runShutdownHooks(): Promise<void> {
    await this.runAll([...this.cleanups].reverse(), "cleanup");
    await this.runAll([...this.stopHooks].reverse(), "stop hook");
    this.cleanups = [];
  }

  private async runAll(hooks: StopHook[], kind: string): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.error(`A ${kind} failed during shutdown`, { error });
      }
    }
  }
}
