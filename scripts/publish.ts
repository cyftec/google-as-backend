#!/usr/bin/env bun
import {
  bumpPackageVersions,
  restoreAllPackageJsonFiles,
  restoreWorkspaceProtocolDeps,
  ROOT,
  SEMVER_RE,
  snapshotPackageJsonFiles,
} from './lib.ts';
import { runPublishCheck } from './publish-check.ts';

function usage(): never {
  console.error('Usage: bun scripts/publish.ts <version> [--dry-run]');
  console.error('       bun run publish:login');
  process.exit(1);
}

function parseArgs(): { version: string; dryRun: boolean } {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const dryRun = args.includes('--dry-run');
  const version = args.find((arg) => !arg.startsWith('-'));
  if (!version) usage();
  if (!SEMVER_RE.test(version)) {
    console.error(`publish: invalid semver: ${version}`);
    process.exit(1);
  }
  return { version, dryRun };
}

async function runCommand(
  cmd: string[],
  options: { cwd?: string; label: string },
): Promise<void> {
  console.log(`\n> ${options.label}`);
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${options.label} failed with exit code ${exitCode}`);
  }
}

async function publishPackages(dryRun: boolean): Promise<void> {
  const dirs = [
    'packages/oauth',
    'packages/drive-folder',
    'packages/drive-as-socket',
  ] as const;

  for (const dir of dirs) {
    const args = dryRun ? ['publish', '--dry-run'] : ['publish'];
    await runCommand(['bun', ...args], {
      cwd: `${ROOT}/${dir}`,
      label: `bun ${args.join(' ')} (${dir})`,
    });
  }
}

async function main(): Promise<void> {
  const { version, dryRun } = parseArgs();
  const snapshot = await snapshotPackageJsonFiles();
  let keepVersionBumps = false;

  try {
    console.log(`publish: preparing release ${version}${dryRun ? ' (dry-run)' : ''}`);
    await bumpPackageVersions(version);
    await runPublishCheck(version);
    await runCommand(['bun', 'run', 'tests'], { label: 'bun run tests' });
    await publishPackages(dryRun);

    if (dryRun) {
      await restoreAllPackageJsonFiles(snapshot);
      console.log('\npublish: dry-run complete — package.json files restored');
    } else {
      keepVersionBumps = true;
      await restoreWorkspaceProtocolDeps(snapshot);
      await runCommand(['bun', 'install'], { label: 'bun install' });
      console.log(`\npublish: released ${version} — versions bumped, workspace:* restored`);
    }
  } catch (error) {
    if (keepVersionBumps) {
      await restoreWorkspaceProtocolDeps(snapshot).catch(() => {});
    } else {
      await restoreAllPackageJsonFiles(snapshot).catch(() => {});
    }
    console.error(`\npublish: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
