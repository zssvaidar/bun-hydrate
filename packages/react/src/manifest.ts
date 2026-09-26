/** Written by `hydrate build` to dist/manifest.json; read at runtime to find the hashed client bundle. */
export interface BuildManifest {
  client: { entry: string };
  builtAt: string;
}

export async function readManifest(path: string): Promise<BuildManifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Build manifest not found at ${path}. Run \`hydrate build\` before starting in production mode.`);
  }
  return (await file.json()) as BuildManifest;
}

export async function writeManifest(path: string, manifest: BuildManifest): Promise<void> {
  await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
}
