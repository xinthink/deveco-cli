/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { AuthInfo, DeviceInfo, DevicePageResult } from './types';
import { debuglog } from 'node:util';
import { HttpResponse } from '../types/http';
import { httpClient } from '../utils/http-client';
import {
  SIGN_ERROR_MESSAGES,
  SignatureEndpoints,
  SignatureResponseSignals,
} from '../config/signature';

/**
 * 注册设备信息
 *
 * @param auth 用户权限信息
 * @param localDevices 本地设备信息
 */
export async function registerDevice(
  auth: AuthInfo,
  localDevices: DeviceInfo[]
): Promise<string[]> {
  const cloudDevices = await getDeviceList(auth);
  if (!cloudDevices) {
    throw new Error(SIGN_ERROR_MESSAGES.ERROR_WHILE_ADD_DEVICE);
  }

  if (cloudDevices.length === 0) {
    for (const device of localDevices) {
      await addSingleDevice(auth, device.udid, device.deviceName);
    }
  } else {
    for (const device of localDevices) {
      await batchAddDevice(auth, cloudDevices, device.udid, device.deviceName);
    }
  }

  const afterAddDevices = await getDeviceList(auth);
  const allDeviceIds = afterAddDevices.map((device) => device.id);

  if (allDeviceIds.length === 0) {
    throw new Error(SIGN_ERROR_MESSAGES.ERROR_WHILE_ADD_DEVICE);
  }
  return allDeviceIds;
}

async function addSingleDevice(auth:AuthInfo, udid: string, deviceName: string): Promise<void> {
  await addDevice(auth, udid, getDeviceType(deviceName));
}

async function batchAddDevice(
  auth: AuthInfo,
  deviceList: DeviceInfo[],
  udid: string,
  deviceName: string
): Promise<void> {
  for (let i = 0; i < deviceList.length; i++) {
    if (udid === deviceList[i].udid) {
      return;
    }
    if (i === deviceList.length - 1) {
      await addDevice(auth, udid, getDeviceType(deviceName));
      return;
    }
  }
  return;
}

function getDeviceType(deviceName: string): string {
  switch (deviceName) {
    case 'liteWearable':
      return '1';
    case 'wearable':
      return '2';
    case 'tv':
      return '3';
    case 'phone':
    default:
      return '4';
  }
}

async function getDevices(
  auth: AuthInfo,
  startPage = 1,
  pageSize = 100
): Promise<DevicePageResult | null> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.DEVICE_LIST_PATH}?encodeFlag=0&start=${startPage}&pageSize=${pageSize}`;
  const headers = buildHeaders(auth);
  const response: HttpResponse = await httpClient.get(url, { headers });

  if (!response) {
    debuglog('query devices: response is null');
    return null;
  }

  const data = JSON.parse(response.data);

  if (!data.list) {
    debuglog('query devices: list is null');
    return null;
  }

  return {
    deviceList: data.list,
    total: data.totalCount || 0,
  };
}

export async function getDeviceList(auth: AuthInfo): Promise<DeviceInfo[]> {
  const pageSize = 100;
  const firstPage = await getDevices(auth, 1, pageSize);

  if (!firstPage || !firstPage.deviceList || firstPage.deviceList.length === 0) {
    return [];
  }

  const allDevices = [...firstPage.deviceList];
  const totalCount = firstPage.total;
  const pages =
    Math.floor(totalCount / pageSize) + (totalCount % pageSize === 0 ? 0 : 1);

  for (let i = 2; i <= pages; i++) {
    const dto = await getDevices(auth, i, pageSize);
    if (!dto || !dto.deviceList || dto.deviceList.length === 0) {
      break;
    }
    allDevices.push(...dto.deviceList);
  }

  return allDevices;
}

async function addDevice(auth: AuthInfo, udid: string, deviceType: string): Promise<void> {
  const url = `${SignatureEndpoints.BASE_URL}${SignatureEndpoints.DEVICE_ADD_PATH}`;
  const headers = buildHeaders(auth);

  const deviceName = `auto_sign_device_No.${Math.floor(Math.random() * 3000)}${Date.now()}`;
  const body = {
    deviceName,
    udid,
    deviceType,
  };

  const response: HttpResponse = await httpClient.post(url, {
    headers,
    params: body,
  });
  if (!response) {
    throw new Error(SIGN_ERROR_MESSAGES.ERROR_WHILE_ADD_DEVICE);
  }

  const responseStr = JSON.stringify(response.data);

  if (
    responseStr.includes('[]') ||
    responseStr.includes(SignatureResponseSignals.SUCCESS_MARKER)
  ) {
    if (
      responseStr.includes(SignatureResponseSignals.DEVICE_EXCEEDS_LIMIT_CODE)
    ) {
      throw new Error(SIGN_ERROR_MESSAGES.DEVICE_LIMIT_REACHED);
    }

    if (
      responseStr.includes(SignatureResponseSignals.DEVICE_NAME_REPEAT_CODE)
    ) {
      throw new Error(SIGN_ERROR_MESSAGES.DEVICE_NAME_REPEAT);
    }

    throw new Error(SIGN_ERROR_MESSAGES.ERROR_WHILE_ADD_DEVICE);
  }
}

function buildHeaders(auth: AuthInfo): Record<string, string> {
  return {
    uid: auth.uid,
    teamId: auth.teamId,
    oauth2Token: auth.accessToken,
  };
}