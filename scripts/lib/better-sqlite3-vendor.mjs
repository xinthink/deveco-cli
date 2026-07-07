/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { readFile, stat, writeFile } from 'fs/promises';
import { spawnSync } from 'child_process';

export const BETTER_SQLITE3_VERSION_LEGACY = '11.10.0';
export const BETTER_SQLITE3_VERSION_NODE20 = '12.9.0';
export const BETTER_SQLITE3_VERSION_NODE21 = '9.6.0';
export const BETTER_SQLITE3_VERSION_LATEST = '12.11.1';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(scriptDir, '..', '..');

export function resolveTargetVersion(nodeVersion = process.version) {
  const major = Number(nodeVersion.slice(1).split('.')[0]);
  if (major === 18) {
    return BETTER_SQLITE3_VERSION_LEGACY;
  }
  if (major === 20 || major === 23) {
    return BETTER_SQLITE3_VERSION_NODE20;
  }
  if (major === 21) {
    return BETTER_SQLITE3_VERSION_NODE21;
  }
  return BETTER_SQLITE3_VERSION_LATEST;
}

export function isUnsupportedNodeVersion(nodeVersion = process.version) {
  return Number(nodeVersion.slice(1).split('.')[0]) === 19;
}

function resolveNpmCliPath() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function quoteWindowsCmdArg(arg) {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function spawnDetail(result) {
  return [result.stderr, result.stdout, result.error?.message]
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function runNpmInstallBetterSqlite3(targetVersion) {
  const args = ['install', `better-sqlite3@${targetVersion}`, '--no-save'];
  const npmCli = resolveNpmCliPath();
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...args], {
      cwd: packageRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  }

  if (process.platform === 'win32') {
    const command = ['npm', ...args].map(quoteWindowsCmdArg).join(' ');
    return spawnSync(command, {
      cwd: packageRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: true,
    });
  }

  return spawnSync('npm', args, {
    cwd: packageRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
}

export async function isBetterSqlite3Loadable() {
  try {
    await import('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

export async function installBetterSqlite3ViaNpm(nodeVersion = process.version) {
  if (isUnsupportedNodeVersion(nodeVersion)) {
    return {
      ok: false,
      reason: 'unsupported-node',
      error: 'Node.js 19 is not supported for better-sqlite3',
    };
  }

  if (await isBetterSqlite3Loadable()) {
    return { ok: true, skipped: true, reason: 'already-installed' };
  }

  const targetVersion = resolveTargetVersion(nodeVersion);
  const result = runNpmInstallBetterSqlite3(targetVersion);
  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'npm-install-failed',
      version: targetVersion,
      error: spawnDetail(result) || `exit ${result.status ?? 'null'}`,
    };
  }

  if (!(await isBetterSqlite3Loadable())) {
    return {
      ok: false,
      reason: 'load-failed',
      version: targetVersion,
      error: 'npm install finished but better-sqlite3 still cannot be imported',
    };
  }

  return { ok: true, version: targetVersion, method: 'npm' };
}
