/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { debugLog } from '../../utils/logger.js';
import { getSqliteBackendStateFile } from './doc-paths.js';
import { assertSafeRegularFile } from './path-safety.js';
import { createBetterSqliteBackend } from './sqlite-better-backend.js';
import { createSqliteWasmBackend } from './sqlite-wasm-backend.js';
import type { SqliteBackend } from './sqlite-types.js';

let backendPromise: Promise<SqliteBackend> | null = null;
let activeBackend: SqliteBackend | null = null;

function hasPersistedWasmPreference(): boolean {
  return fs.existsSync(getSqliteBackendStateFile());
}

function writeBackendState(message: string): void {
  const filePath = getSqliteBackendStateFile();
  const state = {
    backend: 'sqlite-wasm',
    reason: 'better-sqlite3-load-failed',
    message,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertSafeRegularFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

async function resolveBackend(): Promise<SqliteBackend> {
  if (hasPersistedWasmPreference()) {
    return createSqliteWasmBackend();
  }

  try {
    const backend = await createBetterSqliteBackend();
    debugLog('doc-index: using better-sqlite3 SQLite backend');
    return backend;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeBackendState(message);
    debugLog(
      `doc-index: better-sqlite3 unavailable (${message}); falling back to sqlite-wasm`
    );
  }

  return createSqliteWasmBackend();
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
