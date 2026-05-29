/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { execa } from 'execa';
import lock, { type LockOptions } from 'proper-lockfile';

function lockFilePath(projectRoot: string): string {
  return resolve(projectRoot, '.hvigor', '.build-lock');
}

function notifyOnce(fn?: () => void): () => void {
  let notified = false;
  return () => {
    if (notified) {
      return;
    }
    notified = true;
    fn?.();
  };
}

async function ensureLockDir(projectRoot: string): Promise<void> {
  const dir = dirname(lockFilePath(projectRoot));
  await mkdir(dir, { recursive: true });
  if (process.platform === 'win32') {
    try {
      await execa('attrib', ['+h', dir]);
    } catch {
      // Ignore failure; hiding the directory is cosmetic.
    }
  }
}

async function acquireFileLock(
  projectRoot: string,
  onWait?: () => void
): Promise<{ release: () => Promise<void>; signal: AbortSignal }> {
  const abortController = new AbortController();
  const notifyWaiting = notifyOnce(onWait);

  await ensureLockDir(projectRoot);

  const lockOptions: LockOptions = {
    lockfilePath: lockFilePath(projectRoot),
    realpath: false,
    stale: 5_000,
    update: 2_000,
    onCompromised: () => abortController.abort(),
  };

  try {
    const release = await lock(projectRoot, {
      ...lockOptions,
      retries: 0,
    });
    return { release, signal: abortController.signal };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code !== 'ELOCKED') {
      throw err;
    }
  }

  notifyWaiting();

  const release = await lock(projectRoot, {
    ...lockOptions,
    retries: {
      forever: true,
      minTimeout: 1000,
      maxTimeout: 1000,
    },
  });

  return { release, signal: abortController.signal };
}

export async function withBuildLock<T>(
  projectRoot: string,
  action: (signal: AbortSignal) => Promise<T>,
  onWait?: () => void
): Promise<T> {
  const { release, signal } = await acquireFileLock(projectRoot, onWait);

  try {
    return await action(signal);
  } finally {
    await release();
  }
}
