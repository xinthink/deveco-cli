/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import {
  DeviceManager,
  isLocalEmulatorSerial,
} from '../service/device-manager.js';
import { tryGetHdcShellParam } from './hdc-param.js';

export { isLocalEmulatorSerial };

export async function fetchEmulatorSerials(hdcPath: string): Promise<string[]> {
  const devices = await DeviceManager.withHdcPath(hdcPath).listDevices();
  return devices
    .map((d) => d.serial)
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
