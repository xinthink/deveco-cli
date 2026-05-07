/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import * as crypto from 'crypto';
import { CryptoConstants, AppConfig } from '../config/constants';

/**
 * Token 存储类
 * 使用 AES-128-GCM 加密算法安全存储 Token
 *
 */
export class TokenStorage {
  private keyFilePath: string;
  private tokenFilePath: string;

  constructor(configDir?: string) {
    const configPath =
      configDir ||
      path.join(homedir(), AppConfig.CONFIG_DIR_NAME, AppConfig.APP_NAME);
    this.keyFilePath = path.join(configPath, AppConfig.KEY_FILE_NAME);
    this.tokenFilePath = path.join(configPath, AppConfig.TOKEN_FILE_NAME);
  }

  /**
   * 获取或创建加密密钥
   * 如果密钥文件不存在，则生成新密钥并保存
   */
  private getKey(): Buffer {
    try {
      return fs.readFileSync(this.keyFilePath);
    } catch {
      const key = crypto.randomBytes(CryptoConstants.KEY_LENGTH);
      this.ensureConfigDir();
      fs.writeFileSync(this.keyFilePath, key, { mode: 0o600 });
      return key;
    }
  }

  /**
   * 确保配置目录存在
   */
  private ensureConfigDir(): void {
    const dir = path.dirname(this.keyFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * 加密明文
   * @param plaintext 要加密的明文
   * @returns 加密结果（包含密文、IV 和认证标签）
   */
  private encrypt(plaintext: string): {
    encrypted: string;
    iv: string;
    authTag: string;
  } {
    const key = this.getKey();
    const iv = crypto.randomBytes(CryptoConstants.IV_LENGTH);
    const cipher = crypto.createCipheriv(
      CryptoConstants.ALGORITHM,
      key,
      iv
    ) as crypto.CipherGCM;

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };
  }

  /**
   * 解密密文
   * @param encrypted 密文
   * @param ivHex IV（十六进制）
   * @param authTagHex 认证标签（十六进制）
   * @returns 解密后的明文
   */
  private decrypt(
    encrypted: string,
    ivHex: string,
    authTagHex: string
  ): string {
    const key = this.getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(
      CryptoConstants.ALGORITHM,
      key,
      iv
    ) as crypto.DecipherGCM;

    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * 保存 Token 到磁盘
   * @param token JWT Token 字符串
   */
  public async saveJwtToken(token: string): Promise<void> {
    if (!token) {
      throw new Error('Token is empty');
    }

    const { encrypted, iv, authTag } = this.encrypt(token);
    const tokenData = {
      encrypted,
      iv,
      authTag,
      timeStamp: Date.now(),
    };

    this.ensureConfigDir();
    fs.writeFileSync(this.tokenFilePath, JSON.stringify(tokenData, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * 从磁盘加载 Token
   * @returns JWT Token 字符串，如果不存在或解密失败则返回 null
   */
  public async loadJwtToken(): Promise<string | null> {
    try {
      if (!fs.existsSync(this.tokenFilePath)) {
        return null;
      }

      const tokenData = JSON.parse(fs.readFileSync(this.tokenFilePath, 'utf8'));
      const { encrypted, iv, authTag } = tokenData;
      return this.decrypt(encrypted, iv, authTag);
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
