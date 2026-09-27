import { principal, requireAuth } from "@bun-hydrate/auth";
import { NotFoundError, Router, bodyLimit, type Context } from "@bun-hydrate/core";
import type { Container } from "@bun-hydrate/di";
import type { Storage } from "@bun-hydrate/storage";
import { AppStorage } from "../../platform/storage";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const URL_LIFETIME = "10m";

/** Each account's avatar, stored under avatars/<account id> and only ever served through signed URLs. */
export class Avatars {
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage.scope("avatars");
  }

  async save(accountId: string, image: File): Promise<string> {
    await this.storage.put(accountId, image);
    return this.storage.signedUrl(accountId, { expiresIn: URL_LIFETIME });
  }

  /** A fresh signed URL, or undefined when the account has no avatar. */
  async url(accountId: string): Promise<string | undefined> {
    if (!(await this.storage.exists(accountId))) return undefined;
    return this.storage.signedUrl(accountId, { expiresIn: URL_LIFETIME });
  }
}

/** For pages: the signed-in user's avatar URL, if any. */
export function avatarUrlFor(container: Container) {
  const avatars = new Avatars(container.get(AppStorage));
  return async (ctx: Context<any>) => {
    const id = principal(ctx)?.id;
    return id ? avatars.url(id) : undefined;
  };
}

/** PUT sets the avatar (PNG, JPEG or WebP up to 2 MB, checked by its bytes); GET returns a signed URL. */
export function avatarRoutes(container: Container): Router {
  const avatars = new Avatars(container.get(AppStorage));

  return new Router()
    .put("/", requireAuth(), bodyLimit("3mb"), async (ctx) => {
      const image = await ctx.upload("avatar", { types: IMAGE_TYPES, maxSize: "2mb" });
      return { url: await avatars.save(principal(ctx)!.id, image) };
    })
    .get("/", requireAuth(), async (ctx) => {
      const url = await avatars.url(principal(ctx)!.id);
      if (!url) throw new NotFoundError("No avatar yet");
      return { url };
    });
}
