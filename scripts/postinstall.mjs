/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ensureBetterSqlite3ForDocs } from './install-better-sqlite3.mjs';
import { getCliDataDir } from './lib/cli-data-dir.mjs';
import { getDocInitLogPath } from './lib/doc-init-log-path.mjs';

const STALE_STATE_FILES = ['sqlite-backend.json'];

function cleanupStaleBackendPreferences() {
  const indexDir = join(getCliDataDir(), 'docs', '.index');
  const cleaned = [];
  for (const file of STALE_STATE_FILES) {
    try {
      rmSync(join(indexDir, file));
      cleaned.push(file);
    } catch {
      // not exist or locked — ignore
    }
  }
  if (cleaned.length > 0) {
    try {
      appendFileSync(
        logPath,
        `${new Date().toISOString()} [postinstall] cleared stale backend preferences: ${cleaned.join(', ')}\n`
      );
    } catch {
      // ignore logging failures
    }
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logPath = getDocInitLogPath();
mkdirSync(dirname(logPath), { recursive: true });

const nativeResult = await ensureBetterSqlite3ForDocs();
if (!nativeResult.ok && !nativeResult.skipped) {
  console.warn(
    `[deveco-cli] better-sqlite3 install via npm failed; docs search will use sqlite-wasm fallback.\n` +
      `${nativeResult.error ?? ''}\n`
  );
}

cleanupStaleBackendPreferences();

const initScript = join(root, 'dist', 'internal', 'doc-init-background.js');

if (!existsSync(initScript)) {
  process.exit(0);
}

const child = spawn(
  process.execPath,
  [initScript],
  {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      DEVECO_CLI_SKIP_VERSION_CHECK: '1',
      DEVECO_CLI_POSTINSTALL: '1',
    },
  }
);

child.unref();
process.exit(0);
