/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { debugLog } from '../../utils/logger.js';
import { createBetterSqliteBackend } from './sqlite-better-backend.js';
import { createSqliteWasmBackend } from './sqlite-wasm-backend.js';
import type { SqliteBackend } from './sqlite-types.js';

let backendPromise: Promise<SqliteBackend> | null = null;
let activeBackend: SqliteBackend | null = null;

async function resolveBackend(): Promise<SqliteBackend> {
  try {
    const backend = await createBetterSqliteBackend();
    debugLog('doc-index: using better-sqlite3 SQLite backend');
    return backend;
  } catch (error) {
    debugLog(
      `doc-index: better-sqlite3 unavailable (${(error as Error).message}); falling back to sqlite-wasm`
    );
  }

  const wasmBackend = await createSqliteWasmBackend();
  debugLog('doc-index: using @sqlite.org/sqlite-wasm SQLite backend');
  return wasmBackend;
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
