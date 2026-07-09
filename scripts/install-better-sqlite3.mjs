/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getDocInitLogPath } from './lib/doc-init-log-path.mjs';
import {
  installBetterSqlite3ViaNpm,
  isBetterSqlite3Loadable,
  resolveTargetVersion,
} from './lib/better-sqlite3-vendor.mjs';

async function appendInstallLog(message) {
  try {
    const logPath = getDocInitLogPath();
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      `${new Date().toISOString()} [better-sqlite3] ${message}\n`
    );
  } catch {
    // ignore logging failures
  }
}

/** @deprecated Use installBetterSqlite3ViaNpm */
export const ensureBetterSqlite3NativeBinary = installBetterSqlite3ViaNpm;

export async function ensureBetterSqlite3ForDocs() {
  const targetVersion = resolveTargetVersion();
  await appendInstallLog(
    `ensure better-sqlite3@${targetVersion} for Node ${process.version} via npm install`
  );

  if (await isBetterSqlite3Loadable()) {
    await appendInstallLog('skip: better-sqlite3 already loadable');
    return { ok: true, skipped: true, reason: 'already-installed' };
  }

  const result = await installBetterSqlite3ViaNpm();
  if (result.ok) {
    await appendInstallLog(`installed better-sqlite3@${targetVersion} via npm`);
  } else {
    await appendInstallLog(
      `npm install failed (${result.reason}): ${result.error ?? 'unknown error'}`
    );
  }
  return result;
}
