/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { homedir } from 'os';
import { AppConfig, CryptoConstants } from '../auth-config.js';

interface WrappedDekData {
  version: number;
  algorithm: 'aes-256-gcm';
  kekId: string;
  encryptedDek: string; // Base64
  iv: string; // Base64
  authTag: string; // Base64
  timeStamp: number;
}

export interface EncryptedBlob {
  version: number;
  algorithm: 'aes-256-gcm';
  ciphertext: string; // Base64
  iv: string; // Base64
  authTag: string; // Base64
  timeStamp: number;
}

const algorithm = CryptoConstants.ALGORITHM;
const ivLength = CryptoConstants.IV_LENGTH;
const kekLength = CryptoConstants.KEY_LENGTH; // 256 bits
const dekLength = CryptoConstants.KEY_LENGTH;
const rootKeyIds = CryptoConstants.KEK_VERSIONS;

// 隔离存储
const configPath =
  process.env.DEVECO_CLI_DATA_DIR ||
  path.join(homedir(), AppConfig.CONFIG_DIR_NAME, AppConfig.APP_NAME);
const keyDirPath = path.join(
  homedir(),
  '.local',
  'share',
  AppConfig.APP_NAME,
  'keys'
);
const wrappedDekPath = path.join(configPath, AppConfig.KEY_FILE_NAME);

function getRootKeyPath(keyId: string): string {
  return path.join(keyDirPath, `${keyId}.bin`);
}

function ensureDirectories(): void {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configPath, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(keyDirPath)) {
    fs.mkdirSync(keyDirPath, { recursive: true, mode: 0o700 });
  }
}

function ensureRootKeys(): void {
  ensureDirectories();
  for (const keyId of rootKeyIds) {
    const filePath = getRootKeyPath(keyId);
    if (fs.existsSync(filePath)) {
      continue;
    }
    fs.writeFileSync(filePath, crypto.randomBytes(kekLength), { mode: 0o600 });
  }
}

function loadRootKey(keyId: string): Buffer {
  ensureRootKeys();
  const filePath = getRootKeyPath(keyId);
  const key = fs.readFileSync(filePath);
  if (key.length === kekLength) {
    return key;
  }
  const next = crypto.randomBytes(kekLength);
  fs.writeFileSync(filePath, next, { mode: 0o600 });
  return next;
}

function wrapDekWithKek(dek: Buffer, kekId: string): WrappedDekData {
  const iv = crypto.randomBytes(ivLength);
  const kek = loadRootKey(kekId);
  const cipher = crypto.createCipheriv(algorithm, kek, iv) as crypto.CipherGCM;
  const encryptedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm,
    kekId,
    encryptedDek: encryptedDek.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    timeStamp: Date.now(),
  };
}

function unwrapDek(wrapped: WrappedDekData): Buffer {
  const kek = loadRootKey(wrapped.kekId);
  const iv = Buffer.from(wrapped.iv, 'base64');
  const authTag = Buffer.from(wrapped.authTag, 'base64');
  const encryptedDek = Buffer.from(wrapped.encryptedDek, 'base64');
  const decipher = crypto.createDecipheriv(
    algorithm,
    kek,
    iv
  ) as crypto.DecipherGCM;
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedDek), decipher.final()]);
}

function ensureWrappedDek(): void {
  ensureRootKeys();
  if (fs.existsSync(wrappedDekPath)) {
    return;
  }
  const dek = crypto.randomBytes(dekLength);
  const wrapped = wrapDekWithKek(dek, rootKeyIds[0]);
  fs.writeFileSync(wrappedDekPath, JSON.stringify(wrapped, null, 2), {
    mode: 0o600,
  });
}

function loadDek(): Buffer {
  ensureWrappedDek();
  const wrapped = JSON.parse(
    fs.readFileSync(wrappedDekPath, 'utf8')
  ) as WrappedDekData;
  const dek = unwrapDek(wrapped);
  if (dek.length === dekLength) {
    return dek;
  }
  const next = crypto.randomBytes(dekLength);
  const nextWrapped = wrapDekWithKek(next, rootKeyIds[0]);
  fs.writeFileSync(wrappedDekPath, JSON.stringify(nextWrapped, null, 2), {
    mode: 0o600,
  });
  return next;
}

function rebuildKeyMaterials(): void {
  ensureDirectories();
  for (const keyId of rootKeyIds) {
    const filePath = getRootKeyPath(keyId);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, crypto.randomBytes(kekLength), {
        mode: 0o600,
      });
    }
  }
  if (fs.existsSync(wrappedDekPath)) {
    return;
  }
  const dek = crypto.randomBytes(dekLength);
  const wrapped = wrapDekWithKek(dek, rootKeyIds[0]);
  fs.writeFileSync(wrappedDekPath, JSON.stringify(wrapped, null, 2), {
    mode: 0o600,
  });
}

export function encryptForLocalStorage(plaintext: string): EncryptedBlob {
  const dek = loadDek();
  const iv = crypto.randomBytes(ivLength);
  const cipher = crypto.createCipheriv(algorithm, dek, iv) as crypto.CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    timeStamp: Date.now(),
  };
}

export function decryptForLocalStorage(blob: EncryptedBlob): string {
  try {
    const dek = loadDek();
    const iv = Buffer.from(blob.iv, 'base64');
    const authTag = Buffer.from(blob.authTag, 'base64');
    const ciphertext = Buffer.from(blob.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv(
      algorithm,
      dek,
      iv
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    rebuildKeyMaterials();
    throw new Error('Failed to decrypt local ciphertext');
  }
}

export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<EncryptedBlob>;
  return (
    candidate.algorithm === 'aes-256-gcm' &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.authTag === 'string'
  );
}

export * as LocalCrypto from './local-crypto.js';
