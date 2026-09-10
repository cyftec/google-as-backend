#!/usr/bin/env bun
import {
  PACKAGES,
  readPackageJson,
  readTarGzEntry,
  SEMVER_RE,
  workspaceDeps,
  type PackageJson,
} from './lib.ts';

export class PublishCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishCheckError';
  }
}

function fail(message: string): never {
  throw new PublishCheckError(message);
}

function parseVersion(): string {
  const version = process.env.PUBLISH_VERSION ?? process.argv[2];
  if (!version) {
    fail('missing version — pass as arg or set PUBLISH_VERSION');
  }
  if (!SEMVER_RE.test(version)) {
    fail(`invalid semver: ${version}`);
  }
  return version;
}

async function verifyPackedManifest(packageDir: string): Promise<void> {
  const absDir = `${import.meta.dir}/../${packageDir}`;
  const proc = Bun.spawn(['bun', 'pm', 'pack', '--ignore-scripts'], {
    cwd: absDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    fail(`bun pm pack failed in ${packageDir}: ${stderr.trim() || stdout.trim()}`);
  }

  const tarballLine = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz'));
  if (!tarballLine) {
    fail(`bun pm pack did not report tarball name in ${packageDir}`);
  }

  const tarballPath = `${absDir}/${tarballLine}`;
  const manifest = await readTarGzEntry(tarballPath, 'package/package.json');
  await Bun.file(tarballPath).delete().catch(() => {});

  if (!manifest) {
    fail(`failed to read packed manifest in ${packageDir}`);
  }
  if (manifest.includes('workspace:')) {
    fail(`packed manifest in ${packageDir} still contains workspace: protocol`);
  }
}

export async function runPublishCheck(targetVersion: string): Promise<void> {
  if (!SEMVER_RE.test(targetVersion)) {
    fail(`invalid semver: ${targetVersion}`);
  }

  const versionsByName = new Map<string, string>();
  for (const pkg of PACKAGES) {
    const manifest = await readPackageJson(pkg.dir);
    if (manifest.version !== targetVersion) {
      fail(
        `${pkg.name} version is ${manifest.version ?? 'missing'}, expected ${targetVersion}`,
      );
    }
    if (!manifest.version) {
      fail(`${pkg.name} is missing a version field`);
    }
    versionsByName.set(pkg.name, manifest.version);
  }

  for (const pkg of PACKAGES) {
    const manifest: PackageJson = await readPackageJson(pkg.dir);
    for (const [depName, spec] of workspaceDeps(manifest)) {
      const resolvedVersion = versionsByName.get(depName);
      if (!resolvedVersion) {
        fail(`${pkg.name} depends on ${depName} (${spec}) but no workspace package matches`);
      }
      if (resolvedVersion !== targetVersion) {
        fail(
          `${pkg.name} depends on ${depName} (${spec}) which would resolve to ${resolvedVersion}, expected ${targetVersion}`,
        );
      }
    }

    if (workspaceDeps(manifest).length > 0) {
      await verifyPackedManifest(pkg.dir);
    }
  }
}

if (import.meta.main) {
  try {
    await runPublishCheck(parseVersion());
    console.log(
      `publish-check: ok — all packages at ${process.env.PUBLISH_VERSION ?? process.argv[2]}, workspace deps resolve correctly`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`publish-check: ${message}`);
    process.exit(1);
  }
}
