/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { runCommand } from './cmd.js';
import { tryGetHdcShellParam } from './hdc-param.js';

export function isLocalEmulatorSerial(serial: string): boolean {
  return serial.startsWith('127.0.0.1:');
}

export async function fetchEmulatorSerials(hdcPath: string): Promise<string[]> {
  const r = await runCommand(hdcPath, ['list', 'targets']);
  if (r.exitCode !== 0) {
    return [];
  }
  return r.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(isLocalEmulatorSerial);
}

export async function fetchRunningEmulatorHvds(
  hdcPath: string
): Promise<string[]> {
  const serials = await fetchEmulatorSerials(hdcPath);
  if (serials.length === 0) {
    return [];
  }
  const hvds = await Promise.all(
    serials.map((serial) =>
      tryGetHdcShellParam(hdcPath, serial, 'ohos.qemu.hvd.name')
    )
  );
  return hvds.filter((hvd): hvd is string => !!hvd);
}

export async function isEmulatorRunningByHdcName(
  hdcPath: string,
  name: string
): Promise<boolean> {
  const hvds = await fetchRunningEmulatorHvds(hdcPath);
  return hvds.includes(name);
}
