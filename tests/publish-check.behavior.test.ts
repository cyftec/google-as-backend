import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  bumpPackageVersions,
  PACKAGE_DIRS,
  readPackageJson,
  restoreAllPackageJsonFiles,
  snapshotPackageJsonFiles,
  writePackageJson,
} from '../scripts/lib.ts';
import { PublishCheckError, runPublishCheck } from '../scripts/publish-check.ts';

describe('runPublishCheck', () => {
  let snapshot: Map<string, string>;
  const targetVersion = '8.8.8-test';

  beforeEach(async () => {
    snapshot = await snapshotPackageJsonFiles();
  });

  afterEach(async () => {
    await restoreAllPackageJsonFiles(snapshot);
  });

  it('rejects invalid semver targets', async () => {
    await expect(runPublishCheck('not-a-version')).rejects.toBeInstanceOf(PublishCheckError);
  });

  it('fails when package versions do not match the target', async () => {
    await expect(runPublishCheck(targetVersion)).rejects.toThrow(
      `@cyftec/google-oauth version is 0.1.0, expected ${targetVersion}`,
    );
  });

  it('passes when all packages are bumped and packed manifests resolve workspace deps', async () => {
    await bumpPackageVersions(targetVersion);
    await expect(runPublishCheck(targetVersion)).resolves.toBeUndefined();
  });

  it('fails when a sibling version is stale after a partial bump', async () => {
    await bumpPackageVersions(targetVersion);
    const oauth = await readPackageJson('packages/google-oauth');
    oauth.version = '0.1.0';
    await writePackageJson('packages/google-oauth', oauth);

    await expect(runPublishCheck(targetVersion)).rejects.toThrow(
      `@cyftec/google-oauth version is 0.1.0, expected ${targetVersion}`,
    );
  });

  it('validates every publishable package is checked', async () => {
    await bumpPackageVersions(targetVersion);
    for (const dir of PACKAGE_DIRS) {
      expect((await readPackageJson(dir)).version).toBe(targetVersion);
    }
    await runPublishCheck(targetVersion);
  });
});
