import { join } from "node:path";

/** Records what is installed and which files it owns (spec-5 §9.3). Committed with the app. */
export const MANIFEST_FILE = "hydrate.features.json";

export interface InstalledFeature {
  /** Added to satisfy another feature's requirement. */
  auto?: boolean;
  /** Generated file → content hash at creation, so remove can tell edited files from pristine ones. */
  files: Record<string, string>;
  migrations: string[];
}

export interface Manifest {
  version: 1;
  features: Record<string, InstalledFeature>;
  /** Output key (`path`, or `path#block` for marked blocks) → hash of what was last generated. */
  outputs: Record<string, string>;
  /** Slot contributions from outside features, e.g. `{ "module:orders": { permissions: [...] } }`. */
  extra: Record<string, Record<string, unknown[]>>;
}

export const emptyManifest = (): Manifest => ({ version: 1, features: {}, outputs: {}, extra: {} });

export async function readManifest(cwd: string): Promise<Manifest> {
  const file = Bun.file(join(cwd, MANIFEST_FILE));
  if (!(await file.exists())) return emptyManifest();
  const manifest = (await file.json()) as Manifest;
  if (manifest.version !== 1) throw new Error(`${MANIFEST_FILE} has version ${manifest.version}; this CLI reads version 1`);
  return { ...emptyManifest(), ...manifest };
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function contentHash(text: string): string {
  return `sha256-${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
}
