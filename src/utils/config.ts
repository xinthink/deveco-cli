/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export interface HilogOptions {
  deviceId?: string;
  isCrashLog?: boolean;
  level?: string;
  tag?: string;
  domain?: string;
  bundleName?: string;
  keyword?: string;
  logSize?: string;
}

export interface DeviceInfo {
  deviceId: string;
  isEmulator: boolean;
  name: string;
  isConnected: boolean;
}
