export interface CookieOptions {
  /** Seconds until expiry. */
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "strict" | "lax" | "none";
  partitioned?: boolean;
}

/**
 * Request cookies plus pending changes (spec-5 §1.3). Backed by Bun.CookieMap, parsed on first
 * use. The app appends the changes as Set-Cookie to the final response, whatever produced it.
 */
export class Cookies {
  private jar: Bun.CookieMap | undefined;

  constructor(
    private readonly header: string | null,
    private readonly secureByDefault: boolean,
  ) {}

  get(name: string): string | null {
    return this.map().get(name) ?? null;
  }

  has(name: string): boolean {
    return this.map().has(name);
  }

  /** Defaults: Path=/, HttpOnly, SameSite=Lax, and Secure on HTTPS. Options override them. */
  set(name: string, value: string, options: CookieOptions = {}): void {
    this.map().set(name, value, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: this.secureByDefault,
      ...options,
    });
  }

  delete(name: string, options: Pick<CookieOptions, "path" | "domain"> = {}): void {
    this.map().delete({ name, path: options.path ?? "/", domain: options.domain });
  }

  /** @internal The Set-Cookie headers for everything changed during the request. */
  changes(): string[] {
    return this.jar ? this.jar.toSetCookieHeaders() : [];
  }

  private map(): Bun.CookieMap {
    this.jar ??= new Bun.CookieMap(this.header ?? "");
    return this.jar;
  }
}
