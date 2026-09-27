import { defineConfig, env, type App } from "@bun-hydrate/core";
import { token, type Container } from "@bun-hydrate/di";
import { LocalStorage, storageRoutes, type Storage } from "@bun-hydrate/storage";

/** Where uploaded files live: `container.get(AppStorage).put(key, file)`. */
export const AppStorage = token<Storage>("AppStorage");

/** Development only: production refuses to start without STORAGE_SIGNING_KEY. */
const DEVELOPMENT_SIGNING_KEY = "development-only-storage-signing-key";

/**
 * Files on this server's disk (one instance; use storage:s3 for several). They are private:
 * `storage.signedUrl(key, { expiresIn: "10m" })` gives a /files URL that works until it expires.
 */
export function installStorage(app: App, container: Container): void {
  const signingKey = env.string("STORAGE_SIGNING_KEY");
  const config = defineConfig({
    root: env.string("STORAGE_ROOT").default("data/storage"),
    signingKey: process.env.NODE_ENV === "production" ? signingKey : signingKey.default(DEVELOPMENT_SIGNING_KEY),
  });
  const storage = new LocalStorage({ ...config, baseUrl: "/files" });
  container.value(AppStorage, storage);
  app.route("/files", storageRoutes(storage));
}
