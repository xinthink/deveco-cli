/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'node:crypto';

/**
 * 打点文件落盘加密：AES-256-GCM，每条事件一行一个密文 blob。
 * 密钥由设备 ID（device-id.ts，MAC 哈希 / 随机 UUID 落盘缓存）派生，
 * 不额外落盘密钥文件，本机任意进程可重算，跨进程解密（CLI 调度器 / 后台上传进程）一致。
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_SALT = 'deveco-cli-trace-file';

export interface TraceFileCipherBlob {
  version: 1;
  algorithm: 'aes-256-gcm';
  /** Base64 */
  ciphertext: string;
  /** Base64 */
  iv: string;
  /** Base64 */
  authTag: string;
}

export function createTraceFileKey(deviceId: string): Buffer {
  return crypto.createHash('sha256').update(KEY_SALT).update(deviceId).digest();
}

/** 加密单行明文事件，返回一行密文 blob 的 JSON 字符串。 */
export function encryptTraceLine(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const blob: TraceFileCipherBlob = {
    version: 1,
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
  return JSON.stringify(blob);
}

/**
 * 解密一行密文 blob，返回明文事件 JSON；无法解析/校验失败返回 null。
 * 非 blob 的历史明文行（加密改造前的调试期遗留）原样放行。
 */
export function decryptTraceLine(line: string, key: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isTraceFileCipherBlob(parsed)) {
    return line;
  }
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(parsed.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(parsed.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

function isTraceFileCipherBlob(value: unknown): value is TraceFileCipherBlob {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<TraceFileCipherBlob>;
  return (
    candidate.version === 1 &&
    candidate.algorithm === ALGORITHM &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.authTag === 'string'
  );
}
