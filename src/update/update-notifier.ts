/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { Command } from 'commander';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { yellow } from 'colorette';
import lockfile from 'proper-lockfile';
import { debugLog } from '../utils/logger.js';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import { compareVersions } from '../utils/semver.js';
import { getCurrentVersion, getPublishTag } from './constants.js';
import { VersionCache } from './version-cache.js';

/**
 * Orchestrates non-blocking update notifications.
 *
 * Lifecycle: constructed per CLI invocation → `checkAndNotify()` called from
 * the Commander `postAction` hook so the prompt appears *after* the user's
 * command completes. The actual registry query runs in a detached child
 * process (`update _check`) so the foreground command is never blocked.
 */
export class UpdateNotifier {
  private readonly cache = new VersionCache(
    path.join(getCliDataDir(), 'update')
  );

  /** @param actionCommand - the leaf Commander command that was invoked */
  constructor(private readonly actionCommand: Command) {}

  /** Show an upgrade banner if a newer version is cached, then schedule a background refresh if due. */
  async checkAndNotify(): Promise<void> {
    if (this.shouldSkip()) {
      return;
    }

    try {
      const current = getCurrentVersion();
      const currentTag = getPublishTag();
      const cachedVersion = this.cache.getCheckedAgainstVersion();
      const cachedTag = this.cache.getCheckedAgainstTag();

      // A tag switch invalidates the cached latestVersion: it was fetched via
      // `npm view dist-tags.<oldTag>`, so it belongs to the wrong dist-tag and
      // must not be surfaced — just force a refresh.
      const tagChanged = cachedTag != null && cachedTag !== currentTag;
      const versionChanged = cachedVersion != null && cachedVersion !== current;

      const latestVersion = tagChanged ? null : this.cache.getLatestVersion();
      if (latestVersion && compareVersions(latestVersion, current) > 0) {
        console.log();
        console.log(
          yellow(
            `New version ${latestVersion} available, run \`devecocli update\` to upgrade`
          )
        );
      }

      if (tagChanged || versionChanged || this.cache.isCheckNeeded()) {
        await this.spawnBackgroundCheck();
      }
    } catch (error) {
      debugLog(
        `Update check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Skip notification when the user is already running an `update` subcommand. */
  private shouldSkip(): boolean {
    let current: Command | null = this.actionCommand;
    while (current) {
      if (current.name() === 'update') {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /** Spawn `devecocli update _check` as a detached background process under a file lock. */
  private async spawnBackgroundCheck(): Promise<void> {
    // In tsx dev mode the entry is a .ts file that bare `node` can't execute,
    // so a detached child would silently fail — skip the background spawn.
    if (process.argv[1]?.endsWith('.ts')) {
      return;
    }
    try {
      await withLock(this.cache.getLockPath(), () => {
        // Production entry is dist/cli.js; argv[1] resolves to it when installed.
        const args = [process.argv[1], 'update', '_check'];
        debugLog(`Executing: ${process.execPath} ${args.join(' ')}`);

        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: {
            ...process.env,
            // Prevent recursive version checks in the child process
            DEVECO_CLI_SKIP_VERSION_CHECK: '1',
          },
        });
        child.unref();
      });
    } catch {
      debugLog('Update check lock held by another process, skipping');
    }
  }
}

/** Acquire a short-lived file lock, run `fn`, then release — guarantees cleanup on success or failure. */
async function withLock(
  lockPath: string,
  fn: () => void | Promise<void>
): Promise<void> {
  // Ensure the parent dir exists before locking; the background write that
  // would normally create it only runs after this lock is acquired.
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const release = await lockfile.lock(lockPath, {
    stale: 60_000, // auto-break locks older than 60 s to avoid deadlocks
    retries: 0, // don't wait — another check is already running
    realpath: false,
  });
  try {
    await fn();
  } finally {
    await release();
  }
}
