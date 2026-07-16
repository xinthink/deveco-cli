/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ensureBetterSqlite3ForDocs } from './install-better-sqlite3.mjs';
import { ensureJiebaWasmForDocs } from './install-jieba-wasm.mjs';
import { getDocInitLogPath } from './lib/doc-init-log-path.mjs';

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

const jiebaResult = await ensureJiebaWasmForDocs();
if (!jiebaResult.ok && !jiebaResult.skipped) {
  console.warn(
    `[deveco-cli] jieba wasm install via npm failed; docs search may fail on this machine.\n` +
      `${jiebaResult.error ?? ''}\n`
  );
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
    },
  }
);

child.unref();
process.exit(0);
