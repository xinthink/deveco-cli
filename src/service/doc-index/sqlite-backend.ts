/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { debugLog } from '../../utils/logger.js';
import { getPackageRoot } from './doc-paths.js';
import { createBetterSqliteBackend } from './sqlite-better-backend.js';
import type { SqliteBackend } from './sqlite-types.js';

let backendPromise: Promise<SqliteBackend> | null = null;
let activeBackend: SqliteBackend | null = null;

async function tryInstallNativePrebuild(): Promise<boolean> {
  const scriptsPath = join(getPackageRoot(), 'scripts', 'install-better-sqlite3.mjs');
  if (!existsSync(scriptsPath)) {
    return false;
  }

  try {
    const { ensureBetterSqlite3NativeBinary } = await import(pathToFileURL(scriptsPath).href);
    const result = await ensureBetterSqlite3NativeBinary();
    if (!result.ok && result.hint) {
      throw new Error(result.hint);
    }
    return Boolean(result.ok);
  } catch (error) {
    debugLog(`native install failed: ${(error as Error).message}`);
    throw error;
  }
}

function buildLoadError(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (detail.includes('Install attempts') || detail.includes('npm config set registry')) {
    return new Error(detail);
  }
  return new Error(
    [
      'better-sqlite3 native module is not available.',
      '',
      'Re-run global install after setting npm registry, e.g.:',
      '  npm config set registry https://registry.npmmirror.com',
      '',
      `Detail: ${detail}`,
    ].join('\n')
  );
}

async function resolveBackend(): Promise<SqliteBackend> {
  try {
    const backend = await createBetterSqliteBackend();
    debugLog('doc-index: using better-sqlite3 SQLite backend');
    return backend;
  } catch (firstError) {
    debugLog(
      `doc-index: better-sqlite3 load failed (${(firstError as Error).message}); trying download install`
    );
  }

  try {
    await tryInstallNativePrebuild();
    const backend = await createBetterSqliteBackend();
    debugLog('doc-index: using better-sqlite3 after install helper');
    return backend;
  } catch (installError) {
    throw buildLoadError(installError);
  }
}

export async function getSqliteBackend(): Promise<SqliteBackend> {
  if (!backendPromise) {
    backendPromise = resolveBackend().then((backend) => {
      activeBackend = backend;
      return backend;
    });
  }
  return backendPromise;
}

export function resetSqliteBackendCache(): void {
  activeBackend?.resetCache();
  backendPromise = null;
  activeBackend = null;
}
