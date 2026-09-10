export const ROOT = `${import.meta.dir}/..`;

export const PACKAGES = [
  { dir: 'packages/google-oauth', name: '@cyftec/google-oauth' },
  { dir: 'packages/google-drive-folder', name: '@cyftec/google-drive-folder' },
  { dir: 'packages/google-drive-as-socket', name: '@cyftec/google-drive-as-socket' },
] as const;

export const PACKAGE_DIRS = PACKAGES.map((pkg) => pkg.dir);

export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/;

export type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export function packageJsonPath(relativeDir: string): string {
  return `${ROOT}/${relativeDir}/package.json`;
}

export async function readTextFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

export async function deleteFile(path: string): Promise<void> {
  await Bun.file(path).delete();
}

export async function readPackageJson(relativeDir: string): Promise<PackageJson> {
  return JSON.parse(await readTextFile(packageJsonPath(relativeDir))) as PackageJson;
}

export async function writePackageJson(relativeDir: string, manifest: PackageJson): Promise<void> {
  await writeTextFile(packageJsonPath(relativeDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

function tarHeaderField(header: Uint8Array, start: number, length: number): string {
  return new TextDecoder()
    .decode(header.subarray(start, start + length))
    .replace(/\0.*/g, '')
    .trim();
}

export function readTarEntry(archive: Uint8Array, entryName: string): string | undefined {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const rawName = tarHeaderField(header, 0, 100);
    const prefix = tarHeaderField(header, 345, 155);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = Number.parseInt(tarHeaderField(header, 124, 12), 8);

    offset += 512;
    const content = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (name === entryName) {
      return new TextDecoder().decode(content);
    }
  }
  return undefined;
}

export async function readTarGzEntry(tarGzPath: string, entryName: string): Promise<string | undefined> {
  const compressed = await Bun.file(tarGzPath).bytes();
  const archive = Bun.gunzipSync(compressed);
  return readTarEntry(archive, entryName);
}

export function workspaceDeps(pkg: PackageJson): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const section of [pkg.dependencies, pkg.peerDependencies]) {
    if (!section) continue;
    for (const [name, spec] of Object.entries(section)) {
      if (spec.startsWith('workspace:')) {
        entries.push([name, spec]);
      }
    }
  }
  return entries;
}

export async function snapshotPackageJsonFiles(): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const dir of PACKAGE_DIRS) {
    snapshot.set(dir, await readTextFile(packageJsonPath(dir)));
  }
  return snapshot;
}

export async function restoreAllPackageJsonFiles(snapshot: Map<string, string>): Promise<void> {
  for (const [dir, content] of snapshot.entries()) {
    await writeTextFile(packageJsonPath(dir), content);
  }
}

export async function bumpPackageVersions(targetVersion: string): Promise<void> {
  for (const dir of PACKAGE_DIRS) {
    const manifest = await readPackageJson(dir);
    manifest.version = targetVersion;
    await writePackageJson(dir, manifest);
  }
}

export async function restoreWorkspaceProtocolDeps(snapshot: Map<string, string>): Promise<void> {
  for (const dir of PACKAGE_DIRS) {
    const current = await readPackageJson(dir);
    const originalRaw = snapshot.get(dir);
    if (!originalRaw) {
      throw new Error(`missing snapshot for ${dir}`);
    }
    const original = JSON.parse(originalRaw) as PackageJson;

    for (const field of ['dependencies', 'peerDependencies'] as const) {
      const currentSection = current[field];
      const originalSection = original[field];
      if (!currentSection || !originalSection) continue;

      for (const [depName, spec] of Object.entries(originalSection)) {
        if (spec.startsWith('workspace:') && depName in currentSection) {
          currentSection[depName] = spec;
        }
      }
    }

    await writePackageJson(dir, current);
  }
}
