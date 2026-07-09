/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 *
 * Keep in sync with src/utils/cli-data-dir.ts
 */

import { homedir } from 'os';
import { join, resolve } from 'path';

const APP_NAME = 'deveco-cli';

/** Strip quotes from cmd.exe `set VAR="path"` (quotes become part of the value). */
function normalizeEnvDataDir(value) {
  let normalized = value.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function isCliDataDirConfigured() {
  const raw = process.env.DEVECO_CLI_DATA_DIR;
  return raw !== undefined && normalizeEnvDataDir(raw) !== '';
}

function getDefaultCliDataDir() {
  return join(homedir(), '.local', 'share', APP_NAME);
}

export function getCliDataDir() {
  const raw = process.env.DEVECO_CLI_DATA_DIR;
  if (raw === undefined || raw === '') {
    return getDefaultCliDataDir();
  }
  const envDir = normalizeEnvDataDir(raw);
  if (!envDir) {
    return getDefaultCliDataDir();
  }
  return resolve(envDir);
}
