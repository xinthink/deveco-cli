/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getDocInitLogPath } from './lib/doc-init-log-path.mjs';
import { installJiebaWasmViaNpm } from './lib/jieba-wasm-vendor.mjs';

async function appendInstallLog(message) {
  try {
    const logPath = getDocInitLogPath();
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      `${new Date().toISOString()} [jieba-wasm] ${message}\n`
    );
  } catch {
    // ignore logging failures
  }
}

export async function ensureJiebaWasmForDocs() {
  await appendInstallLog(
    `ensure @node-rs/jieba-wasm32-wasi@2.0.1 for Node ${process.version}`
  );
  const result = await installJiebaWasmViaNpm();
  if (result.skipped) {
    if (result.reason === 'already-installed') {
      await appendInstallLog('skip: jieba wasm32-wasi already loadable');
    } else if (result.reason === 'native-available') {
      await appendInstallLog('skip: jieba native already loadable');
    } else {
      await appendInstallLog(`skip: ${result.reason}`);
    }
  } else if (result.ok) {
    await appendInstallLog(
      'installed @node-rs/jieba-wasm32-wasi@2.0.1 via npm'
    );
  } else {
    await appendInstallLog(
      `npm install failed (${result.reason}): ${result.error ?? 'unknown error'}`
    );
  }
  return result;
}
