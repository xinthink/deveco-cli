/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * Install better-sqlite3 native binary at postinstall / runtime retry.
 * Runtime selects legacy vs modern better-sqlite3 and downloads a matching prebuild.
 */
import { existsSync } from 'fs';
import { appendFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { getDocInitLogPath } from './lib/doc-init-log-path.mjs';
import {
  buildBetterSqlite3InstallInstructions,
  downloadPrebuildForTriple,
  ensurePackageVersion,
  getRuntimeTriple,
  nativeBinaryPath,
  resolveBetterSqlite3PackageDir,
  resolveTargetVersion,
  runPrebuildInstall,
  tripleKey,
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

export async function ensureBetterSqlite3NativeBinary() {
  const targetVersion = resolveTargetVersion();
  await appendInstallLog(
    `target better-sqlite3@${targetVersion} for Node ${process.version}`
  );

  const versionResult = await ensurePackageVersion(targetVersion);
  if (!versionResult.ok) {
    const hint = buildBetterSqlite3InstallInstructions(
      getRuntimeTriple(),
      targetVersion,
      versionResult.error
    );
    await appendInstallLog(`package install failed: ${versionResult.error ?? versionResult.reason}`);
    return { ok: false, reason: versionResult.reason, hint };
  }
  if (versionResult.changed) {
    await appendInstallLog(`installed better-sqlite3@${targetVersion} via npm`);
  }

  const packageDir = await resolveBetterSqlite3PackageDir();
  if (!existsSync(join(packageDir, 'package.json'))) {
    await appendInstallLog('skip: better-sqlite3 package not installed');
    return { ok: false, skipped: true, reason: 'package-missing' };
  }

  const target = nativeBinaryPath(packageDir);
  if (existsSync(target) && !versionResult.changed) {
    await appendInstallLog(`skip: native binary already present (${target})`);
    return {
      ok: true,
      skipped: true,
      reason: 'already-built',
      target,
      method: 'existing',
      version: targetVersion,
    };
  }

  const triple = getRuntimeTriple();

  const downloaded = await downloadPrebuildForTriple(triple, target, targetVersion);
  if (downloaded.ok) {
    await appendInstallLog(`installed via download: ${downloaded.url}`);
    return { ...downloaded, target, version: targetVersion };
  }
  await appendInstallLog(
    `download failed for ${downloaded.asset}: ${downloaded.error ?? downloaded.reason}`
  );

  const prebuild = runPrebuildInstall(packageDir);
  if (prebuild.ok) {
    await appendInstallLog(`installed via prebuild-install: ${prebuild.target}`);
    return { ...prebuild, version: targetVersion };
  }
  await appendInstallLog(
    `prebuild-install failed: ${prebuild.detail ?? prebuild.reason ?? 'unknown'}`
  );

  const hint = buildBetterSqlite3InstallInstructions(
    triple,
    targetVersion,
    [
      downloaded.error && `download: ${downloaded.error}`,
      prebuild.detail && `prebuild-install: ${prebuild.detail}`,
    ]
      .filter(Boolean)
      .join('; ')
  );

  return {
    ok: false,
    reason: 'all-methods-failed',
    triple,
    key: tripleKey(triple),
    version: targetVersion,
    hint,
  };
}

/** @deprecated Use ensureBetterSqlite3NativeBinary */
export const installBetterSqlite3FromVendor = ensureBetterSqlite3NativeBinary;
