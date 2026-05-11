/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { runCommand } from './cmd.js';

/** Normalize `hdc shell param get` stdout (`key = value` or raw). */
export function parseHdcParamStdout(stdout: string): string {
  const t = stdout.trim();
  const i = t.indexOf('=');
  return i !== -1 ? t.slice(i + 1).trim() : t;
}

/**
 * Read a single `param get` value from a device. Returns undefined on failure / empty.
 */
export async function tryGetHdcShellParam(
  hdcPath: string,
  deviceId: string,
  paramKey: string
): Promise<string | undefined> {
  const result = await runCommand(hdcPath, [
    '-t',
    deviceId,
    'shell',
    'param',
    'get',
    paramKey,
  ]);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const raw = result.stdout.trim();
  if (!raw) {
    return undefined;
  }
  return parseHdcParamStdout(raw);
}
