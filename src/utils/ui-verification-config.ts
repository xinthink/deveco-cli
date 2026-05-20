/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { AppConfig } from '../config/constants.js';
import {
  encryptForLocalStorage,
  decryptForLocalStorage,
  isEncryptedBlob,
} from './local-crypto.js';

export interface UiVerificationConfig {
  baseUrl?: string;
  modelName?: string;
  apiKey?: string;
}

function getConfigPath(): string {
  return path.join(
    homedir(),
    AppConfig.CONFIG_DIR_NAME,
    AppConfig.APP_NAME,
    'ui_verification_config.json'
  );
}

function ensureConfigDir(): void {
  const dir = path.dirname(getConfigPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function loadRawConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadUiVerificationConfig(): UiVerificationConfig | null {
  const raw = loadRawConfig();
  if (Object.keys(raw).length === 0) {
    return null;
  }
  let apiKey: string | undefined;
  if (isEncryptedBlob(raw.encryptedApiKey)) {
    try {
      apiKey = decryptForLocalStorage(raw.encryptedApiKey);
    } catch {
      // 解密失败视为未配置
    }
  }

  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
    modelName: typeof raw.modelName === 'string' ? raw.modelName : undefined,
    apiKey,
  };
}

export function saveUiVerificationConfig(partial: UiVerificationConfig): void {
  ensureConfigDir();
  const raw = loadRawConfig();
  if (partial.baseUrl !== undefined) {
    raw.baseUrl = partial.baseUrl;
  }
  if (partial.modelName !== undefined) {
    raw.modelName = partial.modelName;
  }
  if (partial.apiKey !== undefined) {
    raw.encryptedApiKey = encryptForLocalStorage(partial.apiKey);
  }
  fs.writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2), { mode: 0o600 });
  console.log(`UI verification config saved to ${getConfigPath()}`);
}
