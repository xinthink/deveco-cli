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

const BATCH_DELIM = '__DEVECO_PARAM_DELIM__';

export async function tryGetHdcShellParams(
  hdcPath: string,
  deviceId: string,
  paramKeys: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paramKeys.length === 0) {
    return result;
  }
  if (paramKeys.length === 1) {
    const v = await tryGetHdcShellParam(hdcPath, deviceId, paramKeys[0]);
    if (v) {
      result.set(paramKeys[0], v);
    }
    return result;
  }

  const command =
    paramKeys.map((k) => `param get ${k}`).join(`; echo ${BATCH_DELIM}; `) +
    `; echo ${BATCH_DELIM}`;

  const r = await runCommand(hdcPath, ['-t', deviceId, 'shell', command]);
  if (r.exitCode !== 0) {
    return result;
  }

  const segments = r.stdout.split(BATCH_DELIM);
  for (let i = 0; i < paramKeys.length; i++) {
    const raw = segments[i] ?? '';
    if (!raw.trim()) {
      continue;
    }
    const value = parseHdcParamStdout(raw);
    if (value) {
      result.set(paramKeys[i], value);
    }
  }
  return result;
}
