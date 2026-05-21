/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * 应用配置常量
 */
export const AppConfig = {
  /** 配置目录名称 */
  CONFIG_DIR_NAME: '.config',

  /** 应用名称 */
  APP_NAME: 'deveco-cli',

  /** 密钥文件名 */
  KEY_FILE_NAME: 'token.dek',
} as const;

export const CryptoConstants = {
  /** 加密算法 */
  ALGORITHM: 'aes-256-gcm',

  /** KEK/DEK 密钥长度（字节） */
  KEY_LENGTH: 32,

  /** IV 长度（字节） */
  IV_LENGTH: 12,

  /** KEK 版本列表 */
  KEK_VERSIONS: ['kek-v1', 'kek-v2', 'kek-v3'] as const,
} as const;