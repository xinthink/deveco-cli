/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as path from 'path';
import { homedir } from 'os';

const APP_NAME = 'deveco-cli';

/** Strip quotes from cmd.exe `set VAR="path"` (quotes become part of the value). */
function normalizeEnvDataDir(value: string): string {
  let normalized = value.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function isCliDataDirConfigured(): boolean {
  const raw = process.env.DEVECO_CLI_DATA_DIR;
  return raw !== undefined && normalizeEnvDataDir(raw) !== '';
}

function getDefaultCliDataDir(): string {
  return path.join(homedir(), '.local', 'share', APP_NAME);
}

export function buildCliDataDirHintLines(logPath: string): string[] {
  const dataDir = getCliDataDir();
  if (isCliDataDirConfigured()) {
    return [
      `Data directory (DEVECO_CLI_DATA_DIR): ${dataDir}`,
      'If you changed this in System Environment Variables, open a new terminal and retry.',
      `Log file: ${logPath}`,
    ];
  }
  return [
    `Data directory (default): ${dataDir}`,
    'To use a custom location, set DEVECO_CLI_DATA_DIR and open a new terminal.',
    `Log file: ${logPath}`,
  ];
}

export function getCliDataDir(): string {
  const raw = process.env.DEVECO_CLI_DATA_DIR;
  if (raw === undefined || raw === '') {
    return getDefaultCliDataDir();
  }
  const envDir = normalizeEnvDataDir(raw);
  if (!envDir) {
    return getDefaultCliDataDir();
  }
  return path.resolve(envDir);
}
