/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 设备 ID 解析（对齐 codeGenie trace 上传接口的 device-token 算法）：
 * 取本机主 MAC 地址做 SHA-256 不可逆哈希，按 UUID v5 外观格式化。
 * 同机器每次解析结果一致，确定性生成，无需依赖落盘缓存。
 * MAC 不可用（无网卡等）时回退随机 UUIDv4 并落盘缓存。
 */
const DEVICE_ID_FILENAME = 'device-id';

function deviceFile(storageDir: string): string {
  return path.join(storageDir, DEVICE_ID_FILENAME);
}

/** 主 MAC 地址：所有非 internal、非零 MAC 归一化（去分隔符、小写）后去重排序取最小。 */
function primaryMacAddress(): string {
  const macs = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    if (!list) {
      continue;
    }
    for (const iface of list) {
      if (iface.internal) {
        continue;
      }
      const mac = (iface.mac ?? '').replace(/[:-\s]/g, '').toLowerCase();
      if (mac && mac !== '000000000000') {
        macs.add(mac);
      }
    }
  }
  return [...macs].sort()[0] ?? '';
}

/** SHA-256(mac) 前 128 位，置 version 5 / RFC 4122 variant 位后格式化为 UUID 字符串。 */
function macHashToDeviceId(mac: string): string {
  const hash = crypto.createHash('sha256').update(mac).digest();
  hash[6] = 0x50 | (hash[6] & 0x0f); // version 5
  hash[8] = 0x80 | (hash[8] & 0x3f); // variant RFC 4122
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 校验是否为合法 UUIDv4 字符串，避免读到脏文件后误用。 */
function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * 解析本机设备 ID：优先按主 MAC 哈希确定性生成；
 * 无可用 MAC 时回退随机 UUIDv4 并落盘缓存（卸载/重装不触碰用户数据目录，
 * 故 ID 在卸载前后保持一致；用户删除该文件或整个 storageDir 即可重置）。
 * 任何 fs 异常均被吞掉，返回进程内 ID——解析失败不影响主流程，下次进程重试。
 */
export function resolveDeviceId(storageDir: string): string {
  const mac = primaryMacAddress();
  if (mac) {
    return macHashToDeviceId(mac);
  }
  const file = deviceFile(storageDir);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (isValidUuid(existing)) {
      return existing;
    }
  } catch {
    // 文件缺失或不可读，继续生成
  }
  const id = crypto.randomUUID();
  try {
    fs.writeFileSync(file, id, 'utf8');
  } catch {
    // 写盘失败（只读 fs 等）不影响本次返回，下次进程会重新生成
  }
  return id;
}
