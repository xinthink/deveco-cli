/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import * as path from 'path';
import { green, red, cyan } from 'colorette';
import { execa } from 'execa';
import {
  getPackageName,
  getCurrentVersion,
  getPublishTag,
  getUpdateDisableMode,
} from '../update/index.js';
import { VersionCache } from '../update/version-cache.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import { debugLog } from '../utils/logger.js';
import { telemetry, EventType } from '../trace/index.js';
import type { CommandExecuted, TrackMeasurement } from '../trace/index.js';

const updateCommand = new Command('update').description(
  'Update deveco-cli to latest'
);

updateCommand.command('_check', { hidden: true }).action(async () => {
  const start = Date.now();
  const cache = new VersionCache(path.join(getCliDataDir(), 'update'));

  try {
    const publishTag = getPublishTag();
    const pkgName = getPackageName();

    // Fetch the tag-pinned version's package.json: dist-tags are absent at the
    // top level when querying a specific version/tag, so read `version` and
    // `blockedVersions` directly from that version's metadata.
    debugLog(`Executing: npm view ${pkgName}@${publishTag} --json`);
    const { stdout } = await execa('npm', [
      'view',
      `${pkgName}@${publishTag}`,
      '--json',
    ]);
    const info = JSON.parse(stdout) as Record<string, unknown>;

    const latestVersion =
      typeof info.version === 'string' ? info.version.trim() : null;
    const blockedVersions = Array.isArray(info.blockedVersions)
      ? (info.blockedVersions as string[])
      : [];

    await cache.writeSuccess(
      latestVersion,
      blockedVersions,
      getCurrentVersion(),
      publishTag
    );
    await trackUpdateCheck(start, true, null);
  } catch (error) {
    await cache.writeError(
      error instanceof Error ? error.message : String(error)
    );
    const e = error as NodeJS.ErrnoException;
    const errorCode = e.code ?? e.name ?? 'UnknownError';
    await trackUpdateCheck(start, false, errorCode);
  }
});

const updateEvent: CommandExecuted = {
  event: EventType.CommandExecuted,
  args: ['update'],
};

const updateCheckEvent: CommandExecuted = {
  event: EventType.CommandExecuted,
  args: ['update', '_check'],
};

async function trackUpdate(
  start: number,
  success: boolean,
  errorCode: string | null
): Promise<void> {
  const measurement: TrackMeasurement = {
    duration_ms: Date.now() - start,
    success,
    error_code: errorCode,
  };
  await telemetry.track(updateEvent, measurement).catch(() => {});
}

async function trackUpdateCheck(
  start: number,
  success: boolean,
  errorCode: string | null
): Promise<void> {
  const measurement: TrackMeasurement = {
    duration_ms: Date.now() - start,
    success,
    error_code: errorCode,
  };
  await telemetry.track(updateCheckEvent, measurement).catch(() => {});
}

updateCommand.action(async () => {
  if (getUpdateDisableMode() === 'all') {
    throw new Error(
      'devecocli update is disabled (DEVECO_CLI_DISABLE_UPDATE=all).'
    );
  }
  const start = Date.now();
  const currentVersion = getCurrentVersion();
  const publishTag = getPublishTag();

  console.log(cyan(`Checking for updates...`));
  const pkgName = getPackageName();
  try {
    // Get the tagged version from npm registry
    const { stdout: latestVersion } = await execa('npm', [
      'view',
      pkgName,
      `dist-tags.${publishTag}`,
    ]);
    const latest = latestVersion.trim();

    if (!latest || latest === currentVersion) {
      console.log(
        green(
          `\n${pkgName} is already up to date (v${currentVersion}, tag: ${publishTag})`
        )
      );
      await trackUpdate(start, true, null);
      return;
    }

    console.log(
      cyan(`\nNew version found: ${latest} (current: ${currentVersion})`)
    );
    console.log(cyan(`Updating ${pkgName}...`));

    await execa('npm', ['install', '-g', `${pkgName}@${publishTag}`], {
      stdio: 'inherit',
    });

    console.log(
      '\n' + green(`${pkgName} updated successfully to version ${latest}.`)
    );
    await trackUpdate(start, true, null);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    const errorCode = e.code ?? e.name ?? 'UnknownError';
    console.error(red(`Failed to update ${pkgName}`));
    if (e.message) {
      console.error(red(e.message));
    }
    await trackUpdate(start, false, errorCode);
    process.exit(1);
  }
});

export default updateCommand;
