/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureBetterSqlite3NativeBinary } from './install-better-sqlite3.mjs';
import { getDocInitLogPath } from './lib/doc-init-log-path.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logPath = getDocInitLogPath();
process.env.DEVECO_DOC_INIT_LOG = logPath;
mkdirSync(dirname(logPath), { recursive: true });

const nativeResult = await ensureBetterSqlite3NativeBinary();
if (!nativeResult.ok && !nativeResult.skipped) {
  console.warn(`[deveco-cli]\n${nativeResult.hint ?? 'better-sqlite3 native install failed'}\n`);
}
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
      DEVECO_DOC_INIT_LOG: logPath,
    },
  }
);

child.unref();
process.exit(0);
