/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { AppConfig } from '../config/constants.js';

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

export function loadUiVerificationConfig(): UiVerificationConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as UiVerificationConfig;
  } catch {
    return null;
  }
}

export function saveUiVerificationConfig(partial: UiVerificationConfig): void {
  ensureConfigDir();
  const existing = loadUiVerificationConfig() ?? {};
  const merged: UiVerificationConfig = { ...existing };
  if (partial.baseUrl !== undefined) merged.baseUrl = partial.baseUrl;
  if (partial.modelName !== undefined) merged.modelName = partial.modelName;
  if (partial.apiKey !== undefined) merged.apiKey = partial.apiKey;
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify(merged, null, 2),
    { mode: 0o600 }
  );
  console.log(`UI verification config saved to ${getConfigPath()}`);
}
