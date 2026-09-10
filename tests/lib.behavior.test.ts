import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  bumpPackageVersions,
  PACKAGE_DIRS,
  packageJsonPath,
  readPackageJson,
  readTarEntry,
  readTarGzEntry,
  readTextFile,
  restoreAllPackageJsonFiles,
  restoreWorkspaceProtocolDeps,
  snapshotPackageJsonFiles,
  workspaceDeps,
  writePackageJson,
} from '../scripts/lib.ts';
import { createTarArchive, createTarGzFixture } from './mocks/tar-fixture.ts';

describe('publish lib', () => {
  describe('workspaceDeps', () => {
    it('collects workspace protocol entries from dependencies and peerDependencies', () => {
      expect(
        workspaceDeps({
          dependencies: {
            '@cyfgoogle/oauth': 'workspace:*',
            lodash: '^4.0.0',
          },
          peerDependencies: {
            '@cyfgoogle/drive-folder': 'workspace:^',
          },
        }),
      ).toEqual([
        ['@cyfgoogle/oauth', 'workspace:*'],
        ['@cyfgoogle/drive-folder', 'workspace:^'],
      ]);
    });
  });

  describe('readTarEntry', () => {
    it('reads a named entry from an in-memory tar archive', () => {
      const archive = createTarArchive({
        'package/package.json': '{"name":"demo","version":"1.0.0"}',
        'package/index.ts': 'export {}',
      });

      expect(readTarEntry(archive, 'package/package.json')).toBe(
        '{"name":"demo","version":"1.0.0"}',
      );
      expect(readTarEntry(archive, 'package/missing.ts')).toBeUndefined();
    });
  });

  describe('readTarGzEntry', () => {
    it('reads a named entry from a .tgz fixture on disk', async () => {
      const tarGzPath = `/tmp/drive-socket-${Bun.randomUUIDv7()}.tgz`;
      await createTarGzFixture(tarGzPath, {
        'package/package.json': '{"name":"demo","version":"2.0.0"}',
      });

      expect(await readTarGzEntry(tarGzPath, 'package/package.json')).toBe(
        '{"name":"demo","version":"2.0.0"}',
      );

      await Bun.file(tarGzPath).delete();
    });
  });

  describe('package manifest snapshot helpers', () => {
    let snapshot: Map<string, string>;
    const targetVersion = '9.9.9-test';

    beforeEach(async () => {
      snapshot = await snapshotPackageJsonFiles();
    });

    afterEach(async () => {
      await restoreAllPackageJsonFiles(snapshot);
    });

    it('bumps every workspace package version', async () => {
      await bumpPackageVersions(targetVersion);

      for (const dir of PACKAGE_DIRS) {
        expect((await readPackageJson(dir)).version).toBe(targetVersion);
      }
    });

    it('restores all package.json files from snapshot', async () => {
      await bumpPackageVersions(targetVersion);
      await restoreAllPackageJsonFiles(snapshot);

      for (const dir of PACKAGE_DIRS) {
        const original = snapshot.get(dir);
        if (!original) {
          throw new Error(`missing snapshot for ${dir}`);
        }
        expect(await readTextFile(packageJsonPath(dir))).toBe(original);
      }
    });

    it('restores workspace:* deps while keeping bumped versions', async () => {
      await bumpPackageVersions(targetVersion);

      const folder = await readPackageJson('packages/drive-folder');
      folder.dependencies!['@cyfgoogle/oauth'] = targetVersion;
      await writePackageJson('packages/drive-folder', folder);

      const socket = await readPackageJson('packages/drive-as-socket');
      socket.dependencies!['@cyfgoogle/oauth'] = targetVersion;
      socket.dependencies!['@cyfgoogle/drive-folder'] = targetVersion;
      await writePackageJson('packages/drive-as-socket', socket);

      await restoreWorkspaceProtocolDeps(snapshot);

      expect((await readPackageJson('packages/oauth')).version).toBe(targetVersion);
      expect((await readPackageJson('packages/drive-folder')).dependencies).toEqual({
        '@cyfgoogle/oauth': 'workspace:*',
      });
      expect((await readPackageJson('packages/drive-as-socket')).dependencies).toEqual({
        '@cyfgoogle/oauth': 'workspace:*',
        '@cyfgoogle/drive-folder': 'workspace:*',
      });
    });
  });
});
