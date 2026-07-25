/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { LocalCrypto } from '../utils/local-crypto.js';
import { AppConfig } from '../auth-config';

export type TokenSource = 'deveco-cli' | 'deveco-code';

export interface ResolvedJwtToken {
  token: string;
  source: TokenSource;
}

export class TokenStorage {
  private tokenFilePath: string;

  constructor(configDir?: string) {
    const configPath =
      configDir ||
      process.env.DEVECO_CLI_DATA_DIR ||
      path.join(homedir(), AppConfig.CONFIG_DIR_NAME, AppConfig.APP_NAME);
    this.tokenFilePath = path.join(configPath, AppConfig.TOKEN_FILE_NAME);
  }

  /**
   * 确保配置目录存在
   */
  private ensureConfigDir(): void {
    const dir = path.dirname(this.tokenFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * 保存 JWT Token 到磁盘
   * 使用 LocalCrypto 加密后存储
   */
  public async saveJwtToken(token: string): Promise<void> {
    if (!token) {
      throw new Error('Token is empty');
    }

    const tokenData = LocalCrypto.encryptForLocalStorage(token);
    this.ensureConfigDir();
    fs.writeFileSync(this.tokenFilePath, JSON.stringify(tokenData, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * 从磁盘加载 JWT Token
   * 优先读取 deveco-code 注入的登录态，再回退到 CLI 自身存储。
   */
  public async loadJwtToken(): Promise<string | null> {
    return (await this.resolveJwtToken())?.token ?? null;
  }

  public async resolveJwtToken(): Promise<ResolvedJwtToken | null> {
    const devecoCodeToken = this.loadDevecoCodeToken();
    if (devecoCodeToken) {
      return { token: devecoCodeToken, source: 'deveco-code' };
    }

    const localToken = await this.loadLocalJwtToken();
    return localToken ? { token: localToken, source: 'deveco-cli' } : null;
  }

  private loadDevecoCodeToken(): string | null {
    if (process.env.DEVECO_CLI_AUTH_SOURCE !== 'deveco-code') {
      return null;
    }
    const configDir = process.env.DEVECO_CODE_AUTH_DIR?.trim();
    if (!configDir) {
      return null;
    }

    try {
      const tokenFilePath = path.join(configDir, AppConfig.TOKEN_FILE_NAME);
      if (!fs.existsSync(tokenFilePath)) {
        return null;
      }
      const tokenData: unknown = JSON.parse(
        fs.readFileSync(tokenFilePath, 'utf8')
      );
      if (!LocalCrypto.isEncryptedBlob(tokenData)) {
        return null;
      }
      return LocalCrypto.decryptForLocalStorageFromDirectory(
        tokenData,
        configDir
      );
    } catch {
      return null;
    }
  }

  private async loadLocalJwtToken(): Promise<string | null> {
    try {
      if (!fs.existsSync(this.tokenFilePath)) {
        return null;
      }

      const tokenData = JSON.parse(fs.readFileSync(this.tokenFilePath, 'utf8'));
      if (!LocalCrypto.isEncryptedBlob(tokenData)) {
        return null;
      }
      return LocalCrypto.decryptForLocalStorage(tokenData);
    } catch {
      await this.clearToken();
      return null;
    }
  }

  /**
   * 清除存储的 Token
   */
  public async clearToken(): Promise<void> {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        fs.unlinkSync(this.tokenFilePath);
      }
    } catch (err) {
      throw new Error('Failed to clear token', { cause: err });
    }
  }
}

/** Token 存储单例实例 */
export const tokenStorage = new TokenStorage();
