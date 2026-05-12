/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ToolProvider } from './tool-provider.js';
import { runCommand } from './cmd.js';
import { tryGetHdcShellParam } from './hdc-param.js';

export async function resolveHdcPath(): Promise<string | null> {
  try {
    const toolProvider = await ToolProvider.new();
    return toolProvider.hdcPath;
  } catch {
    return null;
  }
}

export async function fetchEmulatorSerials(hdcPath: string): Promise<string[]> {
  const r = await runCommand(hdcPath, ['list', 'targets']);
  if (r.exitCode !== 0) {
    return [];
  }
  return r.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((serial) => serial.startsWith('127.0.0.1:'));
}

export async function isEmulatorRunningByHdcName(
  name: string
): Promise<boolean> {
  const hdcPath = await resolveHdcPath();
  if (!hdcPath) {
    return false;
  }
  const serials = await fetchEmulatorSerials(hdcPath);
  for (const serial of serials) {
    const hvd = await tryGetHdcShellParam(
      hdcPath,
      serial,
      'ohos.qemu.hvd.name'
    );
    if (hvd === name) {
      return true;
    }
  }
  return false;
}
