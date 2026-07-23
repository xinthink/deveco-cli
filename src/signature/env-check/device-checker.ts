/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ToolProvider } from '../../toolchain/index.js';
import {
  DeviceManager,
  isLocalEmulatorSerial,
} from '../../service/device-manager.js';
import { getDeviceList } from '../device-manager.js';
import { debugLog } from '../../utils/logger.js';
import { loginService, getTeamList } from '../../auth/index.js';
import type { CheckResult } from './types.js';
import type { AuthInfo } from '../types';

/** 获取默认 teamId，取团队列表第一个；列表为空或 API 不可用时回退到空字符串。 */
async function resolveDefaultTeamId(): Promise<string> {
  try {
    const { teamList } = await getTeamList();
    if (teamList.length > 0) {
      return teamList[0].id;
    }
  } catch {
    // 降级
  }
  return '';
}

/**
 * 查询 CPS 云端设备列表，复用 getDeviceList 实现。
 * 未登录或 API 不可用时抛出异常，由调用方处理。
 */
async function fetchCloudDevices(): Promise<Array<{ deviceId: string; deviceName: string }>> {
  const userInfo = await loginService.getUserInfo();
  const token = await loginService.refreshToken();
  if (!userInfo || !token?.accessToken) {
    throw new Error('Not logged in');
  }

  const teamId = await resolveDefaultTeamId();
  if (!teamId) {
    throw new Error('No team found');
  }

  const auth: AuthInfo = {
    uid: userInfo.userId ?? '',
    teamId,
    accessToken: token.accessToken,
  };

  const devices = await getDeviceList(auth);
  return devices.map((d) => ({
    deviceId: d.udid,
    deviceName: d.deviceName,
  }));
}

export class DeviceChecker {
  constructor(private toolProvider: ToolProvider) {}

  /**
   * 场景 4：检查是否有已连接的设备（真机或模拟器），或 AGC 云端已注册设备。
   * 云端有设备时跳过本地设备检查；无云端设备时回退到本地 hdc 检查。
   */
  async checkDevice(
    fail: (msg: string) => CheckResult
  ): Promise<CheckResult> {
    const NO_DEVICE_MSG = 'Unable to create the profile file due to missing devices.Connect a device through IP or USB, or manually add a device in AppGallery Connect first.If you are installing the HAP package on an emulator, you can skip the signing step.';

    try {
      // 1) 先查 AGC 云端设备列表
      const cloudDevices = await fetchCloudDevices();
      if (cloudDevices.length > 0) {
        debugLog(
          `[EnvCheck] Scenario 4 Device check: ${cloudDevices.length} device(s) found in AGC cloud, skipping local device check`
        );
        return { passed: true, message: '' };
      }
      debugLog(`[EnvCheck] Scenario 4 Device check: no cloud devices found, falling back to local hdc`);

      // 2) 云端无设备，回退到本地 hdc 检查
      const deviceManager = DeviceManager.from(this.toolProvider);
      const devices = await deviceManager.listDevices();

      if (devices.length === 0) {
        debugLog(`[EnvCheck] Scenario 4 Device check: no local devices found`);
        return fail(NO_DEVICE_MSG);
      }

      const hasEmulator = devices.some((d) =>
        isLocalEmulatorSerial(d.serial)
      );
      if (!hasEmulator) {
        debugLog(`[EnvCheck] Scenario 4 Device check: local device found but not an emulator`);
        return fail(NO_DEVICE_MSG);
      }
      return { passed: true, message: '' };
    } catch (e) {
      debugLog(`[EnvCheck] Scenario 4 Device check failed: ${(e as Error).message}`);
      return fail('Unable to detect devices. Please check hdc status. If installing HAP on an emulator, signature step can be skipped.');
    }
  }
}
